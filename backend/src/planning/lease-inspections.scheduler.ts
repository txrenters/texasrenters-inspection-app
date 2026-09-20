import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { LeaseScheduleAction, LeaseScheduleState } from '@texasrenters/shared';
import { CronJob } from 'cron';

import { BUSINESS_TIME_ZONE } from '../common/business-day';
import { withTenant } from '../database/tenant-context';
import { LeaseInspectionService } from './lease-inspections.service';

/**
 * Early morning in Texas, after the night's Propertyware syncs have brought
 * the leases up to date.
 */
const DEFAULT_CRON = '15 2 * * *';

/**
 * Books the day's move-outs and move-ins from the leases, once a day.
 *
 * Off unless `LEASE_INSPECTIONS_ENABLED` is `true`. Switching it on puts real
 * inspections on technicians' phones, so a deployment that merely has the code
 * must not start doing it; the console can preview a run before anyone does.
 */
@Injectable()
export class LeaseInspectionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeaseInspectionScheduler.name);
  private job?: CronJob;
  /** One run at a time: a slow one must not stack on the next. */
  private running = false;
  private lastRun: { at: Date; counts: Record<LeaseScheduleAction, number> } | null = null;

  constructor(@Inject(LeaseInspectionService) private readonly schedule: LeaseInspectionService) {}

  onModuleInit() {
    if (process.env.LEASE_INSPECTIONS_ENABLED !== 'true') {
      this.logger.log({ event: 'lease_inspections_disabled' });
      return;
    }
    const organizationId = process.env.LEASE_INSPECTIONS_ORGANIZATION_ID ?? process.env.TBP_PLANNING_ORGANIZATION_ID;
    if (!organizationId) {
      this.logger.warn({
        event: 'lease_inspections_not_scheduled',
        reason: 'LEASE_INSPECTIONS_ORGANIZATION_ID is not set.',
      });
      return;
    }
    const cronTime = this.cron();
    this.job = CronJob.from({
      cronTime,
      onTick: () => void this.tick(organizationId),
      start: true,
      timeZone: BUSINESS_TIME_ZONE,
    });
    this.logger.log({ event: 'lease_inspections_scheduled', cron: cronTime, organizationId });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  /** Whether the daily run is on, when it next runs, and what the last one did, for the console. */
  describe(): LeaseScheduleState {
    return {
      enabled: Boolean(this.job),
      cron: this.cron(),
      nextRunAt: this.job?.nextDate()?.toJSDate().toISOString() ?? null,
      running: this.running,
      lastRun: this.lastRun ? { at: this.lastRun.at.toISOString(), counts: this.lastRun.counts } : null,
    };
  }

  private cron() {
    return process.env.LEASE_INSPECTIONS_CRON ?? DEFAULT_CRON;
  }

  private async tick(organizationId: string) {
    if (this.running) return;
    this.running = true;
    try {
      // `withTenant`, as every cron here: row-level security is on, and a run
      // with no tenant reads no leases and reports a clean, empty day.
      const run = await withTenant(organizationId, () => this.schedule.run(organizationId));
      this.lastRun = { at: new Date(), counts: run.counts };
    } catch (error) {
      // Never out of a cron callback: tomorrow's run tries again.
      this.logger.error({
        event: 'lease_inspections_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}
