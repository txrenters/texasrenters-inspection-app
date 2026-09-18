import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { LeaseScheduleOverview, LeaseScheduleRun } from '@texasrenters/shared';
import { IsBoolean, IsOptional } from 'class-validator';

import { ApiAuthGuard, type AuthenticatedRequest, PermissionsGuard, RequirePermissions } from '../common/auth';
import { LeaseInspectionScheduler } from './lease-inspections.scheduler';
import { LeaseInspectionService } from './lease-inspections.service';

export class RunLeaseInspectionsDto {
  /** Write nothing: show what a run would do. The default, so a bare call cannot book anything. */
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

/** Move-outs and move-ins booked from Propertyware's leases (the office, 2026-09-18). */
@ApiTags('planning')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/lease-inspections')
export class LeaseInspectionsController {
  constructor(
    @Inject(LeaseInspectionService) private readonly schedule: LeaseInspectionService,
    @Inject(LeaseInspectionScheduler) private readonly scheduler: LeaseInspectionScheduler,
  ) {}

  /** What the leases have booked, soonest first, and whether the daily run is on. */
  @Get()
  @RequirePermissions('inspections:read')
  async overview(@Req() request: AuthenticatedRequest): Promise<LeaseScheduleOverview> {
    return {
      schedule: this.scheduler.describe(),
      items: await this.schedule.list(request.user.organizationId),
    };
  }

  /** Apply the rules now: a preview unless `dryRun` is false. */
  @Post('run')
  @HttpCode(200)
  @RequirePermissions('inspections:manage')
  run(@Req() request: AuthenticatedRequest, @Body() body: RunLeaseInspectionsDto): Promise<LeaseScheduleRun> {
    return this.schedule.run(request.user.organizationId, { dryRun: body.dryRun ?? true });
  }
}
