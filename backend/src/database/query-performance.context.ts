import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';

interface QueryMetrics {
  count: number;
  durationMs: number;
  slowestMs: number;
}

@Injectable()
export class QueryPerformanceContext {
  private readonly storage = new AsyncLocalStorage<QueryMetrics>();
  private totalCount = 0;
  private totalDurationMs = 0;

  run<T>(operation: () => T) {
    return this.storage.run({ count: 0, durationMs: 0, slowestMs: 0 }, operation);
  }

  record(durationMs: number) {
    this.totalCount += 1;
    this.totalDurationMs += durationMs;
    const metrics = this.storage.getStore();
    if (!metrics) return;
    metrics.count += 1;
    metrics.durationMs += durationMs;
    metrics.slowestMs = Math.max(metrics.slowestMs, durationMs);
  }

  totals(): Readonly<Pick<QueryMetrics, 'count' | 'durationMs'>> {
    return { count: this.totalCount, durationMs: this.totalDurationMs };
  }

  snapshot(): Readonly<QueryMetrics> {
    const metrics = this.storage.getStore();
    return metrics ? { ...metrics } : { count: 0, durationMs: 0, slowestMs: 0 };
  }
}
