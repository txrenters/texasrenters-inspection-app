import { performance } from 'node:perf_hooks';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';

import {
  preparePersistentDatabaseEnvironment,
  type DatabaseConnectionSummary,
} from './database-connection';
import { QueryPerformanceContext } from './query-performance.context';

type InstrumentedPrismaOptions = Prisma.PrismaClientOptions & {
  log: [{ emit: 'event'; level: 'query' }];
};

/**
 * The interactive-transaction budget for every `$transaction` in the app.
 *
 * Prisma defaults to five seconds, which assumes a database on the far side of
 * a fast local socket. This one is a remote pooler where a single statement
 * costs a few hundred milliseconds, so a handful of legitimate sequential
 * writes can exhaust the default on a slow connection.
 *
 * It does not fail as a timeout. Prisma closes the transaction underneath the
 * code still using it, and the *next* statement throws "Transaction not found
 * ... refers to an old closed transaction" — which reads like a pooling fault
 * and sends you looking in the wrong place. The work is rolled back and the
 * caller gets a bare 500. A technician adding a room they were standing in hit
 * exactly this once area creation grew from four statements to five.
 *
 * Set on the client rather than at each call site: there are more than thirty
 * of them, a per-site sweep silently misses new code, and the failure it causes
 * is both severe and hard to read. Any single call may still pass its own
 * options to `$transaction` to widen this further.
 *
 * Raised, not removed. A transaction still open after twenty seconds is a real
 * fault and should fail rather than hold a pooled connection indefinitely.
 */
export const TRANSACTION_DEFAULTS = { timeout: 20_000, maxWait: 10_000 } as const;

export interface DatabaseReadiness {
  ready: boolean;
  startupDurationMs: number | null;
  checkedAt: string | null;
  connection: DatabaseConnectionSummary;
}

@Injectable()
export class PrismaService
  extends PrismaClient<InstrumentedPrismaOptions>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly connectionSummary: DatabaseConnectionSummary;
  private startupDurationMs: number | null = null;
  private checkedAt: string | null = null;
  private ready = false;

  constructor(
    @Inject(QueryPerformanceContext) private readonly queryMetrics: QueryPerformanceContext,
  ) {
    const connectionSummary = preparePersistentDatabaseEnvironment();
    super({
      log: [{ emit: 'event', level: 'query' }],
      transactionOptions: TRANSACTION_DEFAULTS,
    });
    this.connectionSummary = connectionSummary;
    this.$on('query', (event) => this.recordQuery(event));
  }

  async onModuleInit() {
    if (process.env.NODE_ENV === 'test' && process.env.DATABASE_WARMUP_ENABLED !== 'true') {
      this.ready = true;
      this.checkedAt = new Date().toISOString();
      return;
    }
    const startedAt = performance.now();
    await this.$connect();
    await this.$queryRawUnsafe('SELECT 1');
    this.startupDurationMs = round(performance.now() - startedAt);
    this.checkedAt = new Date().toISOString();
    this.ready = true;
    this.logger.log({
      event: 'database_ready',
      durationMs: this.startupDurationMs,
      connectionCategory: this.connectionSummary.category,
      connectionPort: this.connectionSummary.port,
      connectionSource: this.connectionSummary.source,
    });
  }

  async onModuleDestroy() {
    this.ready = false;
    await this.$disconnect();
  }

  readiness(): DatabaseReadiness {
    return {
      ready: this.ready,
      startupDurationMs: this.startupDurationMs,
      checkedAt: this.checkedAt,
      connection: this.connectionSummary,
    };
  }

  private recordQuery(event: Prisma.QueryEvent) {
    this.queryMetrics.record(event.duration);
    const threshold = Number(process.env.SLOW_QUERY_WARNING_MS ?? 250);
    if (
      process.env.NODE_ENV !== 'production' &&
      Number.isFinite(threshold) &&
      event.duration >= threshold
    )
      this.logger.warn({ event: 'slow_database_query', durationMs: event.duration });
  }
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
