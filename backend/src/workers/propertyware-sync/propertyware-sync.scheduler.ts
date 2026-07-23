import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { CronJob } from 'cron';

import { PROPERTYWARE_ENTITIES } from '../../integrations/propertyware/propertyware.constants';
import { PROPERTYWARE_CONFIG } from '../../integrations/propertyware/propertyware.config';
import type {
  PropertywareConfig,
  SyncMode,
} from '../../integrations/propertyware/propertyware.types';
import { PropertywareSyncCoordinator } from './propertyware-sync.coordinator';

/**
 * Registers cron jobs that automatically run the incremental and reconciliation
 * Propertyware syncs. Scheduling only activates when PROPERTYWARE_SYNC_ENABLED
 * is true and an internal organization UUID is configured; overlapping runs are
 * prevented by the sync store's per-entity locks, so a slow run cannot stack.
 *
 * Jobs are created directly with the `cron` library and owned by this service
 * (started in onModuleInit, stopped in onModuleDestroy) to avoid depending on
 * @nestjs/schedule's metadata scanning.
 */
@Injectable()
export class PropertywareSyncScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PropertywareSyncScheduler.name);
  private readonly jobs = new Map<SyncMode, CronJob>();

  private static readonly JOBS: Array<{ mode: SyncMode; name: string }> = [
    { mode: 'incremental', name: 'propertyware-incremental-sync' },
    { mode: 'reconciliation', name: 'propertyware-reconciliation-sync' },
  ];

  constructor(
    @Inject(PROPERTYWARE_CONFIG) private readonly config: PropertywareConfig,
    @Inject(PropertywareSyncCoordinator) private readonly coordinator: PropertywareSyncCoordinator,
  ) {}

  onModuleInit() {
    if (!this.config.syncEnabled) {
      this.logger.log(
        'Propertyware automatic sync is disabled (PROPERTYWARE_SYNC_ENABLED is not "true").',
      );
      return;
    }
    const organizationId = this.config.schedulerOrganizationId;
    if (!organizationId) {
      this.logger.warn(
        'Propertyware sync is enabled but PROPERTYWARE_LOCAL_ORGANIZATION_ID is not set; automatic syncs will not run.',
      );
      return;
    }
    for (const entry of PropertywareSyncScheduler.JOBS)
      this.schedule(entry.name, this.cronFor(entry.mode), entry.mode, organizationId);
  }

  onModuleDestroy() {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  /** Read-only view of the automatic schedule for the admin UI. */
  describe() {
    const jobs = PropertywareSyncScheduler.JOBS.map((entry) => {
      const job = this.jobs.get(entry.mode);
      let nextRunAt: string | null = null;
      if (job) {
        try {
          const next = job.nextDate() as { toISO?: () => string | null };
          nextRunAt = typeof next?.toISO === 'function' ? next.toISO() : null;
        } catch {
          nextRunAt = null;
        }
      }
      return {
        mode: entry.mode,
        cron: this.cronFor(entry.mode) ?? null,
        scheduled: Boolean(job),
        nextRunAt,
      };
    });
    return {
      enabled: this.config.syncEnabled,
      organizationConfigured: Boolean(this.config.schedulerOrganizationId),
      jobs,
    };
  }

  private cronFor(mode: SyncMode) {
    if (mode === 'incremental') return this.config.incrementalSyncCron;
    if (mode === 'reconciliation') return this.config.reconciliationCron;
    return undefined;
  }

  private schedule(
    name: string,
    cronExpression: string | undefined,
    mode: SyncMode,
    organizationId: string,
  ) {
    if (!cronExpression) {
      this.logger.warn(`No cron expression configured for the ${mode} Propertyware sync; skipping.`);
      return;
    }
    let job: CronJob;
    try {
      job = new CronJob(cronExpression, () => void this.trigger(name, mode, organizationId));
    } catch {
      this.logger.error(
        `Invalid cron expression for ${name}: "${cronExpression}". This sync will not be scheduled.`,
      );
      return;
    }
    job.start();
    this.jobs.set(mode, job);
    this.logger.log(`Scheduled ${mode} Propertyware sync (${name}) with cron "${cronExpression}".`);
  }

  private async trigger(name: string, mode: SyncMode, organizationId: string) {
    try {
      const { syncRunId } = await this.coordinator.enqueue({
        organizationId,
        requestedBy: `scheduler:${name}`,
        entities: [...PROPERTYWARE_ENTITIES],
        mode,
      });
      this.logger.log(`Enqueued scheduled ${mode} Propertyware sync (run ${syncRunId}).`);
    } catch (error) {
      this.logger.error(
        `Scheduled ${mode} Propertyware sync failed to enqueue: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
