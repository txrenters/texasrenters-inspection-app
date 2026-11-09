import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CronJob } from 'cron';

import { BUSINESS_TIME_ZONE } from '../common/business-day';
import { PrismaService } from '../common/prisma.service';
import { withSystemTenant, withTenant } from '../database/tenant-context';
import { InvoiceFollowUpsService } from './invoice-follow-ups.service';

/** 1:30 PM in Texas, when Jobber sent its own. */
const DEFAULT_CRON = '30 13 * * *';

/**
 * Sends the day's invoice follow-ups, once a day, for every office that has
 * taken invoicing over from Jobber. An office that has not is never touched:
 * Jobber still sends its own.
 *
 * On unless `INVOICE_FOLLOW_UPS_ENABLED` is `false`, because a deployment that
 * has taken over and does not send them leaves overdue invoices unchased.
 */
@Injectable()
export class InvoiceFollowUpsScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvoiceFollowUpsScheduler.name);
  private job?: CronJob;
  /** One run at a time: a slow one must not stack on the next. */
  private running = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InvoiceFollowUpsService) private readonly followUps: InvoiceFollowUpsService,
  ) {}

  onModuleInit() {
    if (process.env.INVOICE_FOLLOW_UPS_ENABLED === 'false') {
      this.logger.log({ event: 'invoice_follow_ups_disabled' });
      return;
    }
    const cronTime = process.env.INVOICE_FOLLOW_UPS_CRON ?? DEFAULT_CRON;
    this.job = CronJob.from({ cronTime, onTick: () => void this.tick(), start: true, timeZone: BUSINESS_TIME_ZONE });
    this.logger.log({ event: 'invoice_follow_ups_scheduled', cron: cronTime });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // Which offices own their invoicing: a question across organizations.
      const offices = await withSystemTenant(() =>
        this.prisma.invoiceSettings.findMany({
          where: { invoicingTakenOverAt: { not: null } },
          select: { organizationId: true },
        }),
      );
      for (const { organizationId } of offices) {
        try {
          await withTenant(organizationId, () => this.followUps.run(organizationId));
        } catch (error) {
          // One office's trouble never stops another's.
          this.logger.error({
            event: 'invoice_follow_ups_failed',
            organizationId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      this.logger.error({ event: 'invoice_follow_ups_failed', message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.running = false;
    }
  }
}
