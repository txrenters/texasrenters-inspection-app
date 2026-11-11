import { Global, Module } from '@nestjs/common';

import { CacheInvalidationService } from './cache-invalidation.service';
import { CacheKeyService } from './cache-key.service';
import { CacheMetricsService } from './cache-metrics.service';
import { CACHE_CONFIG, getCacheConfig } from './cache.config';
import { CacheService } from './cache.service';
import { RedisCacheConnection } from './redis-cache.connection';
import { SingleFlightService } from './single-flight.service';

@Global()
@Module({
  providers: [
    { provide: CACHE_CONFIG, useFactory: getCacheConfig },
    CacheKeyService,
    CacheMetricsService,
    SingleFlightService,
    RedisCacheConnection,
    CacheService,
    CacheInvalidationService,
  ],
  // RedisCacheConnection for the API-key rate limit (gateway/rate-limit.guard.ts),
  // which counts in Redis so every replica shares one count. It asks for the
  // connection as optional, so leaving it out of this list never failed: each
  // replica quietly counted alone, multiplying every client's limit by the
  // number of containers (found 2026-11-12).
  exports: [
    CacheService,
    CacheInvalidationService,
    CacheKeyService,
    CacheMetricsService,
    RedisCacheConnection,
  ],
})
export class CacheModule {}
