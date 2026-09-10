import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Quarter, quarterDueForPlanning, quarterLabel } from '@texasrenters/shared';
import { CronJob } from 'cron';

import { withTenant } from '../database/tenant-context';
import { QuarterPlannerService } from './quarter-planner.service';
import { TbpPlanService } from './tbp-plan.service';

/**
 * The default is a daily tick, not a quarterly one, and that is not laziness.
 *
 * Cron cannot express "fourteen days before the first of January, April, July
 * and October" — the lead time moves the date across two different months. So
 * this wakes daily, asks `quarterDueForPlanning` whether today falls inside a
 * quarter's planning window, and does nothing on the ~340 days it does not.
 */
const DEFAULT_CRON = '41 4 * * *';

@Injectable()
export class TbpPlanScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TbpPlanScheduler.name);
  private job?: CronJob;
  /** One run at a time; a slow generation must not stack on the next tick. */
  private running = false;

  constructor(
    @Inject(TbpPlanService) private readonly plans: TbpPlanService,
    @Inject(QuarterPlannerService) private readonly planner: QuarterPlannerService,
  ) {}

  onModuleInit() {
    // Fail closed. A planner that starts by default would book a quarter of
    // work in any deployment that merely happens to have the code.
    if (process.env.TBP_PLANNING_ENABLED !== 'true') {
      this.logger.log({ event: 'tbp_planning_disabled' });
      return;
    }
    const organizationId = process.env.TBP_PLANNING_ORGANIZATION_ID;
    if (!organizationId) {
      this.logger.warn({
        event: 'tbp_planning_not_scheduled',
        reason: 'TBP_PLANNING_ORGANIZATION_ID is not set.',
      });
      return;
    }

    const expression = process.env.TBP_PLAN_CRON ?? DEFAULT_CRON;
    this.job = new CronJob(expression, () => void this.tick(organizationId));
    this.job.start();
    this.logger.log({ event: 'tbp_planning_scheduled', cron: expression, organizationId });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  /** `{ enabled, cron, nextRunAt, running }` for the console. */
  describe() {
    return {
      enabled: Boolean(this.job),
      cron: process.env.TBP_PLAN_CRON ?? DEFAULT_CRON,
      // From the job itself rather than lastRun + interval: a cron expression
      // is not a fixed interval, and the two answers diverge at month ends.
      nextRunAt: this.job?.nextDate()?.toJSDate() ?? null,
      running: this.running,
    };
  }

  private async tick(organizationId: string) {
    if (this.running) return;
    this.running = true;
    try {
      const due = quarterDueForPlanning(new Date());
      if (!due) return;
      await this.generate(organizationId, due);
    } catch (error) {
      // Never throw out of a cron callback: an unhandled rejection takes the
      // process down, and a missed planning run is not worth an outage. The
      // window is a fortnight wide, so tomorrow's tick tries again.
      this.logger.error({
        event: 'tbp_planning_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  private async generate(organizationId: string, quarter: Quarter) {
    // `withTenant`, without exception. Row-level security is on for
    // `Inspection` and the plan tables; a cron has no request, so the
    // interceptor never runs and an unwrapped generation reads an empty
    // database and reports a clean, busy-looking result — a plan with no stops
    // and nothing anywhere saying why.
    const result = await withTenant(organizationId, () =>
      this.plans.generate(organizationId, quarter),
    );

    if (result.blockedCount > 0)
      this.logger.warn({
        event: 'tbp_plan_has_blocked_stops',
        quarter: quarterLabel(quarter),
        planId: result.planId,
        blockedCount: result.blockedCount,
        consequence: 'Publishing is refused until every blocked stop is resolved or excluded.',
      });

    // Routing is attempted even when stops are blocked. A draft with a day and
    // a technician against every stop it *can* place is reviewable; one that
    // refused to route because a single tenancy is missing a unit is not, and
    // the coordinator has two weeks to fix that tenancy and re-route.
    const routed = await withTenant(organizationId, () =>
      this.planner.route(organizationId, result.planId, this.holidays()),
    );

    if (routed.unplaced.length > 0)
      this.logger.warn({
        event: 'tbp_plan_has_unplaced_stops',
        quarter: quarterLabel(quarter),
        planId: result.planId,
        unplaced: routed.unplaced.length,
        reasons: [...new Set(routed.unplaced.map((entry) => entry.reason))],
      });
  }

  /**
   * The days the office is closed, as `YYYY-MM-DD`.
   *
   * Configuration rather than a derived calendar: a hardcoded list of US
   * federal holidays would be wrong for the days this office actually closes
   * and right for days it does not. Malformed entries are dropped rather than
   * throwing — a typo in a holiday list should cost one working day, not the
   * quarter's plan.
   */
  private holidays(): string[] {
    return (process.env.TBP_PLANNING_HOLIDAYS ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry));
  }
}
