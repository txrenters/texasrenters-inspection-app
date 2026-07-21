/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Param,
  Optional,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@texasrenters/shared';

import { ApiAuthGuard, Roles, RolesGuard, type AuthenticatedRequest } from '../common/auth';
import { CacheInvalidateDto, CacheNamespaceDto } from '../cache/cache-admin.dto';
import { CacheInvalidationService } from '../cache/cache-invalidation.service';
import { CacheService } from '../cache/cache.service';
import {
  AssignmentDto,
  ApprovePropertyAreasDto,
  AssignmentListQueryDto,
  AuditListQueryDto,
  CreateAdminInspectionDto,
  CreatePropertyAreaDto,
  CreateTechnicianDto,
  InspectionListQueryDto,
  LeaseListQueryDto,
  PortfolioListQueryDto,
  PropertyListQueryDto,
  TechnicianListQueryDto,
  TechnicianStatusDto,
  UnitListQueryDto,
  UnassignDto,
  UpdatePropertyAreaDto,
  UpdateAdminInspectionDto,
} from './admin.dto';
import { AdminService } from './admin.service';
import { FloorPlanAdminService, type UploadedFloorPlan } from './floor-plan-admin.service';
import { TechnicianProvisioningService } from './technician-provisioning.service';

const ADMIN_ROLES = [
  UserRole.SYSTEM_ADMIN,
  UserRole.PROPERTY_ADMIN,
  UserRole.INSPECTION_SUPERVISOR,
];

