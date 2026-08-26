import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { CronJob } from 'cron';

import { PrismaService } from '../common/prisma.service';

/**
 * Deletes position history once it is older than the retention window.
 *
 * This exists because the table it prunes would otherwise grow without limit
 * and, far more importantly, because it records where named employees were,
 * minute by minute. Keeping that for ever is a decision nobody made — so the
 * default is that it expires, and somebody has to act to keep it longer rather
 * than act to delete it.
 *
 * **Thirty days is a placeholder, not a policy.** The repository has no
 * retention or privacy document to derive it from: `SECURITY_REQUIREMENTS.md`
 * lists "confirmed retention/deletion policies" as still required, and
 * `VIDEO_PIPELINE.md` calls retention an open business question. Thirty days is
 * long enough to answer "where was this technician last Tuesday" and short
 * enough that nothing accumulates while the real number is being decided. Set
 * `TECHNICIAN_LOCATION_RETENTION_DAYS` once it is.
 */
const DEFAULT_RETENTION_DAYS = 30;

@Injectable()
export class LocationRetentionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LocationRetentionScheduler.name);
  private job?: CronJob;
  /** One run at a time; a slow delete must not stack on the next tick. */
  private running = false;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  onModuleInit() {
    // Nightly, off the hour. Nothing depends on when it runs, and a delete of
    // a day's rows is cheap on an indexed timestamp.
    const expression = process.env.TECHNICIAN_LOCATION_RETENTION_CRON ?? '17 3 * * *';
    this.job = new CronJob(expression, () => void this.prune());
    this.job.start();
    this.logger.log({
      event: 'location_retention_scheduled',
      cron: expression,
      retentionDays: this.retentionDays(),
    });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  private retentionDays() {
    const configured = Number(process.env.TECHNICIAN_LOCATION_RETENTION_DAYS);
    // A nonsensical value keeps the default rather than deleting everything.
    // Getting this wrong in the unsafe direction destroys history silently.
    return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_RETENTION_DAYS;
  }

  private async prune() {
    if (this.running) return;
    this.running = true;
    try {
      const days = this.retentionDays();
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const { count } = await this.prisma.technicianLocationPing.deleteMany({
        // On `recordedAt`, the device's own clock, so a batch that arrived late
        // is aged from when it was taken rather than from when it landed.
        where: { recordedAt: { lt: cutoff } },
      });
      if (count > 0)
        this.logger.log({ event: 'location_history_pruned', deleted: count, retentionDays: days });
    } catch (error) {
      // Never throw out of a cron callback: an unhandled rejection takes the
      // process down, and a missed prune is not worth an outage.
      this.logger.error({
        event: 'location_retention_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}
