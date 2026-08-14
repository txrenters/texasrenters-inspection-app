import { z } from 'zod';

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().optional(),
    DIRECT_URL: z.string().optional(),
    DATABASE_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(10).default(5),
    DATABASE_POOL_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(60).default(10),
    DATABASE_WARMUP_ENABLED: z.enum(['true', 'false']).default('true'),
    SLOW_QUERY_WARNING_MS: z.coerce.number().int().positive().default(250),
    SLOW_REQUEST_WARNING_MS: z.coerce.number().int().positive().default(750),
    CACHE_ENABLED: z.enum(['true', 'false']).default('false'),
    CACHE_PROVIDER: z.literal('redis').default('redis'),
    REDIS_URL: z.string().optional(),
    REDIS_HOST: z.string().optional(),
    REDIS_PORT: z.coerce.number().int().positive().default(6379),
    REDIS_USERNAME: z.string().optional(),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_TLS: z.enum(['true', 'false']).default('false'),
    CACHE_KEY_PREFIX: z
      .string()
      .regex(/^[a-z0-9-]+$/i)
      .default('texasrenters'),
    CACHE_DEFAULT_TTL_SECONDS: z.coerce.number().int().positive().default(60),
    CACHE_TTL_JITTER_PERCENT: z.coerce.number().min(0).max(50).default(15),
    CACHE_SINGLE_FLIGHT_ENABLED: z.enum(['true', 'false']).default('true'),
    CACHE_METRICS_ENABLED: z.enum(['true', 'false']).default('true'),
    CACHE_FAIL_OPEN: z.enum(['true', 'false']).default('true'),
    CACHE_MAX_VALUE_BYTES: z.coerce.number().int().min(1024).default(262144),
    HTTP_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    CORS_ALLOWED_ORIGINS: z
      .string()
      .default(
        'http://localhost:3001,http://localhost:5454,http://localhost:8081,http://localhost:19006',
      ),
    CORS_ORIGINS: z.string().optional(),
    MOBILE_APP_ORIGIN: z.string().url().optional(),
    WEB_APP_ORIGIN: z.string().url().optional(),
    MICROSOFT_GRAPH_TENANT_ID: z.string().optional(),
    MICROSOFT_GRAPH_CLIENT_ID: z.string().optional(),
    MICROSOFT_GRAPH_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_GRAPH_BASE_URL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().url().default('https://graph.microsoft.com'),
    ),
    MAIL_FROM_ADDRESS: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().email().optional(),
    ),
    MAIL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
    // Token identity. AUTH_JWT_SECRET signs and verifies every access token and
    // is now required unconditionally: USE_MOCK_AUTH is gone, so there is no
    // configuration in which the application authenticates without it.
    // AUTH_IDENTITY_PROVIDER is gone: there is one credential store now.
    AUTH_JWT_ISSUER: z.string().optional(),
    AUTH_JWT_AUDIENCE: z.string().optional(),
    AUTH_JWT_SECRET: z.string().optional(),
    AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
    AUTH_REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    AUTH_PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
    // Turns off per-query tenant scoping AND relaxes the RLS policies with it,
    // so it degrades rather than locking the application out.
    RLS_TENANT_SCOPE_ENABLED: z.enum(['true', 'false']).default('true'),
    // 'mock' is gone from this list. It returned a fixed eleven-room house —
    // entryway, kitchen, two-storey, garage — for whatever plan was uploaded,
    // which reads as a successful extraction and is wrong for every property.
    // 'disabled' is the honest way to not extract.
    FLOOR_PLAN_EXTRACTION_PROVIDER: z.enum(['disabled', 'anthropic', 'openai']).default('disabled'),
    ANTHROPIC_FLOOR_PLAN_MODEL: z.string().optional(),
    OPENAI_FLOOR_PLAN_MODEL: z.string().optional(),
    AI_CREDENTIALS_ENCRYPTION_KEY: z.string().optional(),
    // VIDEO_PLATFORM_PROVIDER, TRANSCRIPTION_PROVIDER and AI_ANALYSIS_PROVIDER
    // are gone. Each was z.literal('mock') — a setting that accepted exactly one
    // value, read by nothing, while the real routing came from AiProviderSettings
    // in the database. Their presence in .env.local made the stack look
    // mock-backed when it was not, and cost an evening of misdiagnosis.
    JOB_QUEUE_PROVIDER: z.literal('memory').default('memory'),
    // Validated so a typo cannot silently fall back to `local`, which is the
    // container's ephemeral disk and loses every upload on redeploy.
    FLOOR_PLAN_STORAGE_PROVIDER: z.enum(['local', 'r2']).default('local'),
    FLOOR_PLAN_STORAGE_BUCKET: z.string().default('floor-plans'),
    INSPECTION_MEDIA_STORAGE_PROVIDER: z.enum(['local', 'r2']).default('local'),
    INSPECTION_MEDIA_STORAGE_BUCKET: z.string().default('inspection-media'),
    WEBHOOK_SIGNING_SECRET: z.string().optional(),
    // Cloudflare R2 (S3-compatible). Required only when a provider is set to r2.
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    // Cloudflare Stream. Backend-only, every one of them: the API token can
    // create and delete video in the account, and the signing key mints
    // playback credentials for any inspection. None of these may ever reach a
    // client bundle — see the EXPO_PUBLIC_/NEXT_PUBLIC_ prefixes, which ship
    // whatever they are given to every device.
    CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
    CLOUDFLARE_STREAM_API_TOKEN: z.string().optional(),
    // Verifies that a webhook really came from Cloudflare. Without it the
    // "video is ready" endpoint would accept anyone's word for it.
    CLOUDFLARE_STREAM_WEBHOOK_SECRET: z.string().optional(),
    // The `customer-<code>` subdomain that serves manifests for this account.
    CLOUDFLARE_STREAM_CUSTOMER_CODE: z.string().optional(),
    // Signed playback. Required whenever videos are created with
    // requireSignedURLs, which is the default here — inspection video is
    // evidence about someone's home and must not be publicly addressable.
    CLOUDFLARE_STREAM_SIGNING_KEY_ID: z.string().optional(),
    CLOUDFLARE_STREAM_SIGNING_KEY_PEM: z.string().optional(),
    PROPERTYWARE_PROVIDER: z.enum(['mock', 'live']).default('mock'),
    PROPERTYWARE_STORE: z.enum(['memory', 'prisma']).default('memory'),
    PROPERTYWARE_BASE_URL: z
      .string()
      .url()
      .startsWith('https://')
      .default('https://api.propertyware.com/pw/api/rest/v1'),
    PROPERTYWARE_CLIENT_ID: z.string().optional(),
    PROPERTYWARE_CLIENT_SECRET: z.string().optional(),
    PROPERTYWARE_ORGANIZATION_ID: z.string().optional(),
    // Internal organization (UUID) that scheduled syncs run for.
    PROPERTYWARE_LOCAL_ORGANIZATION_ID: z.string().uuid().optional(),
    PROPERTYWARE_PORTFOLIO_REPORT_URL: z.string().url().optional(),
    PROPERTYWARE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    PROPERTYWARE_PAGE_SIZE: z.coerce.number().int().min(1).max(500).default(500),
    PROPERTYWARE_MAX_RETRIES: z.coerce.number().int().min(1).max(8).default(4),
    PROPERTYWARE_SYNC_ENABLED: z.enum(['true', 'false']).default('false'),
    PROPERTYWARE_INCREMENTAL_SYNC_CRON: z.string().optional(),
    PROPERTYWARE_RECONCILIATION_CRON: z.string().optional(),
    PROPERTYWARE_INITIAL_SYNC_LOOKBACK_DAYS: z.coerce.number().int().positive().default(30),
    PROPERTYWARE_CURSOR_OVERLAP_SECONDS: z.coerce.number().int().positive().default(120),
    PROPERTYWARE_DATABASE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(4),
    PROPERTYWARE_DATABASE_BATCH_SIZE: z.coerce.number().int().min(10).max(250).default(50),
  })
  .superRefine((config, context) => {
    if (config.NODE_ENV !== 'test' && !config.DATABASE_URL)
      context.addIssue({
        code: 'custom',
        message: 'DATABASE_URL is required for the persistent backend process.',
        path: ['DATABASE_URL'],
      });
    if (config.CACHE_ENABLED === 'true' && !config.REDIS_URL && !config.REDIS_HOST)
      context.addIssue({
        code: 'custom',
        message: 'REDIS_URL or REDIS_HOST is required when caching is enabled.',
        path: ['CACHE_ENABLED'],
      });
    if (
      config.NODE_ENV === 'production' &&
      (config.CORS_ALLOWED_ORIGINS.includes('*') || config.CORS_ORIGINS?.includes('*'))
    )
      context.addIssue({
        code: 'custom',
        message: 'Credentialed production CORS must use explicit origins.',
        path: ['CORS_ALLOWED_ORIGINS'],
      });
    // Was "Supabase URL and JWT secret are required". The signing key is ours
    // now, and it is the one value without which nothing can sign in: no token
    // can be minted and none can be verified.
    if (!config.AUTH_JWT_SECRET)
      context.addIssue({
        code: 'custom',
        message: 'AUTH_JWT_SECRET is required.',
        path: ['AUTH_JWT_SECRET'],
      });
    if (
      config.PROPERTYWARE_PROVIDER === 'live' &&
      (!config.PROPERTYWARE_CLIENT_ID ||
        !config.PROPERTYWARE_CLIENT_SECRET ||
        !config.PROPERTYWARE_ORGANIZATION_ID)
    )
      context.addIssue({
        code: 'custom',
        message: 'Propertyware live mode requires all three backend credentials.',
        path: ['PROPERTYWARE_PROVIDER'],
      });
  });

export function validateEnvironment(config: Record<string, unknown>) {
  return { ...config, ...environmentSchema.parse(config) };
}
