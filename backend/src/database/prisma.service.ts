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
import { currentTenant } from './tenant-context';

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

/**
 * Whether every query carries its organization onto the database session.
 *
 * On by default; RLS_TENANT_SCOPE_ENABLED=false turns it off. The escape hatch
 * exists because the mechanism is not free: measured on this database, a scoped
 * findMany costs 4.29 ms against 1.25 ms unscoped — the query becomes a
 * transaction, so one round trip becomes four. That is 3 ms per operation,
 * which is cheap next to a cellular round trip and not cheap inside a page that
 * issues a dozen queries.
 *
 * Turning it off does not disable the policies; it stops the tenant reaching
 * them, and the policies allow an unset tenant. So this trades the second wall
 * for latency, and leaves the application-level organizationId filters — which
 * were audited and found correct — as the only enforcement, exactly as before
 * Phase 3.
 */
function tenantScopeEnabled() {
  return process.env.RLS_TENANT_SCOPE_ENABLED?.trim().toLowerCase() !== 'false';
}

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
    // Registered BEFORE extending, deliberately. `$extends` returns a client
    // that forwards model calls and subclass members but does **not** expose
    // `$on`, so subscribing afterwards is impossible and query metrics would
    // silently stop. The listener attaches to the shared engine, so events keep
    // arriving through the extended client.
    this.$on('query', (event) => this.recordQuery(event));

    if (!tenantScopeEnabled()) return;

    // Returning an object from a constructor replaces `this`. Every service
    // injects PrismaService and calls `this.prisma.<model>.<op>()`, so this is
    // what lets ~20 services and several hundred call sites stay untouched
    // while every one of their queries becomes tenant-scoped.
    return this.$extends({
      query: {
        $allModels: {
          // An arrow function on purpose: it captures the constructor's `this`,
          // which is the UNEXTENDED client. That is the one that must open the
          // transaction — `this` inside a method here would not be the client
          // at all, and aliasing it to a local was the same thing said worse.
          $allOperations: async ({ args, query }) => {
            const organizationId = currentTenant();
            // No tenant is a normal state — boot sweeps, the Cloudflare
            // webhook, public report links, password reset, and the query that
            // resolves the organization itself all run without one. Those go
            // straight through, and the policies allow an unset tenant.
            if (!organizationId) return query(args);

            // The array form runs both statements on one connection inside one
            // transaction, which is what makes `set_config(..., true)` — local
            // to the transaction — reach this query and nothing after it. A
            // session-level SET would leak to whichever request borrowed the
            // connection next.
            const [, result] = await this.$transaction([
              this.$executeRaw`select set_config('app.organization_id', ${organizationId}, true)`,
              query(args),
            ]);
            return result as unknown;
          },
        },
      },
    }) as unknown as PrismaService;
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
