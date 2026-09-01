import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CronJob } from 'cron';

import { getJobberConfig } from '../../integrations/jobber/jobber.config';
import { JobberOutboundWorker } from './jobber-outbound.worker';
import { JobberSyncWorker } from './jobber-sync.worker';

/**
 * Runs the Jobber pull on a schedule.
 *
 * Starts nothing unless `JOBBER_SYNC_ENABLED` is exactly "true", a cron
 * expression is set, and an organization is named — the same fail-closed shape
 * the Propertyware scheduler uses. A half-configured deployment does nothing
 * rather than syncing an unexpected organization's calendar.
 */
@Injectable()
export class JobberSyncScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobberSyncScheduler.name);
  private readonly config = getJobberConfig();
  private job: CronJob | null = null;

  /**
   * Guards against a run that outlives its interval.
   *
   * A calendar large enough to be paced by the rate limiter can take longer
   * than the cron period, and two overlapping runs would both try to import the
   * same visits — surviving on the unique index, but wasting the whole budget
   * losing those races.
   */
  private running = false;

  constructor(
    @Inject(JobberSyncWorker) private readonly worker: JobberSyncWorker,
    @Inject(JobberOutboundWorker) private readonly outbound: JobberOutboundWorker,
  ) {}

  onModuleInit() {
    const { syncEnabled, incrementalSyncCron, schedulerOrganizationId } = this.config;
    if (!syncEnabled || !incrementalSyncCron || !schedulerOrganizationId) {
      this.logger.log('Jobber sync scheduler is off.');
      return;
    }
    this.job = new CronJob(incrementalSyncCron, () => void this.tick(schedulerOrganizationId));
    this.job.start();
    this.logger.log(`Jobber sync scheduled (${incrementalSyncCron}).`);
  }

  onModuleDestroy() {
    this.job?.stop();
    this.job = null;
  }

  private async tick(organizationId: string) {
    if (this.running) {
      this.logger.warn('Skipping Jobber sync: the previous run has not finished.');
      return;
    }
    this.running = true;
    // Two independent try blocks, not one. The pull and the push fail for
    // different reasons, and a pull that dies on an unexpected visit shape must
    // not also strand completed inspections that Jobber is still owed.
    //
    // Both swallow: an unhandled rejection out of a cron callback takes the
    // process down, and each failure is already recorded — the pull's on the
    // connection, the push's on the task it belongs to.
    try {
      const result = await this.worker.run(organizationId);
      this.logger.log(
        `Jobber sync ${result.correlationId}: ${result.visitsSeen} seen, ${result.imported} imported, ` +
          `${result.rescheduled} rescheduled, ${result.unmatched} unmatched, ${result.rejected} rejected, ` +
          `${result.alreadyComplete} already complete, ${result.notSynced} not synced.`,
      );
    } catch (error) {
      this.logger.error(
        `Jobber sync failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    try {
      // Drained on the same tick rather than its own schedule: the outbox is
      // small, and one cadence means one place to look when Jobber is quiet.
      const pushed = await this.outbound.run(organizationId);
      if (pushed.processed)
        this.logger.log(
          `Jobber push: ${pushed.sent} sent, ${pushed.failed} retrying, ${pushed.abandoned} abandoned.`,
        );
    } catch (error) {
      this.logger.error(
        `Jobber push failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.running = false;
    }
  }
}
