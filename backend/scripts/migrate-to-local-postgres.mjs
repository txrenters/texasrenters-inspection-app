#!/usr/bin/env node
/**
 * Copy the `public` schema from the hosted Supabase database into the
 * dockerized Postgres, then prove the copy is faithful.
 *
 * Phase 1 of docs/migration/SUPABASE_TO_SELF_HOSTED.md. This moves data only —
 * it changes no configuration and repoints nothing. Switching over is a
 * separate, deliberate edit to DATABASE_URL once the verification below passes.
 *
 * `pg_dump` and `psql` run **inside the Postgres container**, so no host
 * Postgres installation is required and the client version always matches the
 * server it was built against. The pipe lives inside the container too, which
 * keeps the dump off the host disk entirely — it is a database full of tenancy
 * data and there is no reason for a copy to outlive the transfer.
 *
 * Only `public` is copied. Supabase's `auth`, `storage`, `realtime`, `vault`
 * and `graphql` schemas belong to Supabase and are deliberately left behind;
 * `auth.users` is Phase 2's problem and needs different handling, because the
 * password hashes want migrating rather than dumping wholesale.
 *
 * Dry run by default. Nothing is written without `--confirm`, because the
 * target is whatever LOCAL_DATABASE_URL points at and that is not always the
 * throwaway container you think it is.
 *
 *   node scripts/migrate-to-local-postgres.mjs            # inspect + plan
 *   node scripts/migrate-to-local-postgres.mjs --confirm  # copy, then verify
 *   node scripts/migrate-to-local-postgres.mjs --verify   # compare only
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Any uncaught throw would otherwise print the stack, and Node puts the full
// command line on execFile errors. Nothing here needs a stack trace.
process.on('uncaughtException', (error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

const CONFIRM = process.argv.includes('--confirm');
const VERIFY_ONLY = process.argv.includes('--verify');
const CONTAINER = process.env.POSTGRES_CONTAINER ?? 'texasrenters-postgres-1';

/**
 * Strip the parameters Prisma understands and libpq does not.
 *
 * `?pgbouncer=true` makes psql exit with `invalid URI query parameter`, and
 * `connection_limit` / `pool_timeout` are injected at boot by
 * database-connection.ts for the same Prisma-only reason.
 */
function libpqUrl(raw) {
  const url = new URL(raw);
  for (const key of ['pgbouncer', 'connection_limit', 'pool_timeout', 'schema']) {
    url.searchParams.delete(key);
  }
  return url.toString();
}

/**
 * Prefer DIRECT_URL: it is the session pooler, and pg_dump needs a real session
 * to hold its snapshot open. DATABASE_URL points at the transaction pooler on
 * 6543, where a dump is not guaranteed to be consistent.
 */
const SOURCE_RAW = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
const SOURCE = SOURCE_RAW ? libpqUrl(SOURCE_RAW) : undefined;
const TARGET =
  process.env.LOCAL_DATABASE_URL ??
  // Inside the container, the server is on localhost. These defaults mirror
  // compose.yaml's POSTGRES_* defaults.
  `postgresql://${process.env.POSTGRES_USER ?? 'postgres'}:${
    process.env.POSTGRES_PASSWORD ?? 'postgres'
  }@127.0.0.1:5432/${process.env.POSTGRES_DB ?? 'texasrenters'}`;

if (!SOURCE) {
  console.error('Neither DIRECT_URL nor DATABASE_URL is set.');
  console.error('Run with: node --env-file=.env.local scripts/migrate-to-local-postgres.mjs');
  process.exit(1);
}

/** Never print a connection string: they carry the password. */
const describe = (url) => {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return '(unparseable)';
  }
};

/**
 * Run a command in the Postgres container with the two connection strings
 * supplied as environment variables.
 *
 * Passed as env rather than argv so neither URL lands in the container's
 * process list, where any other process could read it.
 */
async function inContainer(script) {
  try {
    const { stdout } = await run(
      'docker',
      ['exec', '-e', `SRC=${SOURCE}`, '-e', `DST=${TARGET}`, CONTAINER, 'sh', '-c', script],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    // Rethrown deliberately stripped. Node attaches the full argv to execFile
    // errors, and the two connection strings are passed as `-e` arguments — so
    // the default message prints both database passwords into whatever is
    // reading stdout. An earlier revision of this script did exactly that.
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    const failure = new Error(
      `Command failed inside ${CONTAINER}${stderr ? `:\n${redact(stderr)}` : '.'}`,
    );
    failure.exitCode = error?.code;
    throw failure;
  }
}

/**
 * Last line of defence for anything echoed back from psql, which quotes the
 * connection string in several of its own error messages.
 */
function redact(text) {
  return text.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '<connection string redacted>');
}

/**
 * Row counts for every table in `public`, as a name → count map.
 *
 * `count(*)` per table rather than the `reltuples` estimate in pg_class: an
 * estimate is only as fresh as the last ANALYZE, and "close enough" is not a
 * useful answer to "did every row arrive".
 */
/**
 * One statement, no nested quoting.
 *
 * The obvious approach — build a UNION of per-table counts, then run it — does
 * not survive the trip: `%I` quotes a mixed-case identifier as "WebhookEvent",
 * and those double quotes close the shell string the SQL is travelling in.
 * `query_to_xml` runs the count inside the server instead, so nothing but
 * digits comes back out, and the SQL goes in through a quoted heredoc where the
 * shell expands nothing at all.
 */
