import { Inject, Injectable } from '@nestjs/common';

import { CacheMetricsService } from './cache-metrics.service';
import type { CacheResource } from './cache-policy';

@Injectable()
export class SingleFlightService {
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(@Inject(CacheMetricsService) private readonly metrics: CacheMetricsService) {}

  run<T>(key: string, resource: CacheResource, loader: () => Promise<T>): Promise<T> {
    const pending = this.pending.get(key);
    if (pending) {
      this.metrics.increment('singleFlightJoins', resource);
      return pending as Promise<T>;
    }
    const request = loader().finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }
}
