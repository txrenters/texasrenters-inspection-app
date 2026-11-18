import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { USAGE_PERIODS, type UsagePeriod } from '@texasrenters/shared';
import { IsIn, IsOptional } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { InventoryMonitoringService } from './inventory-monitoring.service';

export class InventoryMonitoringQueryDto {
  @IsOptional() @IsIn(USAGE_PERIODS) period?: UsagePeriod;
}

/** Reorder and usage (2026-11-19, phase 7): one read-only report, for anybody who sees the inventory. */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/inventory/monitoring')
export class InventoryMonitoringController {
  constructor(@Inject(InventoryMonitoringService) private readonly monitoring: InventoryMonitoringService) {}

  @Get()
  @RequirePermissions('inventory:read')
  report(@Req() request: AuthenticatedRequest, @Query() query: InventoryMonitoringQueryDto) {
    return this.monitoring.report(request.user, query.period);
  }
}