const COUNT_SQL = `
select c.relname,
       (xpath('/row/n/text()',
              query_to_xml(format('select count(*) as n from %I.%I', n.nspname, c.relname),
                           false, true, '')))[1]::text::bigint
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
order by 1;
`;

async function rowCounts(which) {
  const out = await inContainer(
    `psql "$${which}" -tA -F'|' -v ON_ERROR_STOP=on <<'EOSQL'\n${COUNT_SQL}\nEOSQL`,
  );
  return Object.fromEntries(
    out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [table, count] = line.split('|');
        return [table, Number(count)];
      }),
  );
}

/**
 * Structural objects, compared alongside the rows.
 *
 * Matching row counts prove the data arrived; they say nothing about whether
 * the indexes, foreign keys and defaults came with it. A restore that silently
 * dropped every foreign key would pass a row-count check and then let the
 * application write rows nothing can join.
 */
const SHAPE_SQL = `
select 'indexes', count(*)::bigint from pg_indexes where schemaname = 'public'
union all
select 'unique indexes', count(*)::bigint from pg_index i
  join pg_class c on c.oid = i.indexrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and i.indisunique
union all
select 'foreign keys', count(*)::bigint from pg_constraint c
  join pg_namespace n on n.oid = c.connamespace
  where n.nspname = 'public' and c.contype = 'f'
union all
select 'check constraints', count(*)::bigint from pg_constraint c
  join pg_namespace n on n.oid = c.connamespace
  where n.nspname = 'public' and c.contype = 'c'
union all
select 'sequences', count(*)::bigint from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'S'
order by 1;
`;

async function shape(which) {
  const out = await inContainer(
    `psql "$${which}" -tA -F'|' -v ON_ERROR_STOP=on <<'EOSQL'\n${SHAPE_SQL}\nEOSQL`,
  );
  return Object.fromEntries(
    out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, count] = line.split('|');
        return [name, Number(count)];
      }),
  );
}

function compare(source, target) {
  const names = [...new Set([...Object.keys(source), ...Object.keys(target)])].sort();
  const rows = [];
  let mismatches = 0;
  let copied = 0;
  for (const name of names) {
    const from = source[name];
    const to = target[name];
    const ok = from === to;
    if (!ok) mismatches += 1;
    if (from > 0) copied += from;
    // Only list tables that hold data or disagree; 30-odd empty tables of
    // "0 → 0 OK" buries the two lines that matter.
    if (from > 0 || to > 0 || !ok) {
      rows.push({
        table: name,
        source: from ?? '(absent)',
        target: to ?? '(absent)',
        status: ok ? 'ok' : 'MISMATCH',
      });
    }
  }
  return { rows, mismatches, copied, tables: names.length };
}

console.log(`source  ${describe(SOURCE)}`);
console.log(`target  ${describe(TARGET)}`);
console.log(`via     docker exec ${CONTAINER}\n`);

const before = await rowCounts('SRC');
const sourceTables = Object.keys(before).length;
const sourceRows = Object.values(before).reduce((sum, n) => sum + n, 0);
console.log(`Source holds ${sourceRows} rows across ${sourceTables} tables.`);

if (!sourceTables) {
  console.error('\nRefusing to continue: the source has no tables in `public`.');
  process.exit(1);
}

if (!CONFIRM && !VERIFY_ONLY) {
  const target = await rowCounts('DST');
  console.log(`Target holds ${Object.values(target).reduce((s, n) => s + n, 0)} rows across ${
    Object.keys(target).length
  } tables.`);
  console.log('\nDRY RUN — nothing was written.');
  console.log('The copy DROPS and recreates every object in the target `public` schema.');
  console.log('Re-run with --confirm to perform it.');
  process.exit(0);
}

if (CONFIRM) {
  console.log('\nCopying `public` …');
  // --clean --if-exists so a re-run is idempotent rather than colliding with
  // whatever a previous attempt left behind.
  // --no-owner/--no-privileges because the roles differ: Supabase's grants
  // reference `anon`, `authenticated` and `service_role`, none of which exist
  // on a plain image, and restoring them would fail every GRANT.
  // ON_ERROR_STOP so a failure halts here rather than leaving a half-copy that
  // the verification below would then have to catch.
  await inContainer(
    'pg_dump --schema=public --no-owner --no-privileges --clean --if-exists "$SRC" ' +
      '| psql --quiet --set ON_ERROR_STOP=on "$DST"',
  );
  console.log('Copy finished.');
}

console.log('\nVerifying row counts …\n');
const after = await rowCounts('DST');
const { rows, mismatches, copied, tables } = compare(before, after);
console.table(rows);

console.log('Verifying schema objects …\n');
const [sourceShape, targetShape] = [await shape('SRC'), await shape('DST')];
const shapeRows = Object.keys(sourceShape).map((name) => ({
  object: name,
  source: sourceShape[name],
  target: targetShape[name] ?? 0,
  status: sourceShape[name] === (targetShape[name] ?? 0) ? 'ok' : 'MISMATCH',
}));
console.table(shapeRows);
const shapeMismatches = shapeRows.filter((row) => row.status !== 'ok').length;

if (mismatches || shapeMismatches) {
  console.error(
    `\n${mismatches} table(s) and ${shapeMismatches} schema object group(s) disagree.` +
      '\nThe target is NOT a faithful copy.',
  );
  process.exit(1);
}

console.log(`\nEvery one of ${tables} tables matches (${copied} rows carrying data).`);
console.log('\nData is copied and verified. Nothing is repointed yet —');
console.log('switch DATABASE_URL deliberately, and keep Supabase alive until Phase 2 lands.');
