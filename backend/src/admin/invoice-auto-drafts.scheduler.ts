import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CronJob } from 'cron';

import { BUSINESS_TIME_ZONE } from '../common/business-day';
import { PrismaService } from '../common/prisma.service';
import { withSystemTenant, withTenant } from '../database/tenant-context';
import { InvoiceAutoDraftsService } from './invoice-auto-drafts.service';

/**
 * Every ten minutes, five past the sender's: a visit finished is drafted
 * within ten minutes, and its drafts reach Xero five minutes later.
 */
const DEFAULT_CRON = '5-59/10 * * * *';

/**
 * Drafts the invoices of the visits finished since each office turned "Draft
 * invoices automatically" on (2026-11-13). An office that has not is never
 * touched. Off on a server with `INVOICE_AUTO_DRAFTS_ENABLED=false`, whatever
 * the offices chose.
 */
@Injectable()
export class InvoiceAutoDraftsScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvoiceAutoDraftsScheduler.name);
  private job?: CronJob;
  /** One run at a time: a slow one must not stack on the next. */
  private running = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InvoiceAutoDraftsService) private readonly drafts: InvoiceAutoDraftsService,
  ) {}

  onModuleInit() {
    if (process.env.INVOICE_AUTO_DRAFTS_ENABLED === 'false') {
      this.logger.log({ event: 'invoice_auto_drafts_disabled' });
      return;
    }
    const cronTime = process.env.INVOICE_AUTO_DRAFTS_CRON ?? DEFAULT_CRON;
    this.job = CronJob.from({ cronTime, onTick: () => void this.tick(), start: true, timeZone: BUSINESS_TIME_ZONE });
    this.logger.log({ event: 'invoice_auto_drafts_scheduled', cron: cronTime });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // Which offices draft them: a question across organizations.
      const offices = await withSystemTenant(() =>
        this.prisma.invoiceSettings.findMany({ where: { autoDraftsFrom: { not: null } }, select: { organizationId: true } }),
      );
      for (const { organizationId } of offices) {
        try {
          await withTenant(organizationId, () => this.drafts.run(organizationId));
        } catch (error) {
          // One office's trouble never stops another's.
          this.logger.error({ event: 'invoice_auto_drafts_failed', organizationId, message: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      this.logger.error({ event: 'invoice_auto_drafts_failed', message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.running = false;
    }
  }
}
