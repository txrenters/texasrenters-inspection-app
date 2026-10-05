import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { CronJob } from 'cron';

import { businessDate, businessDayBounds } from '../common/business-day';
import { PrismaService } from '../common/prisma.service';
import { withSystemTenant } from '../database/tenant-context';
import { TimeTrackingService } from './time-tracking.service';

/**
 * Keeps the timesheet up to date while the technicians are still out.
 *
 * The office asked for the clock to start when a technician walks into a
 * property's circle and stop when they walk out. Nothing on the handset does
 * that -- neither iOS nor Android will watch a twenty-metre circle, their own
 * geofences are good to about a hundred -- so the circle is applied here, to
 * the trail the handset is already sending, every few minutes. Today's hours
 * are on the timesheet while today is still happening, and nobody has to
 * press Submit, or anything else, for them to be there.
 *
 * Yesterday is read again for a while too. A handset queues fixes while it is
 * out of signal and flushes them when it gets back, and a phone that went flat
 * in the afternoon sends the end of the day when it is next opened -- which is
 * the following morning. Reading a day once, when it ended, would bake in the
 * short answer, and short is the direction that costs a technician money.
 *
 * A reading that finds the day already says what the trail says writes
 * nothing, so running this often costs the queries and no more.
 */
@Injectable()
export class TimeTrackingScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TimeTrackingScheduler.name);
  private job?: CronJob;
  /** One run at a time; a slow sweep must not stack on the next tick. */
  private running = false;

  /**
   * How far into a day the one before it is still read.
   *
   * Until noon in Texas. That covers the handset that flushed on the drive
   * home and the one that was only opened again the next morning. Past that
   * the trail is what it is going to be, and a day that still looks wrong is
   * one for the office to recalculate or correct.
   */
  private static readonly SETTLING_MS = 12 * 60 * 60 * 1000;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TimeTrackingService) private readonly time: TimeTrackingService,
  ) {}

  onModuleInit() {
    if (process.env.TIME_TRACKING_SWEEP_ENABLED === 'false') {
      this.logger.log('Time-tracking sweep is disabled (TIME_TRACKING_SWEEP_ENABLED=false).');
      return;
    }
    // Every five minutes: often enough that the office watching a technician
    // on the map sees their hours move with them, and a handful of indexed
    // reads per technician each time.
    const expression = process.env.TIME_TRACKING_SWEEP_CRON ?? '*/5 * * * *';
    this.job = new CronJob(expression, () => void this.sweep());
    this.job.start();
    this.logger.log({ event: 'time_tracking_sweep_scheduled', cron: expression });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  /**
   * Public so it can be driven directly, by a test and by anything that later
   * wants to say "read the days now". The cron callback above discards the
   * promise it returns -- correct for a timer, which has nothing to await
   * with, but it means a caller that does want to wait has to have this.
   */
  async sweep(now: Date = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      const today = businessDayBounds(now);
      const settling = now.getTime() - today.start.getTime() < TimeTrackingScheduler.SETTLING_MS;
      // An instant inside yesterday, whatever the clocks did overnight.
      const yesterday = businessDayBounds(new Date(today.start.getTime() - 12 * 60 * 60 * 1000));
      const days = settling
        ? [businessDate(yesterday.start), businessDate(now)]
        : [businessDate(now)];

      /**
       * `withSystemTenant` because a sweep belongs to no organization.
       *
       * The row-level policies fail closed, so without it this reads nothing
       * at all and reports a clean run for ever while every timesheet stays
       * empty — the same silent failure the location prune carries a note
       * about. Each day is still read under its own organization id.
       */
      const tracked = await withSystemTenant(() =>
        this.prisma.technicianLocationPing.groupBy({
          by: ['organizationId', 'technicianId'],
          where: { recordedAt: { gte: settling ? yesterday.start : today.start } },
        }),
      );
      if (!tracked.length) return;

      let read = 0;
      let changed = 0;
      let failed = 0;
      for (const { organizationId, technicianId } of tracked)
        for (const day of days) {
          // Sequential on purpose. A burst of parallel readings would compete
          // with the handsets reporting their positions, which is the one
          // thing here that cannot wait.
          const result = await withSystemTenant(() =>
            this.time.recomputeDayAutomatically(organizationId, technicianId, day),
          );
          if (!result) failed += 1;
          else {
            read += 1;
            if (result.changed) changed += 1;
          }
        }
      // Said only when there is something to say: at this pace an unchanged
      // run every five minutes would be most of the log.
      if (changed || failed)
        this.logger.log({ event: 'time_tracking_swept', technicians: tracked.length, read, changed, failed });
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
