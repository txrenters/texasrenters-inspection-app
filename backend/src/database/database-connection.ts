import { SYSTEM_TENANT, tenantScopeEnabled } from './tenant-context';

export interface DatabaseConnectionSummary {
  category: 'direct' | 'test';
  port: string;
  source: 'DATABASE_URL' | 'test';
}

/**
 * Prepares the runtime database connection.
 *
 * This module used to be built around Supabase's shared poolers: it recognised
 * `*.pooler.supabase.com`, refused any port other than 6543 or 5432, set
 * `pgbouncer=true` for the transaction pooler, and reported which of the two
 * was in use. That whole taxonomy is gone with Supabase — every deployment now
 * runs its own Postgres.
 *
 * One behaviour is deliberately kept and widened. `connection_limit` and
 * `pool_timeout` were applied *only* to Supabase URLs, so on a self-hosted
 * database `DATABASE_CONNECTION_LIMIT` and `DATABASE_POOL_TIMEOUT_SECONDS`
 * were documented, settable, and silently ignored — which is exactly the pair
 * of knobs a VPS with a modest `max_connections` needs. They now apply to any
 * Postgres URL.
 */
export function preparePersistentDatabaseEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseConnectionSummary {
  const runtime = parseDatabaseUrl(environment.DATABASE_URL);
  if (!runtime) {
    if (environment.NODE_ENV === 'test') return { category: 'test', port: 'none', source: 'test' };
    throw new Error('DATABASE_URL must configure the persistent backend database connection.');
  }

  applyTenantScopeToConnection(runtime, environment);
  environment.DATABASE_URL = withPoolLimits(runtime, environment).toString();

  return { category: 'direct', port: runtime.port || '5432', source: 'DATABASE_URL' };
}

function parseDatabaseUrl(value?: string) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * With tenant scoping disabled, pin the system tenant onto the connection.
 *
 * The policies fail closed, so simply not setting `app.organization_id` would
 * leave every query matching nothing — the switch would take the application
 * down rather than relax it. `libpq`'s `options` parameter sets the GUC once
 * when the connection opens, so the policies pass and there is no per-query
 * transaction to pay for. Verified against the database: without it a policed
 * table reads 0 rows, with it the same query reads all of them.
 *
 * Leaking `'*'` between requests on a pooled connection is harmless here and
 * only here: with scoping off there is no per-tenant value that could leak in
 * its place. When scoping is on this is not applied, and the per-query
 * `SET LOCAL` remains the only thing that sets the tenant.
 *
 * An existing `options` value is left alone rather than merged — a deployment
 * that set one deliberately should not have it silently rewritten, and the
 * startup log records which branch was taken.
 */
function applyTenantScopeToConnection(runtime: URL, environment: NodeJS.ProcessEnv) {
  if (tenantScopeEnabled(environment)) return;
  if (runtime.searchParams.has('options')) return;
  runtime.searchParams.set('options', `-c app.organization_id=${SYSTEM_TENANT}`);
  environment.DATABASE_URL = runtime.toString();
}

/**
 * An explicit value in the URL always wins. A deployment that wrote the limit
 * into its connection string said something more specific than the environment
 * default, and silently rewriting it is how a tuned production connection ends
 * up back on the fallback.
 */
function withPoolLimits(value: URL, environment: NodeJS.ProcessEnv) {
  const runtime = new URL(value);
  if (!runtime.searchParams.has('connection_limit'))
    runtime.searchParams.set(
      'connection_limit',
      boundedInteger(environment.DATABASE_CONNECTION_LIMIT, 5, 1, 50).toString(),
    );
  if (!runtime.searchParams.has('pool_timeout'))
    runtime.searchParams.set(
      'pool_timeout',
      boundedInteger(environment.DATABASE_POOL_TIMEOUT_SECONDS, 10, 1, 60).toString(),
    );
  return runtime;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
