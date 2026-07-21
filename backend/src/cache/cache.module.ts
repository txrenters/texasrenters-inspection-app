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
  exports: [CacheService, CacheInvalidationService, CacheKeyService, CacheMetricsService],
})
export class CacheModule {}
