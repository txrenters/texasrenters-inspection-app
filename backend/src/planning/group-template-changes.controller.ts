import { Controller, Get, Inject, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { GroupTemplateChangesService } from './group-template-changes.service';
import { PLANNING_TAG } from './planning.controller';

/**
 * What changed in the benefit package under a group template (the office,
 * 2026-10-15): who left and the group each is still in, who joined and the
 * groups each would fit. Read with `planning:read`, like the template itself.
 *
 * A controller of its own, so `GroupTemplateController`'s constructor and the
 * specs that build it stay as they are.
 */
@ApiTags(PLANNING_TAG)
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/planning')
export class GroupTemplateChangesController {
  constructor(@Inject(GroupTemplateChangesService) private readonly changes: GroupTemplateChangesService) {}

  @Get('group-templates/:id/changes')
  @RequirePermissions('planning:read')
  get(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.changes.changes(request.user.organizationId, id);
  }
}