@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly service: AdminService,
    private readonly technicianProvisioning: TechnicianProvisioningService,
    private readonly floorPlans: FloorPlanAdminService,
    @Optional() @Inject(CacheService) private readonly cache?: CacheService,
    @Optional()
    @Inject(CacheInvalidationService)
    private readonly cacheInvalidation?: CacheInvalidationService,
  ) {}

  @Get('profile') profile(@Req() request: AuthenticatedRequest) {
    return this.service.profile(request.user);
  }
  @Get('dashboard') dashboard(@Req() request: AuthenticatedRequest) {
    return this.service.dashboard(request.user);
  }

  @Get('portfolios') portfolios(
    @Req() request: AuthenticatedRequest,
    @Query() query: PortfolioListQueryDto,
  ) {
    return this.service.portfolios(request.user, query);
  }
  @Get('properties') properties(
    @Req() request: AuthenticatedRequest,
    @Query() query: PropertyListQueryDto,
  ) {
    return this.service.properties(request.user, query);
  }
  @Get('properties/:propertyId') property(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
  ) {
    return this.service.property(request.user, id);
  }
  @Get('properties/:propertyId/units') units(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
    @Query() query: UnitListQueryDto,
  ) {
    return this.service.units(request.user, id, query);
  }

  @Get('properties/:propertyId/floor-plans')
  floorPlanList(@Req() request: AuthenticatedRequest, @Param('propertyId') id: string) {
    return this.floorPlans.list(request.user, id);
  }
  @Post('properties/:propertyId/floor-plans')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.PROPERTY_ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20_000_000, files: 1 } }))
  uploadFloorPlan(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
    @UploadedFile() file?: UploadedFloorPlan,
  ) {
    return this.floorPlans.upload(request.user, id, file);
  }
  @Get('floor-plans/:floorPlanId/content')
  @Header('Cache-Control', 'private, no-store')
  async floorPlanContent(@Req() request: AuthenticatedRequest, @Param('floorPlanId') id: string) {
    const file = await this.floorPlans.content(request.user, id);
    return new StreamableFile(file.bytes, {
      type: file.mimeType,
      disposition: `inline; filename="${file.fileName}"`,
    });
  }
  @Post('floor-plans/:floorPlanId/extract')
  extractFloorPlan(@Req() request: AuthenticatedRequest, @Param('floorPlanId') id: string) {
    return this.floorPlans.extract(request.user, id);
  }
  @Get('properties/:propertyId/areas')
  propertyAreas(@Req() request: AuthenticatedRequest, @Param('propertyId') id: string) {
    return this.floorPlans.areas(request.user, id);
  }
  @Post('properties/:propertyId/areas')
  createPropertyArea(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
    @Body() body: CreatePropertyAreaDto,
  ) {
    return this.floorPlans.createArea(request.user, id, body);
  }
  @Post('properties/:propertyId/areas/fallback')
  createFallbackPropertyArea(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
  ) {
    return this.floorPlans.createFallbackArea(request.user, id);
  }
  @Patch('property-areas/:areaId')
  updatePropertyArea(
    @Req() request: AuthenticatedRequest,
    @Param('areaId') id: string,
    @Body() body: UpdatePropertyAreaDto,
  ) {
    return this.floorPlans.updateArea(request.user, id, body);
  }
  @Delete('property-areas/:areaId')
  deletePropertyArea(@Req() request: AuthenticatedRequest, @Param('areaId') id: string) {
    return this.floorPlans.deleteArea(request.user, id);
  }
  @Post('properties/:propertyId/areas/approve')
  approvePropertyAreas(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
    @Body() body: ApprovePropertyAreasDto,
  ) {
    return this.floorPlans.approveAreas(request.user, id, body.areaIds);
  }
  @Get('units/:unitId') unit(@Req() request: AuthenticatedRequest, @Param('unitId') id: string) {
    return this.service.unit(request.user, id);
  }
  @Get('units/:unitId/leases') leases(
    @Req() request: AuthenticatedRequest,
    @Param('unitId') id: string,
    @Query() query: LeaseListQueryDto,
  ) {
    return this.service.leases(request.user, id, query);
  }

  @Get('inspections') inspections(
    @Req() request: AuthenticatedRequest,
    @Query() query: InspectionListQueryDto,
  ) {
    return this.service.inspections(request.user, query);
  }
  @Post('inspections') createInspection(
    @Req() request: AuthenticatedRequest,
    @Body() body: CreateAdminInspectionDto,
  ) {
    return this.service.createInspection(request.user, body);
  }
  @Get('inspections/:inspectionId') inspection(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
  ) {
    return this.service.inspection(request.user, id);
  }
  @Get('inspections/:inspectionId/audit') inspectionAudit(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Query() query: AuditListQueryDto,
  ) {
    return this.service.inspectionAudit(request.user, id, query);
  }
  @Patch('inspections/:inspectionId') updateInspection(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: UpdateAdminInspectionDto,
  ) {
    return this.service.updateInspection(request.user, id, body);
  }
  @Post('inspections/:inspectionId/assign') assign(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: AssignmentDto,
  ) {
    return this.service.assign(request.user, id, body);
  }
  @Post('inspections/:inspectionId/reassign') reassign(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: AssignmentDto,
  ) {
    return this.service.reassign(request.user, id, body);
  }
  @Post('inspections/:inspectionId/unassign') unassign(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: UnassignDto,
  ) {
    return this.service.unassign(request.user, id, body);
  }

  @Get('assignments') assignments(
    @Req() request: AuthenticatedRequest,
    @Query() query: AssignmentListQueryDto,
  ) {
    return this.service.assignments(request.user, query);
  }
  @Get('technicians') technicians(
    @Req() request: AuthenticatedRequest,
    @Query() query: TechnicianListQueryDto,
  ) {
    return this.service.technicians(request.user, query);
  }
  @Post('technicians')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.PROPERTY_ADMIN)
  createTechnician(@Req() request: AuthenticatedRequest, @Body() body: CreateTechnicianDto) {
    return this.technicianProvisioning.create(request.user, body);
  }
  @Get('technicians/:technicianId') technician(
    @Req() request: AuthenticatedRequest,
    @Param('technicianId') id: string,
  ) {
    return this.service.technician(request.user, id);
  }
  @Patch('technicians/:technicianId/status') technicianStatus(
    @Req() request: AuthenticatedRequest,
    @Param('technicianId') id: string,
    @Body() body: TechnicianStatusDto,
  ) {
    return this.service.updateTechnicianStatus(request.user, id, body);
  }

  @Get('integrations/providers/status') providerStatus() {
    return this.service.providerStatus();
  }

  @Get('cache/status')
  @Roles(UserRole.SYSTEM_ADMIN)
  cacheStatus() {
    return this.cache?.status() ?? { enabled: false, state: 'disabled' };
  }

  @Get('cache/metrics')
  @Roles(UserRole.SYSTEM_ADMIN)
  cacheMetrics() {
    return this.cache?.metricSnapshot() ?? { hits: 0, misses: 0, hitRatio: 0 };
  }

  @Post('cache/invalidate')
  @Roles(UserRole.SYSTEM_ADMIN)
  async invalidateCache(@Req() request: AuthenticatedRequest, @Body() body: CacheInvalidateDto) {
    const scope = body.resource === 'providerReadiness' ? 'global' : request.user.organizationId;
    await this.cacheInvalidation?.invalidate(body.resource, scope, {
      ...(body.query ?? {}),
      ...(body.id ? { id: body.id } : {}),
    });
    return { accepted: true, resource: body.resource };
  }

  @Post('cache/bump-namespace')
  @Roles(UserRole.SYSTEM_ADMIN)
  async bumpCacheNamespace(@Req() request: AuthenticatedRequest, @Body() body: CacheNamespaceDto) {
    const scope = body.namespace === 'providerReadiness' ? 'global' : request.user.organizationId;
    await this.cacheInvalidation?.bump(body.namespace, scope);
    return { accepted: true, namespace: body.namespace };
  }
}
