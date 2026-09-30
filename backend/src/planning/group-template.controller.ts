/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { GroupTemplateActiveDto, GroupTemplateMatchDto, GroupTemplateOpsDto, GroupTemplateSaveDto } from './group-template.dto';
import { GroupTemplateService } from './group-template.service';
import { PLANNING_TAG } from './planning.controller';

/**
 * The console's Group maker: the office's own grouping of the benefit-package
 * properties into days, saved as templates a quarter can be built from
 * (2026-09-30).
 *
 * Read with `planning:read`, like the plan; changed with `planning:publish`,
 * like building one -- a template decides a quarter's days as much as a
 * build's settings do.
 */
@ApiTags(PLANNING_TAG)
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/planning')
export class GroupTemplateController {
  constructor(@Inject(GroupTemplateService) private readonly templates: GroupTemplateService) {}

  /** Every enrolled property with a position, to group: the same visits a quarter will have. */
  @Get('group-maker/properties')
  @RequirePermissions('planning:read')
  properties(@Req() request: AuthenticatedRequest) {
    return this.templates.properties(request.user.organizationId);
  }

  @Get('group-templates')
  @RequirePermissions('planning:read')
  list(@Req() request: AuthenticatedRequest) {
    return this.templates.list(request.user.organizationId);
  }

  @Get('group-templates/:id')
  @RequirePermissions('planning:read')
  get(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.get(request.user.organizationId, id);
  }

  @Post('group-templates')
  @RequirePermissions('planning:publish')
  create(@Req() request: AuthenticatedRequest, @Body() body: GroupTemplateSaveDto) {
    return this.templates.create(request.user, body);
  }

  @Put('group-templates/:id')
  @RequirePermissions('planning:publish')
  save(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: GroupTemplateSaveDto) {
    return this.templates.save(request.user, id, body);
  }

  /**
   * Live edits: a batch of changes applied on top of what the template holds
   * now, and passed on to everyone with it open (2026-10-01).
   */
  @Post('group-templates/:id/ops')
  @RequirePermissions('planning:publish')
  @HttpCode(200)
  applyOps(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: GroupTemplateOpsDto) {
    return this.templates.applyOps(request.user, id, body.batchId, body.ops);
  }

  /** The template a quarter the daily planner creates is built from: one at a time. */
  @Post('group-templates/:id/active')
  @RequirePermissions('planning:publish')
  @HttpCode(200)
  setActive(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: GroupTemplateActiveDto) {
    return this.templates.setActive(request.user, id, body.active);
  }

  @Post('group-templates/:id/archive')
  @RequirePermissions('planning:publish')
  @HttpCode(200)
  archive(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.archive(request.user, id);
  }

  /**
   * A groups file's rows, matched to properties by address, to start a
   * template from the file. Nothing is kept: the file is read in the browser,
   * and only each row's address and postcode are sent here.
   */
  @Post('group-templates/match')
  @RequirePermissions('planning:read')
  @HttpCode(200)
  match(@Req() request: AuthenticatedRequest, @Body() body: GroupTemplateMatchDto) {
    return this.templates.match(request.user.organizationId, body.rows);
  }
}
