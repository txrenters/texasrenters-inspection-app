/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiSecurity, ApiTags } from '@nestjs/swagger';

import { PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import {
  InspectionListQueryDto,
  PropertyListQueryDto,
  TechnicianListQueryDto,
  UnitListQueryDto,
} from '../admin/admin.dto';
import { AdminService } from '../admin/admin.service';
import { PropertyGeocodingService } from '../admin/property-geocoding.service';
import { TechnicianLocationService } from '../technician/technician-location.service';
import { API_KEY_SECURITY_SCHEME } from '../openapi/openapi.document';
import { GatewayAuthGuard } from './gateway-auth.guard';
import { MachineAccessible } from './machine-accessible.decorator';
import { ApiRateLimitGuard } from './rate-limit.guard';

/**
 * The third-party contract.
 *
 * A separate surface from `/admin`, on purpose. The console's endpoints exist to
 * serve the console: their shapes change whenever a screen needs them to, and
 * that is fine precisely because both sides ship together. An integration does
 * not ship with us. Opening `/admin` routes to keys would silently promote every
 * one of them to a public contract we can no longer change, and would put the
 * decision about what third parties can reach in the hands of whoever next edits
 * a controller.
 *
 * So the surface here is curated, small, and read-only to begin with. Widening it
 * is a deliberate act: add the route, mark it {@link MachineAccessible}, and
 * accept that its response shape is now something we have promised to somebody.
 *
 * Guard order matters. `GatewayAuthGuard` resolves the caller, `PermissionsGuard`
 * authorizes it, and `ApiRateLimitGuard` runs last because it needs the client
 * the first guard identified — a limiter that ran first could only key off the
 * source address, which is the wrong unit for a per-client allowance.
 */
@ApiTags('Third-party gateway')
@ApiSecurity(API_KEY_SECURITY_SCHEME)
@UseGuards(GatewayAuthGuard, PermissionsGuard, ApiRateLimitGuard)
@Controller('gateway')
export class GatewayController {
  constructor(
    @Inject(AdminService) private readonly service: AdminService,
    @Inject(TechnicianLocationService) private readonly locations: TechnicianLocationService,
    @Inject(PropertyGeocodingService) private readonly propertyGeocoding: PropertyGeocodingService,
  ) {}

  /** Properties in the calling client's organization. */
  @Get('properties')
  @MachineAccessible()
  @RequirePermissions('properties:read')
  properties(@Req() request: AuthenticatedRequest, @Query() query: PropertyListQueryDto) {
    return this.service.properties(request.user, query);
  }

  /** One property, with its units and areas. */
  @Get('properties/:propertyId')
  @MachineAccessible()
  @RequirePermissions('properties:read')
  property(@Req() request: AuthenticatedRequest, @Param('propertyId') propertyId: string) {
    return this.service.property(request.user, propertyId);
  }

  /** Units belonging to one property. */
  @Get('properties/:propertyId/units')
  @MachineAccessible()
  @RequirePermissions('properties:read')
  units(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') propertyId: string,
    @Query() query: UnitListQueryDto,
  ) {
    return this.service.units(request.user, propertyId, query);
  }

  /** Inspections, filterable by type, status and date range. */
  @Get('inspections')
  @MachineAccessible()
  @RequirePermissions('inspections:read')
  inspections(@Req() request: AuthenticatedRequest, @Query() query: InspectionListQueryDto) {
    return this.service.inspections(request.user, query);
  }

  /**
   * Every technician's most recent position.
   *
   * The feed a dispatching integration actually needs, and the most sensitive
   * thing on this surface: it says where a named employee was at a given
   * minute. Behind `technicians:locate` — its own grant, separate from reading
   * the directory, so an integration is scoped to tracking deliberately rather
   * than as a side effect — and read-only. Positions are reported by the
   * handsets themselves; nothing outside may write one.
   */
  @Get('technician-locations')
  @MachineAccessible()
  @RequirePermissions('technicians:locate')
  technicianLocations(@Req() request: AuthenticatedRequest) {
    return this.locations.latestPositions(request.user);
  }

  /**
   * Every property that has been placed on the map.
   *
   * Pairs with the positions above: a nearest-technician rule needs both ends of
   * the distance. Behind `properties:read`, the same grant that lists properties
   * anywhere else.
   */
  @Get('property-locations')
  @MachineAccessible()
  @RequirePermissions('properties:read')
  propertyLocations(@Req() request: AuthenticatedRequest) {
    return this.propertyGeocoding.positions(request.user);
  }

  /**
   * The technician directory, for resolving the ids the position feed returns
   * into people a scheduler can actually assign work to.
   */
  @Get('technicians')
  @MachineAccessible()
  @RequirePermissions('technicians:read')
  technicians(@Req() request: AuthenticatedRequest, @Query() query: TechnicianListQueryDto) {
    return this.service.technicians(request.user, query);
  }

  /**
   * One inspection.
   *
   * Read-only and reviewed content only, like every other consumer of this
   * method — an AI finding that no person has approved is not visible here any
   * more than it is in the console.
   */
  @Get('inspections/:inspectionId')
  @MachineAccessible()
  @RequirePermissions('inspections:read')
  inspection(@Req() request: AuthenticatedRequest, @Param('inspectionId') inspectionId: string) {
    return this.service.inspection(request.user, inspectionId);
  }
}
