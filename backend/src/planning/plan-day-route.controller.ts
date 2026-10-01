/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { Body, Controller, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { type Quarter, quarterLabel } from '@texasrenters/shared';

import {
  ApiAuthGuard,
  auditActor,
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedRequest,
  type AuthenticatedUser,
} from '../common/auth';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { holdRequestOpen } from '../common/long-request';
import { PrismaService } from '../common/prisma.service';
import { PlanBuildGuard } from './plan-build-guard';
import { PlanDayMoveService } from './plan-day-move.service';
import { PLANNING_TAG } from './planning.controller';
import { PlanDayVisitDto } from './planning.dto';
import { QuarterPlannerService, type OptimizedDay } from './quarter-planner.service';

/**
 * The Days view's own changes to a quarter: a day's order, every day's order,
 * and a visit moved onto a day from the map (the office, 2026-10-02: the Days
 * view to work as the Group maker does).
 *
 * Its own controller, as the groups file has one, so `PlanningController`'s
 * constructor -- built positionally in its specs -- stays as it is. Each runs
 * under the build guard: a build lays every day out again, and an order written
 * in the middle of one would be overwritten or, worse, half-kept.
 */
@ApiTags(PLANNING_TAG)
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/planning')
export class PlanDayRouteController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(QuarterPlannerService) private readonly planner: QuarterPlannerService,
    @Inject(PlanBuildGuard) private readonly builds: PlanBuildGuard,
    @Inject(PlanDayMoveService) private readonly moves: PlanDayMoveService,
  ) {}

  /** One day in the order that drives least from the technician's home. */
  @Post('quarters/:planId/days/:dayId/optimize-route')
  @RequirePermissions('planning:publish')
  async optimizeDay(@Req() request: AuthenticatedRequest, @Param('planId') planId: string, @Param('dayId') dayId: string) {
    const { organizationId } = request.user;
    const day = await this.prisma.tbpQuarterPlanDay.findFirst({
      where: { id: dayId, planId, organizationId },
      select: { date: true, technicianId: true },
    });
    if (!day) throw new ApplicationError(404, 'PLAN_DAY_NOT_FOUND', 'This planned day does not exist.');
    const date = day.date.toISOString().slice(0, 10);
    if (date < businessDate()) throw new ApplicationError(409, 'PLAN_DAY_PASSED', 'That day has passed, so its order is history.');

    const label = await this.labelOf(organizationId, planId);
    return this.builds.run(organizationId, label, async () => {
      const days = await this.planner.optimizeDays(organizationId, planId, [{ date, technicianId: day.technicianId }]);
      await this.audit(request.user, planId, days);
      return { days };
    });
  }

  /** Every day from today on, the same way: what was planned before this ordered days with the twenty-minute rule. */
  @Post('quarters/:planId/optimize-routes')
  @RequirePermissions('planning:publish')
  async optimizeQuarter(@Req() request: AuthenticatedRequest, @Param('planId') planId: string) {
    const { organizationId } = request.user;
    const label = await this.labelOf(organizationId, planId);
    // Forty-odd days, each measured on the road: a minute or so, as a build is.
    holdRequestOpen(request);
    return this.builds.run(organizationId, label, async () => {
      const days = await this.planner.optimizeQuarter(organizationId, planId, businessDate());
      await this.audit(request.user, planId, days);
      return { days };
    });
  }

  /** A visit clicked on the map joins the day picked in the list. */
  @Post('quarters/:planId/days/:dayId/visits')
  @RequirePermissions('planning:publish')
  async moveVisit(
    @Req() request: AuthenticatedRequest,
    @Param('planId') planId: string,
    @Param('dayId') dayId: string,
    @Body() body: PlanDayVisitDto,
  ) {
    const label = await this.labelOf(request.user.organizationId, planId);
    return this.builds.run(request.user.organizationId, label, () => this.moves.move(request.user, planId, dayId, body.stopId));
  }

  private async labelOf(organizationId: string, planId: string) {
    const plan = await this.prisma.tbpQuarterPlan.findFirst({
      where: { id: planId, organizationId },
      select: { quarterYear: true, quarterNumber: true },
    });
    if (!plan) throw new ApplicationError(404, 'PLAN_NOT_FOUND', 'This plan does not exist.');
    return quarterLabel({ year: plan.quarterYear, quarter: plan.quarterNumber as Quarter['quarter'] });
  }

  /** Who reordered which days, and what it did to the driving: the order is the office's plan for the day. */
  private async audit(user: AuthenticatedUser, planId: string, days: readonly OptimizedDay[]) {
    const changed = days.filter((day) => day.changed);
    await this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        ...auditActor(user),
        action: 'TBP_DAY_ROUTES_OPTIMIZED',
        entityType: 'TbpQuarterPlan',
        entityId: planId,
        metadata: {
          days: days.length,
          changed: changed.length,
          dayIds: changed.map((day) => day.dayId),
          driveSecondsBefore: sum(changed.map((day) => day.driveSecondsBefore)),
          driveSecondsAfter: sum(changed.map((day) => day.driveSecondsAfter)),
          homeDriveSecondsBefore: sum(changed.map((day) => day.homeDriveSecondsBefore)),
          homeDriveSecondsAfter: sum(changed.map((day) => day.homeDriveSecondsAfter)),
        },
      },
    });
  }
}

const sum = (values: readonly (number | null)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
