import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../../common/prisma.service';
import { withSystemTenant, withTenant } from '../../database/tenant-context';
import type { PropertywareEntity } from '../../integrations/propertyware/propertyware.constants';
import type { SyncMode } from '../../integrations/propertyware/propertyware.types';
import { PropertywareSyncWorker } from './propertyware-sync.worker';

export interface EnqueuePropertywareSync {
  organizationId: string;
  requestedBy: string;
  entities: PropertywareEntity[];
  mode: SyncMode;
}

/**
 * How long a RUNNING run may go untouched before it is treated as abandoned.
 *
 * Comfortably longer than a full initial sync of every entity, so a legitimately
 * slow run is never reclaimed out from under itself.
 */
export const STALE_SYNC_RUN_AFTER_MS = 2 * 60 * 60 * 1000;

@Injectable()
export class PropertywareSyncCoordinator implements OnModuleInit {
  private readonly logger = new Logger(PropertywareSyncCoordinator.name);

  constructor(
    @Inject(PropertywareSyncWorker) private readonly worker: PropertywareSyncWorker,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /**
   * Closes runs whose process died mid-sync.
   *
   * Nothing else ever marks an interrupted run finished, and a run left RUNNING
   * makes the worker cancel every subsequent one — returning CANCELLED with no
   * entities, which from the outside reads as a clean exit. A deploy, a crash,
   * or an operator interrupting a sync therefore blocked every future sync
   * until somebody edited the row by hand, and the only symptom was a
   * successful-looking exit code.
   *
   * Mirrors the recovery the media pipeline already performs at startup.
   */
  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    // Cross-organization by design: a server that died mid-sync left rows
    // behind in whichever tenants were running, and none of them is 'the'
    // organization here.
    setImmediate(() => void withSystemTenant(() => this.reclaimStaleRuns()));
  }

  async reclaimStaleRuns(now: Date = new Date()) {
    try {
      const cutoff = new Date(now.getTime() - STALE_SYNC_RUN_AFTER_MS);
      const reclaimed = await this.prisma.propertywareSyncRun.updateMany({
        // `startedAt` is null on a run that died before it began, so creation
        // time is the fallback — otherwise those rows are never reclaimed and
        // block syncing indefinitely.
        where: {
          status: 'RUNNING',
          OR: [{ startedAt: { lt: cutoff } }, { startedAt: null, createdAt: { lt: cutoff } }],
        },
        data: { status: 'FAILED', completedAt: now },
      });
      if (reclaimed.count)
        this.logger.warn(
          `Reclaimed ${reclaimed.count} abandoned Propertyware sync run(s); their process did not survive to finish them.`,
        );
      return reclaimed.count;
    } catch (error) {
      // Never fatal. Failing to reclaim leaves syncing blocked, which is bad,
      // but taking the application down with it is worse.
      this.logger.warn(`Stale sync-run scan failed: ${String(error)}`);
      return 0;
    }
  }

  async enqueue(input: EnqueuePropertywareSync) {
    const request = { entities: input.entities, mode: input.mode, requestedBy: input.requestedBy };
    const run = await this.worker.createRun(input.organizationId, request);
    // Runs after the response (or from cron), so the request's tenant scope
    // is gone — but the organization is known, so the sync re-establishes it
    // rather than running with system access for its whole duration.
    setImmediate(() =>
      void withTenant(input.organizationId, () =>
        this.worker.execute(run.id, input.organizationId, request),
      ),
    );
    return { syncRunId: run.id, status: 'PENDING' as const };
  }
}
