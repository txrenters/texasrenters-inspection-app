import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CronJob } from 'cron';

import { BUSINESS_TIME_ZONE } from '../../common/business-day';
import { PrismaService } from '../../common/prisma.service';
import { withSystemTenant, withTenant } from '../../database/tenant-context';
import { XeroSenderService } from './xero-sender.service';

/** Every ten minutes: an invoice reaches Xero within about that of changing. */
const DEFAULT_CRON = '*/10 * * * *';

/**
 * Sends changed invoices to Xero (2026-11-10, phase 3 of the Xero plan) for
 * every office that turned sending on. A run that finds nothing changed reads
 * the database and calls Xero not at all.
 *
 * Off on a server with `XERO_SENDING_ENABLED=false`, whatever the offices chose.
 */
@Injectable()
export class XeroSenderScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(XeroSenderScheduler.name);
  private job?: CronJob;
  /** One run at a time on this server; the office's claim keeps other servers out. */
  private running = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(XeroSenderService) private readonly sender: XeroSenderService,
  ) {}

  onModuleInit() {
    if (process.env.XERO_SENDING_ENABLED === 'false') {
      this.logger.log({ event: 'xero_sending_disabled' });
      return;
    }
    const cronTime = process.env.XERO_SENDING_CRON ?? DEFAULT_CRON;
    this.job = CronJob.from({ cronTime, onTick: () => void this.tick(), start: true, timeZone: BUSINESS_TIME_ZONE });
    this.logger.log({ event: 'xero_sending_scheduled', cron: cronTime });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // Which offices send: a question across organizations.
      const offices = await withSystemTenant(() =>
        this.prisma.xeroSettings.findMany({ where: { sendingEnabled: true }, select: { organizationId: true } }),
      );
      for (const { organizationId } of offices) {
        try {
          const result = await withTenant(organizationId, () => this.sender.run(organizationId));
          if (result.sent || result.failed || result.problem)
            this.logger.log({ event: 'xero_sending_ran', organizationId, sent: result.sent, failed: result.failed, problem: result.problem });
        } catch (error) {
          // One office's trouble never stops another's.
          this.logger.error({ event: 'xero_sending_failed', organizationId, message: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      this.logger.error({ event: 'xero_sending_failed', message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.running = false;
    }
  }
}
