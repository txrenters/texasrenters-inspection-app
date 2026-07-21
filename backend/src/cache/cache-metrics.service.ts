import { Inject, Injectable, Optional } from '@nestjs/common';

import { CACHE_CONFIG, type CacheConfig } from './cache.config';
import type { CacheResource } from './cache-policy';

type Metric =
  | 'hits'
  | 'misses'
  | 'databaseFallbacks'
  | 'sets'
  | 'deletes'
  | 'namespaceBumps'
  | 'invalidationFailures'
  | 'parseFailures'
  | 'valueTooLarge'
  | 'singleFlightJoins'
  | 'connectionFailures';

@Injectable()
export class CacheMetricsService {
  private readonly totals = new Map<string, number>();
  private redisOperations = 0;
  private redisDurationMs = 0;
  private readonly enabled: boolean;

  constructor(@Optional() @Inject(CACHE_CONFIG) config?: CacheConfig) {
    this.enabled = config?.metricsEnabled ?? true;
  }

  increment(metric: Metric, resource: CacheResource | 'connection' = 'connection') {
    if (!this.enabled) return;
    const key = `${resource}:${metric}`;
    this.totals.set(key, (this.totals.get(key) ?? 0) + 1);
  }

  observeRedis(durationMs: number) {
    if (!this.enabled) return;
    this.redisOperations += 1;
    this.redisDurationMs += durationMs;
  }

  snapshot() {
    const byResource: Record<string, Record<string, number>> = {};
    for (const [key, value] of this.totals) {
      const [resource, metric] = key.split(':');
      byResource[resource!] ??= {};
      byResource[resource!]![metric!] = value;
    }
    const hits = [...this.totals]
      .filter(([key]) => key.endsWith(':hits'))
      .reduce((sum, [, value]) => sum + value, 0);
    const misses = [...this.totals]
      .filter(([key]) => key.endsWith(':misses'))
      .reduce((sum, [, value]) => sum + value, 0);
    return {
      enabled: this.enabled,
      hits,
      misses,
      hitRatio: hits + misses === 0 ? 0 : Math.round((hits / (hits + misses)) * 10_000) / 10_000,
      redisOperations: this.redisOperations,
      averageRedisLatencyMs:
        this.redisOperations === 0
          ? 0
          : Math.round((this.redisDurationMs / this.redisOperations) * 100) / 100,
      byResource,
    };
  }
}
