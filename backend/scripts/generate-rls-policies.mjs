#!/usr/bin/env node
/**
 * Generate the tenant-isolation policies from the live foreign-key graph.
 *
 * Phase 3c of docs/migration/SUPABASE_TO_SELF_HOSTED.md. Derived rather than
 * hand-written: 52 models, 22 of them tenant-scoped only through a chain of up
 * to three relations. Transcribing those by hand is how a table quietly ends up
 * with no policy, and a missing policy is invisible — the table simply stays
 * readable by everyone.
 *
 * Classification, entirely from the database:
 *
 *   direct      the table has an `organizationId` column
 *   transitive  a shortest path of foreign keys reaches one that does
 *   root        `Organization` itself, matched on `id`
 *   global      no path exists — reported, never silently skipped
 *
 * Prints SQL. It writes nothing; review the output, then apply it as a
 * migration like any other.
 *
 *   node --env-file=.env.local scripts/generate-rls-policies.mjs          # summary
 *   node --env-file=.env.local scripts/generate-rls-policies.mjs --sql    # migration
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
process.on('uncaughtException', (error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

const EMIT_SQL = process.argv.includes('--sql');
const CONTAINER = process.env.POSTGRES_CONTAINER ?? 'texasrenters-postgres-1';
const URL_ = (process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '').trim();
if (!URL_) {
  console.error('Set DIRECT_URL or DATABASE_URL.');
  process.exit(1);
}

async function psql(sql) {
  try {
    const { stdout } = await run(
      'docker',
      [
        'exec',
        '-e',
        `U=${URL_}`,
        CONTAINER,
        'sh',
        '-c',
        `psql "$U" -tA -F'|' -v ON_ERROR_STOP=on <<'EOSQL'\n${sql}\nEOSQL`,
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout.trim().split('\n').filter(Boolean);
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(
      `psql failed${stderr ? `:\n${stderr.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '<redacted>')}` : '.'}`,
    );
  }
}

const tables = (await psql(`select tablename from pg_tables where schemaname='public' order by 1`)).map(
  (line) => line.trim(),
);

const withOrgColumn = new Set(
  (
    await psql(`
      select table_name from information_schema.columns
      where table_schema='public' and column_name='organizationId'
      order by 1`)
  ).map((line) => line.trim()),
);

/**
 * Foreign keys as a child → [{column, parent, parentColumn}] map.
 *
 * Composite keys are skipped: none of the tenant paths use one, and a partial
 * join predicate would silently widen a policy rather than fail.
 */
