import { Controller, Get, Inject, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { GroupTemplateChangesService } from './group-template-changes.service';
import { PLANNING_TAG } from './planning.controller';
import { QuarterPackageChangesService } from './quarter-package-changes.service';

/**
 * What changed in the benefit package (the office, 2026-10-15): under a group
 * template, who left and the group each is still in, who joined and the groups
 * each would fit; and for a quarter, who left since the last one and who is
 * new, with the package's dated history. Read with `planning:read`, like the
 * template and the quarter themselves.
 *
 * A controller of its own, so `GroupTemplateController`'s constructor and the
 * specs that build it stay as they are.
 */
@ApiTags(PLANNING_TAG)
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/planning')
export class GroupTemplateChangesController {
  constructor(
    @Inject(GroupTemplateChangesService) private readonly changes: GroupTemplateChangesService,
    @Inject(QuarterPackageChangesService) private readonly quarters: QuarterPackageChangesService,
  ) {}

  @Get('group-templates/:id/changes')
  @RequirePermissions('planning:read')
  get(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.changes.changes(request.user.organizationId, id);
  }

  @Get('quarters/:planId/package-changes')
  @RequirePermissions('planning:read')
  quarter(@Req() request: AuthenticatedRequest, @Param('planId', ParseUUIDPipe) planId: string) {
    return this.quarters.changes(request.user.organizationId, planId);
  }
}
