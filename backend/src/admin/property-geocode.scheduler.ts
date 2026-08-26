import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { CronJob } from 'cron';

import { PropertyGeocodingService } from './property-geocoding.service';

/**
 * Fills in property coordinates in the background.
 *
 * A schedule rather than a one-off script because the work never actually
 * finishes: the Propertyware sync adds properties continuously, and an address
 * corrected in the console has to be looked up again. A script would have to be
 * remembered every time, and the symptom of forgetting — a property quietly
 * missing from the map — is one nobody would report.
 *
 * It is deliberately unhurried. Nothing in the product waits on a coordinate,
 * so a small batch on a slow cron keeps a free public service comfortable and
 * still clears any realistic backlog within a day.
 */
const DEFAULT_BATCH = 25;

/**
 * How long after boot the first run happens.
 *
 * Not immediately: start-up is when the database connection, the migrations
 * and every other module are competing, and this is the least urgent thing in
 * the process.
 */
const FIRST_RUN_DELAY_MS = 60_000;

@Injectable()
export class PropertyGeocodeScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PropertyGeocodeScheduler.name);
  private job?: CronJob;
  private firstRun?: ReturnType<typeof setTimeout>;
  /** One run at a time; a slow batch must not stack on the next tick. */
  private running = false;

  constructor(
    @Inject(PropertyGeocodingService) private readonly geocoding: PropertyGeocodingService,
  ) {}

  onModuleInit() {
    if (process.env.PROPERTY_GEOCODING_ENABLED === 'false') {
      this.logger.log({ event: 'property_geocoding_disabled' });
      return;
    }

    const expression = process.env.PROPERTY_GEOCODE_CRON ?? '23 * * * *';
    this.job = new CronJob(expression, () => void this.run());
    this.job.start();

    this.firstRun = setTimeout(() => void this.run(), FIRST_RUN_DELAY_MS);
    // Never hold the process open for this. A backfill is not a reason for a
    // container to refuse to exit.
    this.firstRun.unref?.();

    this.logger.log({ event: 'property_geocoding_scheduled', cron: expression });
  }

  onModuleDestroy() {
    this.job?.stop();
    if (this.firstRun) clearTimeout(this.firstRun);
  }

  private batchSize() {
    const configured = Number(process.env.PROPERTY_GEOCODE_BATCH);
    return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_BATCH;
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      await this.geocoding.geocodePending(this.batchSize());
    } catch (error) {
      // Never throw out of a cron callback: an unhandled rejection takes the
      // process down, and a missed batch is not worth an outage.
      this.logger.error({
        event: 'property_geocoding_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}
