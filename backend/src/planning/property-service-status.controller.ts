import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { PropertyServiceChange, PropertyServiceView } from '@texasrenters/shared';
import { IsBoolean, IsOptional } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { PropertyServiceStatusService } from './property-service-status.service';

export class SetPropertyServiceStatusDto {
  /** The owner ended Texas Renters' management: nothing more is booked at the property. */
  @IsOptional() @IsBoolean() managementEnded?: boolean;
  /** The property left the tenant benefit package: no more quarterly occupied and HVAC visits. */
  @IsOptional() @IsBoolean() tbpOptedOut?: boolean;
}

/**
 * The office's switches on a property, for what Propertyware is late to say
 * (the office, 2026-10-08).
 *
 * In the planning module rather than beside the property's other endpoints
 * because turning one runs the lease schedule for the property there and then.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/properties/:propertyId/service-status')
export class PropertyServiceStatusController {
  constructor(@Inject(PropertyServiceStatusService) private readonly service: PropertyServiceStatusService) {}

  /** Which switches are on, who turned them, and what is still booked there that they say should not be. */
  @Get()
  @RequirePermissions('properties:read')
  view(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId', ParseUUIDPipe) propertyId: string,
  ): Promise<PropertyServiceView> {
    return this.service.view(request.user, propertyId);
  }

  /**
   * Turn either switch, or both. `properties:manage`, as the property's other
   * settings: a fact about the property, set once and obeyed by everything
   * that books visits there. Audited.
   */
  @Put()
  @RequirePermissions('properties:manage')
  set(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() body: SetPropertyServiceStatusDto,
  ): Promise<PropertyServiceChange> {
    return this.service.set(request.user, propertyId, body);
  }
}
