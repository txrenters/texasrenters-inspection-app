import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { CronJob } from 'cron';

import { PrismaService } from '../common/prisma.service';
import { withSystemTenant } from '../database/tenant-context';
import { TimeTrackingService } from './time-tracking.service';

/**
 * Reads recently submitted jobs' time from the trail again, a while after.
 *
 * The recompute that runs when a technician submits reads whatever had
 * arrived by that second, and that is routinely not the whole trail: the
 * handset queues fixes while it is out of signal and flushes them when it gets
 * back, which in this portfolio means a rural property's arrival can land
 * after the job is already submitted. Computing once at submission would bake
 * in the short answer, and short is the direction that costs a technician
 * money.
 *
 * So each job is read again for a while afterwards. A recompute is the whole
 * answer for a job and replaces what the last one wrote, so running it
 * repeatedly costs a query and changes nothing once the trail has settled --
 * and a correction an administrator has already made is spared by
 * `recomputeWithin` rather than by this deciding when to stop.
 */
@Injectable()
export class TimeTrackingScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TimeTrackingScheduler.name);
  private job?: CronJob;
  /** One run at a time; a slow sweep must not stack on the next tick. */
  private running = false;

  /**
   * How far back a submitted job stays eligible to be read again.
   *
   * Six hours covers a handset that spent an afternoon out of signal and
   * flushed on the drive home, which is the case this exists for. Past that
   * the trail is what it is going to be, and anything still missing is a
   * tracking gap for the office to settle rather than something more waiting
   * will fix.
   */
  private static readonly SETTLING_MS = 6 * 60 * 60 * 1000;

  /** A guard, not a limit anybody is expected to hit: ~10 jobs a day is normal. */
  private static readonly MAX_PER_RUN = 200;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TimeTrackingService) private readonly time: TimeTrackingService,
  ) {}

  onModuleInit() {
    if (process.env.TIME_TRACKING_SWEEP_ENABLED === 'false') {
      this.logger.log('Time-tracking sweep is disabled (TIME_TRACKING_SWEEP_ENABLED=false).');
      return;
    }
    // Every fifteen minutes. The hours are read the moment a job is submitted;
    // this is only the catch-up, so it is paced to arrive well within the time
    // anybody spends reviewing a report rather than to be immediate.
    const expression = process.env.TIME_TRACKING_SWEEP_CRON ?? '*/15 * * * *';
    this.job = new CronJob(expression, () => void this.sweep());
    this.job.start();
    this.logger.log({ event: 'time_tracking_sweep_scheduled', cron: expression });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  /**
   * Public so it can be driven directly, by a test and by anything that later
   * wants to say "read the recent jobs now". The cron callback below discards
   * the promise it returns -- correct for a timer, which has nothing to await
   * with, but it means a caller that does want to wait has to have this.
   */
  async sweep() {
    if (this.running) return;
    this.running = true;
    try {
      const since = new Date(Date.now() - TimeTrackingScheduler.SETTLING_MS);
      /**
       * `withSystemTenant` because a sweep belongs to no organization.
       *
       * The row-level policies fail closed, so without it this reads nothing
       * at all and reports a clean run for ever while every timesheet stays
       * empty — the same silent failure the location prune carries a note
       * about. Each job is still recomputed under its own organization id.
       */
      const due = await withSystemTenant(() =>
        this.prisma.inspection.findMany({
          where: { submittedAt: { gte: since } },
          select: { id: true, organizationId: true },
          orderBy: { submittedAt: 'desc' },
          take: TimeTrackingScheduler.MAX_PER_RUN,
        }),
      );
      if (!due.length) return;

      let measured = 0;
      for (const inspection of due) {
        // Sequential on purpose. This is a catch-up with hours to spare, and a
        // burst of parallel recomputes would compete with the handsets
        // reporting their positions, which is the one thing here that cannot
        // wait.
        const result = await withSystemTenant(() =>
          this.time.recomputeAutomatically(inspection.organizationId, inspection.id),
        );
        if (result) measured += 1;
      }
      this.logger.log({
        event: 'time_tracking_swept',
        considered: due.length,
        measured,
        // Said plainly rather than left to be worked out: these are the jobs
        // whose hours nobody can read yet, and the number going up is the
        // signal that something is wrong with the trail rather than with a
        // single job.
        unmeasurable: due.length - measured,
      });
    } catch (error) {
      // Never throw out of a cron callback: an unhandled rejection takes the
      // process down, and a missed sweep is not worth an outage.
      this.logger.error({
        event: 'time_tracking_sweep_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}
