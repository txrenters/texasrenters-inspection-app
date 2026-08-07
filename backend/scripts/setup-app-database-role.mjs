#!/usr/bin/env node
/**
 * Create the least-privilege role the application connects as.
 *
 * Phase 3 of docs/migration/SUPABASE_TO_SELF_HOSTED.md, and the step everything
 * else in that phase depends on. Row Level Security is **inert** for a role that
 * owns the tables or holds BYPASSRLS, and it fails silently — the queries keep
 * working and it looks protected. Measured on this database before this script:
 * `rolsuper=t`, `rolbypassrls=t`, 56 of 56 tables owned by the connecting role.
 * Any policy written under that role would have done nothing.
 *
 * Two connections, which is what Prisma's `directUrl` already exists for:
 *
 *   DATABASE_URL  -> this role. Runtime. Subject to policies.
 *   DIRECT_URL    -> the owner. Migrations and introspection only.
 *
 * Roles are cluster-level rather than schema-level, so this is a script and not
 * a Prisma migration: a migration would be applied to whatever DATABASE_URL
 * names, which during this migration is still Supabase — the wrong cluster.
 *
 * Idempotent. Safe to re-run, including after adding tables.
 *
 *   APP_DATABASE_PASSWORD=... node --env-file=.env.local \
 *     scripts/setup-app-database-role.mjs --confirm
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

process.on('uncaughtException', (error) => {
  // execFile puts the whole command line on its errors, and this one carries a
  // password. Never let the default handler print it.
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

const CONFIRM = process.argv.includes('--confirm');
const CONTAINER = process.env.POSTGRES_CONTAINER ?? 'texasrenters-postgres-1';
const ROLE = process.env.APP_DATABASE_ROLE ?? 'texasrenters_app';
const PASSWORD = process.env.APP_DATABASE_PASSWORD;

/** The owner connection: DDL, and the only one that may create a role. */
const OWNER = (process.env.DIRECT_URL ?? process.env.LOCAL_DATABASE_URL ?? '').trim();

if (!OWNER) {
  console.error('Set DIRECT_URL (or LOCAL_DATABASE_URL) to an owner connection.');
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]*$/.test(ROLE)) {
  console.error('APP_DATABASE_ROLE must be a plain lower-case identifier.');
  process.exit(1);
}
if (CONFIRM && !PASSWORD) {
  console.error('Set APP_DATABASE_PASSWORD. It is never generated here, so it is never printed.');
  process.exit(1);
}

function describe(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return '(unparseable)';
  }
}

/**
 * Run SQL as the owner.
 *
 * The password reaches psql as a variable (`:'app_password'`), never as text
 * inside a statement — statements can end up in the server log, variables do
 * not. It is handed to the container through the environment rather than an
 * argument so it stays out of the host's process list.
 */
async function psql(sql) {
  try {
    const { stdout } = await run(
      'docker',
      [
        'exec',
        '-e',
        `OWNER=${OWNER}`,
        '-e',
        `APP_PASSWORD=${PASSWORD ?? ''}`,
        CONTAINER,
        'sh',
        '-c',
        `psql "$OWNER" -tA -F'|' -v ON_ERROR_STOP=on -v app_password="$APP_PASSWORD" <<'EOSQL'\n${sql}\nEOSQL`,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.trim();
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(
      `psql failed in ${CONTAINER}${
        stderr ? `:\n${stderr.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '<redacted>')}` : '.'
      }`,
    );
  }
}

/**
 * `NOBYPASSRLS` and `NOSUPERUSER` are the whole point; the rest is least
 * privilege. The role gets DML on every table and nothing else — no DDL, no
 * ownership — so it cannot drop a policy that constrains it.
 *
 * `ALTER DEFAULT PRIVILEGES` covers tables created later, or the next migration
 * silently produces a table the application cannot read.
 *
 * The password is passed through psql's own variable rather than interpolated
 * into the SQL, so it is never part of a statement that could be logged.
 */
const createSql = (roleExists) => `
${roleExists ? `alter role ${ROLE}` : `create role ${ROLE}`} login password :'app_password';

alter role ${ROLE} nosuperuser nobypassrls nocreatedb nocreaterole noreplication;

grant usage on schema public to ${ROLE};
grant select, insert, update, delete on all tables in schema public to ${ROLE};
grant usage, select on all sequences in schema public to ${ROLE};

alter default privileges in schema public
  grant select, insert, update, delete on tables to ${ROLE};
alter default privileges in schema public
  grant usage, select on sequences to ${ROLE};
`;

const VERIFY_SQL = `
select r.rolname,
       r.rolsuper,
       r.rolbypassrls,
       r.rolcreatedb,
       (select count(*) from pg_tables t
          where t.schemaname = 'public' and t.tableowner = r.rolname) as tables_owned,
       (select count(*) from information_schema.role_table_grants g
          where g.grantee = r.rolname and g.table_schema = 'public'
            and g.privilege_type = 'SELECT') as tables_readable,
       (select count(*) from pg_tables where schemaname = 'public') as tables_total
from pg_roles r where r.rolname = '${ROLE}';
`;

console.log(`owner    ${describe(OWNER)}`);
console.log(`role     ${ROLE}`);
console.log(`via      docker exec ${CONTAINER}\n`);

const existing = await psql(`select 1 from pg_roles where rolname = '${ROLE}';`);
console.log(existing ? `Role ${ROLE} already exists; privileges will be re-applied.` : `Role ${ROLE} does not exist yet.`);

if (!CONFIRM) {
  console.log('\nDRY RUN — nothing was changed.');
  console.log('Re-run with --confirm and APP_DATABASE_PASSWORD set.');
  process.exit(0);
}

await psql(createSql(Boolean(existing)));

console.log('\nRole configured. Verifying …\n');
const [row] = (await psql(VERIFY_SQL)).split('\n').filter(Boolean);
const [name, isSuper, bypasses, canCreateDb, owned, readable, total] = row.split('|');
console.table([
  { property: 'role', value: name },
  { property: 'superuser', value: isSuper, expected: 'f' },
  { property: 'bypasses RLS', value: bypasses, expected: 'f' },
  { property: 'can create db', value: canCreateDb, expected: 'f' },
  { property: 'tables owned', value: owned, expected: '0' },
  { property: 'tables readable', value: `${readable}/${total}`, expected: `${total}/${total}` },
]);

const failures = [];
if (isSuper !== 'f') failures.push('role is a superuser');
if (bypasses !== 'f') failures.push('role bypasses RLS');
if (owned !== '0') failures.push(`role owns ${owned} tables (owners bypass RLS unless FORCE)`);
if (readable !== total) failures.push(`role can read only ${readable} of ${total} tables`);

if (failures.length) {
  console.error(`\nNOT READY for policies:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}

console.log('\nReady for policies: this role cannot bypass them.');
console.log(`Point DATABASE_URL at ${ROLE}, and leave DIRECT_URL as the owner for migrations.`);
console.log(
  '\nNote: the owner connection still sees everything, and FORCE ROW LEVEL SECURITY\n' +
    'will not change that while the owner is a superuser — superuser bypass is\n' +
    'absolute. That is fine and expected: migrations need it. What matters is that\n' +
    'the runtime connection is this role, which cannot bypass anything.',
);
