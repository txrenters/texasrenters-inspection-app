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
    super({ log: [{ emit: 'event', level: 'query' }] });
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
