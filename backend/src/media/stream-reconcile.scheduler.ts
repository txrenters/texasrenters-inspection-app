import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { CronJob } from 'cron';

import { InspectionVideoService } from './inspection-video.service';

/**
 * Asks Cloudflare about recordings whose webhook never arrived.
 *
 * `InspectionVideoService.reconcileStuckVideos` was written for exactly this
 * and nothing ever called it, which made the whole video pipeline depend on a
 * single HTTP call landing. It does not always land: the webhook is one URL per
 * Cloudflare account, so pointing it at one environment silently removes it
 * from the other, and a backend that happens to be restarting misses a delivery
 * outright.
 *
 * The consequences are larger than a stalled player, because the webhook is the
 * only moment this backend learns a Stream recording exists and is playable.
 * Losing it means no `readyAt`, so no playback; no transcription and no
 * analysis, so an inspection reads as "the AI found nothing" rather than "the
 * AI never ran"; and an area that never reaches COMPLETED, which blocks
 * submission of an inspection whose evidence is safely stored.
 *
 * Every five minutes, and cheap: the query is bounded, indexed on
 * processingStatus, and skips anything younger than ten minutes so a healthy
 * upload in progress is never polled. A run with nothing stuck costs one
 * database query and no Cloudflare calls at all, which is why this is
 * unconditional rather than hidden behind a flag — a safety net nobody
 * remembered to enable is the situation this is fixing.
 */
@Injectable()
export class StreamReconcileScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StreamReconcileScheduler.name);
  private job?: CronJob;
  /** One run at a time; a slow sweep must not stack on the next tick. */
  private running = false;

  constructor(
    @Inject(InspectionVideoService) private readonly videos: InspectionVideoService,
  ) {}

  onModuleInit() {
    const expression = process.env.STREAM_RECONCILE_CRON ?? '*/5 * * * *';
    this.job = new CronJob(expression, () => void this.sweep());
    this.job.start();
    this.logger.log({ event: 'stream_reconcile_scheduled', cron: expression });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  private async sweep() {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.videos.reconcileStuckVideos();
      // Only when it did something. A quiet sweep every five minutes would
      // bury the runs that matter.
      if (result.reconciled > 0)
        this.logger.warn({
          event: 'stream_reconcile_recovered',
          ...result,
          detail: 'Recordings recovered whose webhook never arrived — check the Cloudflare webhook URL.',
        });
    } catch (error) {
      // Never throw out of a cron callback: an unhandled rejection here takes
      // the process down, and a failed sweep is not worth an outage.
      this.logger.error({
        event: 'stream_reconcile_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}
