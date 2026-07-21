import type { RedisOptions } from 'ioredis';

export const CACHE_CONFIG = Symbol('CACHE_CONFIG');

export interface CacheConfig {
  enabled: boolean;
  provider: 'redis';
  keyPrefix: string;
  defaultTtlSeconds: number;
  jitterPercent: number;
  singleFlightEnabled: boolean;
  metricsEnabled: boolean;
  failOpen: boolean;
  maxValueBytes: number;
  redisUrl?: string;
  redisOptions: RedisOptions;
}

export function getCacheConfig(): CacheConfig {
  const redisUrl = process.env.REDIS_URL?.trim() || undefined;
  return {
    enabled: process.env.CACHE_ENABLED === 'true',
    provider: 'redis',
    keyPrefix: process.env.CACHE_KEY_PREFIX ?? 'texasrenters',
    defaultTtlSeconds: positiveNumber(process.env.CACHE_DEFAULT_TTL_SECONDS, 60),
    jitterPercent: boundedNumber(process.env.CACHE_TTL_JITTER_PERCENT, 15, 0, 50),
    singleFlightEnabled: process.env.CACHE_SINGLE_FLIGHT_ENABLED !== 'false',
    metricsEnabled: process.env.CACHE_METRICS_ENABLED !== 'false',
    failOpen: process.env.CACHE_FAIL_OPEN !== 'false',
    maxValueBytes: positiveNumber(process.env.CACHE_MAX_VALUE_BYTES, 262_144),
    redisUrl,
    redisOptions: {
      host: redisUrl ? undefined : process.env.REDIS_HOST,
      port: positiveNumber(process.env.REDIS_PORT, 6379),
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
      tls: process.env.REDIS_TLS === 'true' || redisUrl?.startsWith('rediss://') ? {} : undefined,
      lazyConnect: true,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (attempt) => (attempt > 3 ? null : Math.min(attempt * 200, 1_000)),
    },
  };
}

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function boundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}
