import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { PlanBuildGuard } from './plan-build-guard';
import { PLANNING_TAG } from './planning.controller';
import { QuarterCoverageService } from './quarter-coverage.service';
import { TbpPlanService } from './tbp-plan.service';

/**
 * Where every property in the benefit package stands for a quarter: completed,
 * scheduled, not scheduled, or no visit created (the office, 2026-11-20). Read
 * with `planning:read`, like the quarter itself; a property with no visit is
 * added with `planning:publish`, like any other change to the plan.
 */
@ApiTags(PLANNING_TAG)
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/planning')
export class QuarterCoverageController {
  constructor(
    @Inject(QuarterCoverageService) private readonly coverage: QuarterCoverageService,
    @Inject(TbpPlanService) private readonly plans: TbpPlanService,
    @Inject(PlanBuildGuard) private readonly builds: PlanBuildGuard,
  ) {}

  @Get('quarters/:planId/coverage')
  @RequirePermissions('planning:read')
  get(@Req() request: AuthenticatedRequest, @Param('planId', ParseUUIDPipe) planId: string) {
    return this.coverage.coverage(request.user.organizationId, planId);
  }

  /**
   * A property in the package that the quarter has no visit for, given one:
   * a stop for each of its enrolled leases that has none, with no day yet.
   */
  @Post('quarters/:planId/properties/:buildingId')
  @RequirePermissions('planning:publish')
  @HttpCode(200)
  add(
    @Req() request: AuthenticatedRequest,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
  ) {
    // Never while a build is rewriting the quarter's stops.
    this.builds.refuseWhileBuilding(request.user.organizationId);
    return this.plans.addToQuarter(request.user, planId, buildingId);
  }
}
