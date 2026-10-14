/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { type Quarter, quarterLabel } from '@texasrenters/shared';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { holdRequestOpen } from '../common/long-request';
import { PrismaService } from '../common/prisma.service';
import { PlanBuildGuard } from './plan-build-guard';
import { PLANNING_TAG } from './planning.controller';
import { PlanUnscheduleDto, PlanUnschedulePreviewQueryDto } from './planning.dto';
import { TbpUnscheduleService } from './tbp-unschedule.service';

/**
 * Taking a quarter's visits off their days (the office, 2026-10-15), so a
 * Rebuild can group them again. See `TbpUnscheduleService`.
 *
 * Its own controller, as the Days view's is, so `PlanningController`'s
 * constructor -- built positionally in its specs -- stays as it is. It deletes
 * inspections, so it takes the console's grant to change inspections as well as
 * the planner's, and runs under the build guard: a build in the middle of it
 * would lay out half a quarter's visits that were about to lose their days.
 */
@ApiTags(PLANNING_TAG)
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/planning')
export class PlanUnscheduleController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PlanBuildGuard) private readonly builds: PlanBuildGuard,
    @Inject(TbpUnscheduleService) private readonly unscheduling: TbpUnscheduleService,
  ) {}

  /** What unscheduling from a day on would do, changing nothing. */
  @Get('quarters/:planId/unschedule')
  @RequirePermissions('planning:publish')
  preview(
    @Req() request: AuthenticatedRequest,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Query() query: PlanUnschedulePreviewQueryDto,
  ) {
    return this.unscheduling.preview(request.user, planId, { from: query.from });
  }

  /** Takes them off: Jobber's Unscheduled list for the booked ones, no day for the rest. */
  @Post('quarters/:planId/unschedule')
  @RequirePermissions('planning:publish', 'inspections:manage')
  @HttpCode(200)
  async unschedule(
    @Req() request: AuthenticatedRequest,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() body: PlanUnscheduleDto,
  ) {
    const plan = await this.prisma.tbpQuarterPlan.findFirst({
      where: { id: planId, organizationId: request.user.organizationId },
      select: { quarterYear: true, quarterNumber: true },
    });
    if (!plan) throw new ApplicationError(404, 'PLAN_NOT_FOUND', 'This plan does not exist.');
    // A few hundred visits, one transaction each: past the server's idle timeout.
    holdRequestOpen(request);
    return this.builds.run(
      request.user.organizationId,
      quarterLabel({ year: plan.quarterYear, quarter: plan.quarterNumber as Quarter['quarter'] }),
      () => this.unscheduling.unschedule(request.user, planId, body),
    );
  }
}
