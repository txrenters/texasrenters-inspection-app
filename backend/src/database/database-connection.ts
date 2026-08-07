import { SYSTEM_TENANT, tenantScopeEnabled } from './tenant-context';

export interface DatabaseConnectionSummary {
  category: 'supabase-session-pooler' | 'supabase-transaction-pooler' | 'direct' | 'test';
  port: string;
  source: 'DATABASE_URL' | 'DIRECT_URL' | 'test';
}

export function preparePersistentDatabaseEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseConnectionSummary {
  const runtime = parseDatabaseUrl(environment.DATABASE_URL);
  if (!runtime) {
    if (environment.NODE_ENV === 'test') return { category: 'test', port: 'none', source: 'test' };
    throw new Error('DATABASE_URL must configure the persistent backend database connection.');
  }

  applyTenantScopeToConnection(runtime, environment);

  if (!isSupabaseSharedPooler(runtime)) {
    return { category: 'direct', port: runtime.port || '5432', source: 'DATABASE_URL' };
  }
  if ((runtime.port || '5432') === '5432') {
    environment.DATABASE_URL = withSupabasePoolLimits(runtime, environment).toString();
    return {
      category: 'supabase-session-pooler',
      port: '5432',
      source: 'DATABASE_URL',
    };
  }
  if (runtime.port === '6543') {
    runtime.searchParams.set('pgbouncer', 'true');
    environment.DATABASE_URL = withSupabasePoolLimits(runtime, environment).toString();
    return {
      category: 'supabase-transaction-pooler',
      port: '6543',
      source: 'DATABASE_URL',
    };
  }

  throw new Error(
    'Supabase DATABASE_URL must use the transaction pooler on port 6543 or the session pooler on port 5432.',
  );
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

function isSupabaseSharedPooler(value: URL) {
  return value.hostname.endsWith('.pooler.supabase.com');
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

function withSupabasePoolLimits(value: URL, environment: NodeJS.ProcessEnv) {
  const runtime = new URL(value);
  if (!runtime.searchParams.has('connection_limit'))
    runtime.searchParams.set(
      'connection_limit',
      boundedInteger(environment.DATABASE_CONNECTION_LIMIT, 5, 1, 10).toString(),
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
