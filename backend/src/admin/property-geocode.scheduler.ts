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
 * Unhurried, but not slow. Nothing in the product waits on a coordinate, so
 * this stays polite — one request at a time with a pause between — but the
 * batch has to be large enough that a real portfolio actually finishes.
 *
 * At 25 a run, a 570-property portfolio took twenty-three hours to appear, and
 * for that whole day the map under-reported the business while looking like it
 * was working. 250 clears the same portfolio in three runs, and costs about a
 * minute of wall clock each.
 *
 * For a first backfill of a large portfolio, set `PROPERTY_GEOCODE_BATCH`
 * above the property count and let one run do the lot; the ongoing trickle
 * from the Propertyware sync is a handful a day and never approaches this.
 *
 * If the portfolio grows into the thousands, the right answer stops being a
 * bigger number here and becomes the Census **batch** endpoint, which takes up
 * to 10,000 addresses in a single upload.
 */
const DEFAULT_BATCH = 250;

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
      // Buildings first: they are what the console's property list and its map
      // both read, so coverage there is what anybody actually notices. The
      // `Property` pass after it is small — only rows the inspection workflow
      // created — but it is what the route planner measures from, so it cannot
      // be dropped.
      await this.geocoding.geocodePendingBuildings(this.batchSize());
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
