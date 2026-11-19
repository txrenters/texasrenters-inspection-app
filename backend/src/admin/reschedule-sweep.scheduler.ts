import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CronJob } from 'cron';

import { PrismaService } from '../common/prisma.service';
import { openMissedRescheduleRequests } from '../common/reschedule-requests';
import { withSystemTenant } from '../database/tenant-context';

/**
 * Brings the visits marked "book it again" that never reached the queue into
 * it (`openMissedRescheduleRequests`, 2026-11-19).
 *
 * Every hour, and cheap: one indexed read of the last sixty days' done visits
 * that have no request, which is nothing at all once the backlog is in. No
 * provider is called. On by default, as a safety net has to be; set
 * `RESCHEDULE_SWEEP_ENABLED=false` to stop it.
 */
@Injectable()
export class RescheduleSweepScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RescheduleSweepScheduler.name);
  private job?: CronJob;
  /** One run at a time; a slow sweep must not stack on the next tick. */
  private running = false;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.RESCHEDULE_SWEEP_ENABLED === 'false') {
      this.logger.log('Reschedule sweep is disabled (RESCHEDULE_SWEEP_ENABLED=false).');
      return;
    }
    const expression = process.env.RESCHEDULE_SWEEP_CRON ?? '23 * * * *';
    this.job = new CronJob(expression, () => void this.sweep());
    this.job.start();
    this.logger.log({ event: 'reschedule_sweep_scheduled', cron: expression });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  async sweep(now: Date = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      const result = await withSystemTenant(() => openMissedRescheduleRequests(this.prisma, now));
      // Only when it did something: an hourly "nothing to do" would bury the runs that matter.
      if (result.opened || result.bookedAlready) this.logger.log({ event: 'reschedule_sweep_opened', ...result });
    } catch (error) {
      // Never throw out of a cron callback: an unhandled rejection takes the process down.
      this.logger.error({
        event: 'reschedule_sweep_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}
