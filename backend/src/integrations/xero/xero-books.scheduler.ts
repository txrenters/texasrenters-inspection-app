import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CronJob } from 'cron';

import { BUSINESS_TIME_ZONE } from '../../common/business-day';
import { PrismaService } from '../../common/prisma.service';
import { withSystemTenant, withTenant } from '../../database/tenant-context';
import { XeroBooksService } from './xero-books.service';
import { XeroProjectsService } from './xero-projects.service';

/** Hourly, at five past: between the sender's ten-minute runs. */
const DEFAULT_CRON = '5 * * * *';

/**
 * Reads each company's books back from Xero (2026-11-12, PR 2 of the plan to
 * make invoices in the console with Xero as the record): every hour, for every
 * organisation the office connected and set up. Two calls a run once its
 * history is read, when nothing changed.
 *
 * Off on a server with `XERO_BOOKS_READ_ENABLED=false`.
 */
@Injectable()
export class XeroBooksScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(XeroBooksScheduler.name);
  private job?: CronJob;
  /** One run at a time on this server; the organisation's claim keeps other servers out. */
  private running = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(XeroBooksService) private readonly books: XeroBooksService,
    @Inject(XeroProjectsService) private readonly projects: XeroProjectsService,
  ) {}

  onModuleInit() {
    if (process.env.XERO_BOOKS_READ_ENABLED === 'false') {
      this.logger.log({ event: 'xero_books_read_disabled' });
      return;
    }
    const cronTime = process.env.XERO_BOOKS_READ_CRON ?? DEFAULT_CRON;
    this.job = CronJob.from({ cronTime, onTick: () => void this.tick(), start: true, timeZone: BUSINESS_TIME_ZONE });
    this.logger.log({ event: 'xero_books_read_scheduled', cron: cronTime });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // Which offices' organisations are connected and set up: a question across organizations.
      const reading = await withSystemTenant(() =>
        this.prisma.xeroSettings.findMany({
          where: { xeroOrganisation: { status: 'CONNECTED' } },
          select: { organizationId: true, xeroTenantId: true },
        }),
      );
      for (const { organizationId, xeroTenantId } of reading) {
        try {
          const result = await withTenant(organizationId, () => this.books.run(organizationId, xeroTenantId));
          const { invoices, payments } = result;
          if (invoices.made || invoices.updated || payments.made || payments.updated || payments.removed || result.problem)
            this.logger.log({ event: 'xero_books_read', organizationId, xeroTenantId, invoices, payments, calls: result.calls, problem: result.problem });
        } catch (error) {
          // One organisation's trouble never stops another's.
          this.logger.error({ event: 'xero_books_read_failed', organizationId, xeroTenantId, message: error instanceof Error ? error.message : String(error) });
        }
        // Its projects in progress (2026-11-13), every six hours while its projects are on: for the invoice form.
        try {
          const read = await withTenant(organizationId, () => this.projects.readIfDue(organizationId, xeroTenantId));
          if (read) this.logger.log({ event: 'xero_projects_read', organizationId, xeroTenantId, ...read });
        } catch (error) {
          this.logger.error({ event: 'xero_projects_read_failed', organizationId, xeroTenantId, message: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      this.logger.error({ event: 'xero_books_read_failed', message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.running = false;
    }
  }
}
