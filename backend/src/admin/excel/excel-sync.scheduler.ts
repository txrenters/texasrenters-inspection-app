import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CronJob } from 'cron';

import { BUSINESS_TIME_ZONE } from '../../common/business-day';
import { PrismaService } from '../../common/prisma.service';
import { withSystemTenant, withTenant } from '../../database/tenant-context';
import { ExcelSyncService } from './excel-sync.service';

/** Each minute: a save made in the console is in the office's workbook within about a minute. */
const DEFAULT_CRON = '* * * * *';

/**
 * Keeps Actual vs Budget's workbook in step (2026-11-17). Each minute it asks,
 * for every office whose sync is on, whether a save waits or the tabs have not
 * been written for a while; only then does it write, and only one server at a
 * time (the run's claim on the office's ExcelSync row). Off with
 * EXCEL_SYNC_ENABLED=false; the minute with EXCEL_SYNC_CRON.
 */
@Injectable()
export class ExcelSyncScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExcelSyncScheduler.name);
  private job?: CronJob;
  private running = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ExcelSyncService) private readonly sync: ExcelSyncService,
  ) {}

  onModuleInit() {
    if (process.env.EXCEL_SYNC_ENABLED === 'false') {
      this.logger.log({ event: 'excel_sync_disabled' });
      return;
    }
    const cronTime = process.env.EXCEL_SYNC_CRON ?? DEFAULT_CRON;
    this.job = CronJob.from({ cronTime, onTick: () => void this.tick(), start: true, timeZone: BUSINESS_TIME_ZONE });
    this.logger.log({ event: 'excel_sync_scheduled', cron: cronTime });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const offices = await withSystemTenant(() => this.prisma.excelSync.findMany({ where: { enabled: true }, select: { organizationId: true } }));
      for (const { organizationId } of offices) {
        try {
          await withTenant(organizationId, () => this.sync.runIfDue(organizationId));
        } catch (error) {
          // The office's row says what went wrong; one office never stops the others.
          this.logger.warn({ event: 'excel_sync_run_failed', organizationId, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
