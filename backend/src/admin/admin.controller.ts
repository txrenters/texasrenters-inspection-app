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
  ParseEnumPipe,
  Post,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import {
  ApiAuthGuard,
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedRequest,
} from '../common/auth';
import { CacheInvalidateDto, CacheNamespaceDto } from '../cache/cache-admin.dto';
import { CacheInvalidationService } from '../cache/cache-invalidation.service';
import { CacheService } from '../cache/cache.service';
import {
  AdminFindingsQueryDto,
  AssignmentDto,
  ApprovePropertyAreasDto,
  AssignmentListQueryDto,
  AuditListQueryDto,
  CreateAdminInspectionDto,
  CreatePropertyAreaDto,
  CreateReportShareDto,
  CreateTechnicianDto,
  FindingRejectDto,
  FindingReviewDto,
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
  UpdateAiProviderDto,
  UpdateAiRoutingDto,
  UploadFloorPlanDto,
} from './admin.dto';
import { AdminService } from './admin.service';
import { AiProviderSettingsService } from './ai-provider-settings.service';
import { FloorPlanAdminService, type UploadedFloorPlan } from './floor-plan-admin.service';
import { ReportShareService } from './report-share.service';
import { TechnicianProvisioningService } from './technician-provisioning.service';

@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly service: AdminService,
    private readonly aiSettings: AiProviderSettingsService,
    private readonly technicianProvisioning: TechnicianProvisioningService,
    private readonly floorPlans: FloorPlanAdminService,
    private readonly reportShares: ReportShareService,
    @Optional() @Inject(CacheService) private readonly cache?: CacheService,
    @Optional()
    @Inject(CacheInvalidationService)
    private readonly cacheInvalidation?: CacheInvalidationService,
  ) {}

  @Get('profile') profile(@Req() request: AuthenticatedRequest) {
    return this.service.profile(request.user);
  }
  @Get('dashboard')
  @RequirePermissions('dashboard:read')
  dashboard(@Req() request: AuthenticatedRequest) {
    return this.service.dashboard(request.user);
  }

  @Get('portfolios')
  @RequirePermissions('properties:read')
  portfolios(@Req() request: AuthenticatedRequest, @Query() query: PortfolioListQueryDto) {
    return this.service.portfolios(request.user, query);
  }
  @Get('properties')
  @RequirePermissions('properties:read')
  properties(@Req() request: AuthenticatedRequest, @Query() query: PropertyListQueryDto) {
    return this.service.properties(request.user, query);
  }
  @Get('properties/:propertyId')
  @RequirePermissions('properties:read')
  property(@Req() request: AuthenticatedRequest, @Param('propertyId') id: string) {
    return this.service.property(request.user, id);
  }
  @Get('properties/:propertyId/units')
  @RequirePermissions('properties:read')
  units(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
    @Query() query: UnitListQueryDto,
  ) {
    return this.service.units(request.user, id, query);
  }

  @Get('properties/:propertyId/floor-plans')
  @RequirePermissions('properties:read')
  floorPlanList(@Req() request: AuthenticatedRequest, @Param('propertyId') id: string) {
    return this.floorPlans.list(request.user, id);
  }
  @Post('properties/:propertyId/floor-plans')
  @RequirePermissions('properties:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20_000_000, files: 1 } }))
  uploadFloorPlan(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
    @Body() body: UploadFloorPlanDto,
    @UploadedFile() file?: UploadedFloorPlan,
  ) {
    return this.floorPlans.upload(request.user, id, file, body.unitId);
  }
  @Get('floor-plans/:floorPlanId/content')
  @RequirePermissions('properties:read')
  @Header('Cache-Control', 'private, no-store')
  async floorPlanContent(@Req() request: AuthenticatedRequest, @Param('floorPlanId') id: string) {
    const file = await this.floorPlans.content(request.user, id);
    return new StreamableFile(file.bytes, {
      type: file.mimeType,
      disposition: `inline; filename="${file.fileName}"`,
    });
  }
  @Post('floor-plans/:floorPlanId/extract')
  @RequirePermissions('properties:manage')
  extractFloorPlan(@Req() request: AuthenticatedRequest, @Param('floorPlanId') id: string) {
    return this.floorPlans.extract(request.user, id);
  }
  @Get('properties/:propertyId/areas')
  @RequirePermissions('properties:read')
  propertyAreas(@Req() request: AuthenticatedRequest, @Param('propertyId') id: string) {
    return this.floorPlans.areas(request.user, id);
  }
  @Post('properties/:propertyId/areas')
  @RequirePermissions('properties:manage')
  createPropertyArea(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
    @Body() body: CreatePropertyAreaDto,
  ) {
    return this.floorPlans.createArea(request.user, id, body);
  }
  @Post('properties/:propertyId/areas/fallback')
  @RequirePermissions('properties:manage')
  createFallbackPropertyArea(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
  ) {
    return this.floorPlans.createFallbackArea(request.user, id);
  }
  @Patch('property-areas/:areaId')
  @RequirePermissions('properties:manage')
  updatePropertyArea(
    @Req() request: AuthenticatedRequest,
    @Param('areaId') id: string,
    @Body() body: UpdatePropertyAreaDto,
  ) {
    return this.floorPlans.updateArea(request.user, id, body);
  }
  @Delete('property-areas/:areaId')
  @RequirePermissions('properties:manage')
  deletePropertyArea(@Req() request: AuthenticatedRequest, @Param('areaId') id: string) {
    return this.floorPlans.deleteArea(request.user, id);
  }
  @Post('properties/:propertyId/areas/approve')
  @RequirePermissions('properties:manage')
  approvePropertyAreas(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
    @Body() body: ApprovePropertyAreasDto,
  ) {
    return this.floorPlans.approveAreas(request.user, id, body.areaIds);
  }
  @Get('units/:unitId')
  @RequirePermissions('properties:read')
  unit(@Req() request: AuthenticatedRequest, @Param('unitId') id: string) {
    return this.service.unit(request.user, id);
  }
  @Get('units/:unitId/leases')
  @RequirePermissions('properties:read')
  leases(
    @Req() request: AuthenticatedRequest,
    @Param('unitId') id: string,
    @Query() query: LeaseListQueryDto,
  ) {
    return this.service.leases(request.user, id, query);
  }

  @Get('inspections')
  @RequirePermissions('inspections:read')
  inspections(@Req() request: AuthenticatedRequest, @Query() query: InspectionListQueryDto) {
    return this.service.inspections(request.user, query);
  }
  @Post('inspections')
  @RequirePermissions('inspections:manage')
  createInspection(@Req() request: AuthenticatedRequest, @Body() body: CreateAdminInspectionDto) {
    return this.service.createInspection(request.user, body);
  }
  @Get('inspections/:inspectionId')
  @RequirePermissions('inspections:read')
  inspection(@Req() request: AuthenticatedRequest, @Param('inspectionId') id: string) {
    return this.service.inspection(request.user, id);
  }
  @Get('inspections/:inspectionId/media')
  @RequirePermissions('inspections:read')
  inspectionMedia(@Req() request: AuthenticatedRequest, @Param('inspectionId') id: string) {
    return this.service.inspectionMedia(request.user, id);
  }
  @Get('media/:mediaId/content')
  @RequirePermissions('inspections:read')
  @Header('Cache-Control', 'private, no-store')
  async mediaContent(@Req() request: AuthenticatedRequest, @Param('mediaId') id: string) {
    const file = await this.service.mediaContent(request.user, id);
    return new StreamableFile(file.bytes, {
      type: file.mimeType,
      disposition: `inline; filename="${file.fileName}"`,
    });
  }
  @Get('inspections/:inspectionId/findings')
  @RequirePermissions('inspections:read', 'findings:read')
  inspectionFindings(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Query() query: AdminFindingsQueryDto,
  ) {
    return this.service.findings(request.user, id, query);
  }
  @Post('findings/:findingId/approve')
  @RequirePermissions('findings:review')
  approveFinding(
    @Req() request: AuthenticatedRequest,
    @Param('findingId') id: string,
    @Body() body: FindingReviewDto,
  ) {
    return this.service.reviewFinding(request.user, id, 'APPROVED', body.reason);
  }
  @Post('findings/:findingId/reject')
  @RequirePermissions('findings:review')
  rejectFinding(
    @Req() request: AuthenticatedRequest,
    @Param('findingId') id: string,
    @Body() body: FindingRejectDto,
  ) {
    return this.service.reviewFinding(request.user, id, 'REJECTED', body.reason);
  }
  @Post('inspections/:inspectionId/report-shares')
  @RequirePermissions('reports:share')
  createReportShare(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: CreateReportShareDto,
  ) {
    return this.reportShares.createShare(request.user, id, body.recipientEmail);
  }
  @Get('inspections/:inspectionId/report-shares')
  @RequirePermissions('reports:share')
  listReportShares(@Req() request: AuthenticatedRequest, @Param('inspectionId') id: string) {
    return this.reportShares.listShares(request.user, id);
  }
  @Delete('report-shares/:shareId')
  @RequirePermissions('reports:share')
  revokeReportShare(@Req() request: AuthenticatedRequest, @Param('shareId') id: string) {
    return this.reportShares.revokeShare(request.user, id);
  }
  @Get('inspections/:inspectionId/audit')
  @RequirePermissions('inspections:read')
  inspectionAudit(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Query() query: AuditListQueryDto,
  ) {
    return this.service.inspectionAudit(request.user, id, query);
  }
  @Patch('inspections/:inspectionId')
  @RequirePermissions('inspections:manage')
  updateInspection(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: UpdateAdminInspectionDto,
  ) {
    return this.service.updateInspection(request.user, id, body);
  }
  @Post('inspections/:inspectionId/assign')
  @RequirePermissions('inspections:assign')
  assign(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: AssignmentDto,
  ) {
    return this.service.assign(request.user, id, body);
  }
  @Post('inspections/:inspectionId/reassign')
  @RequirePermissions('inspections:assign')
  reassign(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: AssignmentDto,
  ) {
    return this.service.reassign(request.user, id, body);
  }
  @Post('inspections/:inspectionId/unassign')
  @RequirePermissions('inspections:assign')
  unassign(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: UnassignDto,
  ) {
    return this.service.unassign(request.user, id, body);
  }

  @Get('assignments')
  @RequirePermissions('inspections:assign')
  assignments(@Req() request: AuthenticatedRequest, @Query() query: AssignmentListQueryDto) {
    return this.service.assignments(request.user, query);
  }
  @Get('technicians')
  @RequirePermissions('technicians:read')
  technicians(@Req() request: AuthenticatedRequest, @Query() query: TechnicianListQueryDto) {
    return this.service.technicians(request.user, query);
  }
  @Post('technicians')
  @RequirePermissions('technicians:provision')
  createTechnician(@Req() request: AuthenticatedRequest, @Body() body: CreateTechnicianDto) {
    return this.technicianProvisioning.create(request.user, body);
  }
  @Get('technicians/:technicianId')
  @RequirePermissions('technicians:read')
  technician(@Req() request: AuthenticatedRequest, @Param('technicianId') id: string) {
    return this.service.technician(request.user, id);
  }
  @Patch('technicians/:technicianId/status')
  @RequirePermissions('technicians:manage')
  technicianStatus(
    @Req() request: AuthenticatedRequest,
    @Param('technicianId') id: string,
    @Body() body: TechnicianStatusDto,
  ) {
    return this.service.updateTechnicianStatus(request.user, id, body);
  }

  @Get('integrations/providers/status')
  @RequirePermissions('integrations:read')
  providerStatus() {
    return this.service.providerStatus();
  }

  @Get('ai/settings')
  @RequirePermissions('integrations:read')
  aiProviderSettings(@Req() request: AuthenticatedRequest) {
    return this.aiSettings.settings(request.user.organizationId);
  }

  @Patch('ai/settings/routing')
  @RequirePermissions('ai:configure')
  updateAiRouting(@Req() request: AuthenticatedRequest, @Body() body: UpdateAiRoutingDto) {
    return this.aiSettings.setActiveProvider(request.user, body.activeProvider);
  }

  @Patch('ai/providers/:provider')
  @RequirePermissions('ai:configure')
  updateAiProvider(
    @Req() request: AuthenticatedRequest,
    @Param('provider', new ParseEnumPipe(AiProvider)) provider: AiProvider,
    @Body() body: UpdateAiProviderDto,
  ) {
    return this.aiSettings.updateProvider(request.user, provider, body);
  }

  @Post('ai/providers/:provider/validate')
  @RequirePermissions('ai:configure')
  validateAiProvider(
    @Req() request: AuthenticatedRequest,
    @Param('provider', new ParseEnumPipe(AiProvider)) provider: AiProvider,
  ) {
    return this.aiSettings.validateProvider(request.user, provider);
  }

  @Get('cache/status')
  @RequirePermissions('system:manage')
  cacheStatus() {
    return this.cache?.status() ?? { enabled: false, state: 'disabled' };
  }

  @Get('cache/metrics')
  @RequirePermissions('system:manage')
  cacheMetrics() {
    return this.cache?.metricSnapshot() ?? { hits: 0, misses: 0, hitRatio: 0 };
  }

  @Post('cache/invalidate')
  @RequirePermissions('system:manage')
  async invalidateCache(@Req() request: AuthenticatedRequest, @Body() body: CacheInvalidateDto) {
    const scope = body.resource === 'providerReadiness' ? 'global' : request.user.organizationId;
    await this.cacheInvalidation?.invalidate(body.resource, scope, {
      ...(body.query ?? {}),
      ...(body.id ? { id: body.id } : {}),
    });
    return { accepted: true, resource: body.resource };
  }

  @Post('cache/bump-namespace')
  @RequirePermissions('system:manage')
  async bumpCacheNamespace(@Req() request: AuthenticatedRequest, @Body() body: CacheNamespaceDto) {
    const scope = body.namespace === 'providerReadiness' ? 'global' : request.user.organizationId;
    await this.cacheInvalidation?.bump(body.namespace, scope);
    return { accepted: true, namespace: body.namespace };
  }
}