const edges = new Map();
// `a.attnotnull` matters more than it looks. PropertyArea has two one-hop
// routes — propertyId (NOT NULL) to Property, and unitId (NULLABLE) to
// propertyware_units — and the first search picked the nullable one. A policy
// built on it would make every building-level area, where unitId is null, fail
// its own EXISTS and vanish from its own tenant. A nullable foreign key cannot
// carry tenancy, so nullable edges are not traversed at all.
for (const line of await psql(`
  select c.conrelid::regclass::text,
         a.attname,
         c.confrelid::regclass::text,
         af.attname
  from pg_constraint c
  join pg_namespace n on n.oid = c.connamespace
  join unnest(c.conkey) with ordinality as k(attnum, ord) on true
  join unnest(c.confkey) with ordinality as fk(attnum, ord) on fk.ord = k.ord
  join pg_attribute a  on a.attrelid = c.conrelid  and a.attnum = k.attnum
  join pg_attribute af on af.attrelid = c.confrelid and af.attnum = fk.attnum
  where n.nspname='public' and c.contype='f' and array_length(c.conkey,1) = 1
    and a.attnotnull
  order by 1`)) {
  const [child, column, parent, parentColumn] = line.split('|').map((v) => v.replace(/"/g, '').trim());
  if (!edges.has(child)) edges.set(child, []);
  edges.get(child).push({ column, parent, parentColumn });
}

/** Shortest FK path from `table` to something carrying organizationId. */
function pathToTenant(table) {
  const queue = [[table, []]];
  const seen = new Set([table]);
  while (queue.length) {
    const [current, path] = queue.shift();
    for (const edge of edges.get(current) ?? []) {
      if (seen.has(edge.parent)) continue;
      const next = [...path, { from: current, ...edge }];
      if (withOrgColumn.has(edge.parent) || edge.parent === 'Organization') return next;
      seen.add(edge.parent);
      queue.push([edge.parent, next]);
    }
  }
  return null;
}

/**
 * The predicate every policy shares.
 *
 * **Fails closed.** An unset tenant matches nothing: `current_setting(...)`
 * returns NULL, and every comparison against NULL is NULL, which is not true.
 * Forgetting to establish a tenant therefore returns no rows rather than every
 * row — the failure is loud and local instead of a silent grant.
 *
 * `'*'` is the explicit system escape hatch, for the handful of paths that
 * genuinely have no organization: boot-time recovery sweeps, the Cloudflare
 * Stream webhook, public homeowner report links before the share resolves, and
 * account lookup by email before any organization is known. Each is a named
 * `withSystemTenant()` call in the application, so they are greppable rather
 * than being the absence of a call.
 *
 * An earlier revision let an unset tenant pass, which kept those paths working
 * without naming them — and meant any request that never reached the
 * interceptor was unrestricted.
 */
const SYSTEM = `current_setting('app.organization_id', true) = '*'`;

const direct = (column) =>
  `${SYSTEM}\n        or ${column}::text = current_setting('app.organization_id', true)`;

function transitive(path) {
  // Nested EXISTS, one per hop, innermost carrying the tenant comparison.
  let inner = `p${path.length - 1}."organizationId"::text = current_setting('app.organization_id', true)`;
  if (path[path.length - 1].parent === 'Organization')
    inner = `p${path.length - 1}."id"::text = current_setting('app.organization_id', true)`;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const hop = path[i];
    const child = i === 0 ? `"${hop.from}"` : `p${i - 1}`;
    inner =
      `exists (select 1 from "${hop.parent}" p${i}\n` +
      `          where p${i}."${hop.parentColumn}" = ${child}."${hop.column}"\n` +
      `            and ${inner})`;
  }
  return `${SYSTEM}\n        or ${inner}`;
}

const plan = { root: [], direct: [], transitive: [], global: [] };
for (const table of tables) {
  if (table === '_prisma_migrations') {
    plan.global.push({ table, why: 'migration metadata' });
  } else if (table === 'Organization') {
    plan.root.push({ table, predicate: direct('"id"') });
  } else if (withOrgColumn.has(table)) {
    plan.direct.push({ table, predicate: direct('"organizationId"') });
  } else {
    const path = pathToTenant(table);
    if (path)
      plan.transitive.push({
        table,
        hops: path.length,
        via: path.map((h) => h.parent).join(' -> '),
        predicate: transitive(path),
      });
    else plan.global.push({ table, why: 'no foreign-key path to an organization' });
  }
}

if (!EMIT_SQL) {
  console.log(
    `${tables.length} tables: ${plan.root.length} root, ${plan.direct.length} direct, ` +
      `${plan.transitive.length} transitive, ${plan.global.length} global\n`,
  );
  console.table(plan.transitive.map(({ table, hops, via }) => ({ table, hops, via })));
  console.log('\nGlobal — deliberately left without a policy:');
  console.table(plan.global);
  console.log('Re-run with --sql to emit the migration.');
  process.exit(0);
}

const sections = [
  ['The organization itself, matched on its own id.', plan.root],
  ['Tables carrying organizationId directly.', plan.direct],
  ['Tables reached through foreign keys.', plan.transitive],
];

console.log(`-- Tenant isolation policies. GENERATED by scripts/generate-rls-policies.mjs
-- from the live foreign-key graph; regenerate rather than editing by hand.
--
-- Defense in depth. Every application-level organizationId filter stays exactly
-- as it is; these only mean a filter that is ever missed returns nothing
-- instead of another tenant's rows.
--
-- FAILS CLOSED. An unset app.organization_id matches nothing, so forgetting to
-- establish a tenant returns no rows rather than every row. The literal '*' is
-- the explicit system escape hatch, used by the handful of paths that genuinely
-- have no organization — boot-time recovery sweeps, the Cloudflare Stream
-- webhook, public report links before the share resolves, and account lookup by
-- email. Each is a named withSystemTenant() call in the application.
--
-- ${plan.global.length} tables are deliberately unpoliced:
${plan.global.map((g) => `--   ${g.table} — ${g.why}`).join('\n')}
`);

for (const [heading, entries] of sections) {
  if (!entries.length) continue;
  console.log(`\n-- ${heading}`);
  for (const { table, predicate, via } of entries) {
    if (via) console.log(`\n-- ${table} -> ${via}`);
    console.log(`alter table "${table}" enable row level security;`);
    console.log(`drop policy if exists tenant_isolation on "${table}";`);
    console.log(`create policy tenant_isolation on "${table}"
  using (
        ${predicate}
  )
  with check (
        ${predicate}
  );`);
  }
}
