import { Controller, Get, Inject, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { PLANNING_TAG } from './planning.controller';
import { QuarterCoverageService } from './quarter-coverage.service';

/**
 * Where every property in the benefit package stands for a quarter: completed,
 * scheduled, not scheduled, or no visit created (the office, 2026-11-20). Read
 * with `planning:read`, like the quarter itself.
 */
@ApiTags(PLANNING_TAG)
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/planning')
export class QuarterCoverageController {
  constructor(@Inject(QuarterCoverageService) private readonly coverage: QuarterCoverageService) {}

  @Get('quarters/:planId/coverage')
  @RequirePermissions('planning:read')
  get(@Req() request: AuthenticatedRequest, @Param('planId', ParseUUIDPipe) planId: string) {
    return this.coverage.coverage(request.user.organizationId, planId);
  }
}
