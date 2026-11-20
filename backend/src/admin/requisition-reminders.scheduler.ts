import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CronJob } from 'cron';

import { BUSINESS_TIME_ZONE } from '../common/business-day';
import { PrismaService } from '../common/prisma.service';
import { withSystemTenant, withTenant } from '../database/tenant-context';
import { RequisitionApproversService } from './requisition-approvers';

/** Twenty past every hour: a requisition is reminded within the hour it is due. */
const DEFAULT_CRON = '20 * * * *';

/**
 * Reminds the approvers of requisitions still waiting past their approval
 * step's days (Purchasing Setup, 2026-11-20), once each. Only offices with a
 * step that reminds are read.
 *
 * On unless `REQUISITION_REMINDERS_ENABLED` is `false`; the office decides in
 * Setup whether any step reminds at all, and none does until it says so.
 */
@Injectable()
export class RequisitionRemindersScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RequisitionRemindersScheduler.name);
  private job?: CronJob;
  /** One run at a time: a slow one must not stack on the next. */
  private running = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequisitionApproversService) private readonly approvers: RequisitionApproversService,
  ) {}

  onModuleInit() {
    if (process.env.REQUISITION_REMINDERS_ENABLED === 'false') {
      this.logger.log({ event: 'requisition_reminders_disabled' });
      return;
    }
    const cronTime = process.env.REQUISITION_REMINDERS_CRON ?? DEFAULT_CRON;
    this.job = CronJob.from({ cronTime, onTick: () => void this.tick(), start: true, timeZone: BUSINESS_TIME_ZONE });
    this.logger.log({ event: 'requisition_reminders_scheduled', cron: cronTime });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  async tick(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      // Which offices remind at all: a question across organizations.
      const offices = await withSystemTenant(() =>
        this.prisma.purchasingApprovalStep.findMany({ where: { reminderDays: { not: null } }, distinct: ['organizationId'], select: { organizationId: true } }),
      );
      for (const { organizationId } of offices) {
        try {
          const reminded = await withTenant(organizationId, () => this.approvers.remind(organizationId, now));
          if (reminded) this.logger.log({ event: 'requisition_reminders_sent', organizationId, reminded });
        } catch (error) {
          // One office's trouble never stops another's.
          this.logger.error({ event: 'requisition_reminders_failed', organizationId, message: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      this.logger.error({ event: 'requisition_reminders_failed', message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.running = false;
    }
  }
}
