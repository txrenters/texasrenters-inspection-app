import { performance } from 'node:perf_hooks';

import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';

import { QueryPerformanceContext } from '../database/query-performance.context';

@Injectable()
export class RequestPerformanceInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestPerformanceInterceptor.name);

  constructor(@Inject(QueryPerformanceContext) private readonly metrics: QueryPerformanceContext) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<Response>();
    const request = context
      .switchToHttp()
      .getRequest<{ method?: string; route?: { path?: string } }>();
    const startedAt = performance.now();
    const databaseAtStart = this.metrics.totals();

    return new Observable((subscriber) =>
      this.metrics.run(() => {
        const subscription = next.handle().subscribe({
          next: (value) => {
            const durationMs = round(performance.now() - startedAt);
            const contextualQuery = this.metrics.snapshot();
            const databaseAtEnd = this.metrics.totals();
            const isolatedInstrumentation =
              process.env.PERFORMANCE_INSTRUMENTATION === 'true' ||
              process.env.NODE_ENV !== 'production';
            const query =
              contextualQuery.count > 0
                ? contextualQuery
                : isolatedInstrumentation
                  ? {
                      count: databaseAtEnd.count - databaseAtStart.count,
                      durationMs: databaseAtEnd.durationMs - databaseAtStart.durationMs,
                      slowestMs: 0,
                    }
                  : contextualQuery;
            const serializationStartedAt = performance.now();
            const payloadBytes = serializedSize(value);
            const serializationDurationMs = round(performance.now() - serializationStartedAt);
            /**
             * A handler that took `@Res()` writes and ends the response itself,
             * so by the time this runs the headers are already on the wire.
             * Setting one then throws ERR_HTTP_HEADERS_SENT from inside this
             * rxjs `next` callback, where nothing catches it: the exception
             * filter tries to answer with a 500 body, hits the same error, and
             * the process exits. Every request for a photo on a shared report
             * took the whole API down that way — an unauthenticated link was a
             * denial of service on the entire backend.
             *
             * The measurements are still taken and still logged; only the
             * headers are skipped, because a response that has already left is
             * the one case where there is nowhere to put them.
             */
            if (!response.headersSent) {
              response.setHeader(
                'Server-Timing',
                `app;dur=${durationMs}, db;dur=${round(query.durationMs)};desc="${query.count} queries", serialize;dur=${serializationDurationMs}`,
              );
              response.setHeader('X-Database-Query-Count', String(query.count));
              response.setHeader('X-Response-Bytes', String(payloadBytes));
              response.setHeader('Cache-Control', 'private, no-store');
            }
            const threshold = Number(process.env.SLOW_REQUEST_WARNING_MS ?? 750);
            if (Number.isFinite(threshold) && durationMs >= threshold)
              this.logger.warn({
                event: 'slow_request',
                method: request.method,
                route: request.route?.path,
                durationMs,
                databaseDurationMs: round(query.durationMs),
                queryCount: query.count,
                serializationDurationMs,
                payloadBytes,
              });
            subscriber.next(value);
          },
          error: (error: unknown) => subscriber.error(error),
          complete: () => subscriber.complete(),
        });
        return () => subscription.unsubscribe();
      }),
    );
  }
}

function serializedSize(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
