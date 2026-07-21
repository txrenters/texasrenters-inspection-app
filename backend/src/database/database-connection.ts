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

  if (!isSupabaseSharedPooler(runtime)) {
    return { category: 'direct', port: runtime.port || '5432', source: 'DATABASE_URL' };
  }
  if ((runtime.port || '5432') === '5432') {
    return {
      category: 'supabase-session-pooler',
      port: '5432',
      source: 'DATABASE_URL',
    };
  }

  const administrative = parseDatabaseUrl(environment.DIRECT_URL);
  if (
    runtime.port === '6543' &&
    administrative &&
    isSupabaseSharedPooler(administrative) &&
    (administrative.port || '5432') === '5432' &&
    administrative.hostname === runtime.hostname
  ) {
    // The approved session URL already exists in the environment. Select it for this
    // persistent process without printing or rewriting either secret value.
    environment.DATABASE_URL = environment.DIRECT_URL;
    return { category: 'supabase-session-pooler', port: '5432', source: 'DIRECT_URL' };
  }

  throw new Error(
    'Persistent NestJS database traffic cannot use the Supabase transaction pooler on port 6543. Configure DATABASE_URL with the approved session pooler on port 5432.',
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
