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
  Put,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AiProvider, InspectionType } from '@prisma/client';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import {
  ApiAuthGuard,
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedRequest,
} from '../common/auth';
import { CacheInvalidateDto, CacheNamespaceDto } from '../cache/cache-admin.dto';
import { PasswordResetService } from '../auth/password-reset.service';
import { InspectionImportService } from './inspection-import/inspection-import.service';
import type { UploadedReport } from './inspection-import/inspection-import.service';
import { AccessService } from './access.service';
import { RouteService } from '../routing/route.service';
import { PropertyGeocodingService } from './property-geocoding.service';
import { TechnicianLocationService } from '../technician/technician-location.service';
import { CacheInvalidationService } from '../cache/cache-invalidation.service';
import { CacheService } from '../cache/cache.service';
import { MailService } from '../mail/mail.service';
import {
  AdminFindingsQueryDto,
  ApprovePropertyAreasDto,
  AreaComparisonOverrideDto,
  AssignmentDto,
  AssignmentListQueryDto,
  AuditListQueryDto,
  ChargeReviewDto,
  ChargeRuleDto,
  ComparisonReviewDto,
  CommitInspectionImportDto,
  CreateAdminInspectionDto,
  AdminChecklistAssessmentDto,
  CreateAreaChecklistItemDto,
  CreateChargeDto,
  CreateEvidenceRequestDto,
  CreatePropertyAreaDto,
  CreateReportShareDto,
  CreateTechnicianDto,
  DeleteInspectionsDto,
  DeletePropertyAreasDto,
  CompleteInspectionDto,
  FinalizeInspectionDto,
  FindingRejectDto,
  FindingReviewDto,
  InspectionFollowUpDto,
  InspectionListQueryDto,
  InspectionTbdDto,
  InspectionUnderReviewDto,
  LeaseListQueryDto,
  AddInspectionAreasDto,
  MergeInspectionAreasDto,
  PetCandidateReviewDto,
  PortfolioListQueryDto,
  PropertyListQueryDto,
  TenantListQueryDto,
  RejectPropertyAreaDto,
  ReopenInspectionDto,
  GrantTechnicianSkillDto,
  RevokeTechnicianSkillDto,
  SetSkillRequirementDto,
  SkillCatalogQueryDto,
  TechnicianListQueryDto,
  TechnicianSkillDto,
  UpdateTechnicianSkillDto,
  TechnicianStatusDto,
  TestMailDto,
  UnassignDto,
  UnitListQueryDto,
  UpdateAdminInspectionDto,
  UpdateAiProviderDto,
  UpdateAiRoutingDto,
  UpdateAreaChecklistItemDto,
  UpdateAreaMarkerDto,
  UpdatePropertyAreaDto,
  UploadFloorPlanDto,
} from './admin.dto';
import { AdminService } from './admin.service';
import { AiProviderSettingsService } from './ai-provider-settings.service';
import { ChargeService } from './charge.service';
import { ComparisonReportService } from './comparison-report.service';
import { ComparisonService } from './comparison.service';
import { FloorPlanAdminService, type UploadedFloorPlan } from './floor-plan-admin.service';
import { AreaEvidenceService } from './area-evidence.service';
import { ProfileDeletionService } from './profile-deletion.service';
import { ReportShareService } from './report-share.service';
import { TechnicianProvisioningService } from './technician-provisioning.service';
import { TechnicianSkillsService } from './technician-skills.service';
import type { ComparisonClassification } from '@prisma/client';

/**
 * The map's two feeds are tagged separately from the rest of this controller.
 *
 * The API reference groups by tag, and a reader looking for "where do the map
 * pins come from" should not have to know they are served by AdminController
 * alongside ninety-six other routes. The tag is per-handler rather than a new
 * controller because that is all this needs: the routes belong here, only their
 * *documentation* wants its own heading.
 */
export const CONSOLE_MAP_TAG = 'Console map';

/**
 * The other groupings worth pulling out of this controller.
 *
 * `Administrator application` is where every console route lands by default,
 * and at ninety-odd entries it stops being a category and becomes a haystack.
 * These three are coherent bodies of work a reader arrives looking for, so they
 * get headings of their own — again per-handler, because the routes belong here
 * and only their documentation wants separating.
 */
export const FLOOR_PLAN_TAG = 'Floor plans';
export const AREA_EVIDENCE_TAG = 'Area evidence';
export const CHARGES_TAG = 'Charges';
export const INSPECTION_IMPORT_TAG = 'Inspection imports';

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
    private readonly comparison: ComparisonService,
    private readonly comparisonReport: ComparisonReportService,
    private readonly locations: TechnicianLocationService,
    private readonly propertyGeocoding: PropertyGeocodingService,
    private readonly passwordResets: PasswordResetService,
    private readonly inspectionImports: InspectionImportService,
    private readonly routes: RouteService,
    private readonly areaEvidence: AreaEvidenceService,
    private readonly charges: ChargeService,
    private readonly mailer: MailService,
    private readonly profileDeletion: ProfileDeletionService,
    private readonly access: AccessService,
    private readonly skills: TechnicianSkillsService,
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
  /** Tenancies from the office report, including benefit-package enrolment. */
  @Get('tenants')
  @RequirePermissions('properties:read')
  tenants(@Req() request: AuthenticatedRequest, @Query() query: TenantListQueryDto) {
    return this.service.tenants(request.user, query);
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
  @Get('properties/:propertyId/lease-summary')
  @RequirePermissions('properties:read')
  leaseSummary(@Req() request: AuthenticatedRequest, @Param('propertyId') id: string) {
    return this.service.propertyLeaseSummary(request.user, id);
  }
  @Get('properties/:propertyId/area-summary')
  @RequirePermissions('properties:read')
  areaSummary(@Req() request: AuthenticatedRequest, @Param('propertyId') id: string) {
    return this.service.propertyAreaSummary(request.user, id);
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
  @ApiTags(FLOOR_PLAN_TAG)
  @RequirePermissions('properties:read')
  floorPlanList(@Req() request: AuthenticatedRequest, @Param('propertyId') id: string) {
    return this.floorPlans.list(request.user, id);
  }
  @Post('properties/:propertyId/floor-plans')
  @ApiTags(FLOOR_PLAN_TAG)
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
  /**
   * Read an inspection done outside this app, from the PDF it produced.
   *
   * Two steps, because the parser will not guess: the read reports what a
   * person should look at -- a label the templates do not carry, a row the
   * inspector typed by hand, a photograph whose caption did not resolve -- and
   * a separate call writes it.
   *
   * Imported *into* an inspection that already exists. Jobber creates the
   * move-in when the visit completes, so the record is here with nothing in
   * it — the walk happened, the evidence went to another system. This puts the
   * evidence back, which is why there is no route that creates one.
   *
   * Behind `inspections:manage`, the key for editing an inspection, because
   * that is exactly what this does.
   *
   * The size limit is well above the floor-plan route's. These reports carry a
   * photograph of every wall -- the one this was built against is 73 MB across
   * 376 of them -- and refusing at 20 MB would refuse nearly all of them.
   */
  /**
   * Start reading one, and answer before it has been read.
   *
   * The response is a job id. A 48-page report with 376 photographs takes
   * longer than a browser will wait, and holding the request open is how
   * floor-plan extraction used to fail -- the handler finished and logged
   * success while the caller saw an empty response. Closing the tab now costs
   * nothing; the reading continues and the job is still there afterwards.
   */
  @Post('inspections/:inspectionId/inspection-imports')
  @ApiTags(INSPECTION_IMPORT_TAG)
  @RequirePermissions('inspections:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 150_000_000, files: 1 } }))
  startInspectionImport(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @UploadedFile() file?: UploadedReport,
  ) {
    return this.inspectionImports.start(request.user, id, file);
  }

  /**
   * The import attached to this inspection, or null.
   *
   * Lets a page that did not start the import still show it. Without this the
   * job id existed only inside the dialog that created it, so closing the
   * dialog looked like abandoning the work even though both phases run
   * detached and finish regardless.
   */
  @Get('inspections/:inspectionId/inspection-import')
  @ApiTags(INSPECTION_IMPORT_TAG)
  @RequirePermissions('inspections:manage')
  activeInspectionImport(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
  ) {
    return this.inspectionImports.activeJob(request.user, id);
  }

  /**
   * Every import still working, anywhere in the organization.
   *
   * Declared before `:jobId` on purpose — Nest matches routes in order, and a
   * parameter segment would otherwise swallow `running` and look it up as a
   * job id.
   */
  @Get('inspection-imports/running')
  @ApiTags(INSPECTION_IMPORT_TAG)
  @RequirePermissions('inspections:manage')
  runningInspectionImports(@Req() request: AuthenticatedRequest) {
    return this.inspectionImports.runningJobs(request.user);
  }

  /** Progress, and the parsed report once there is one. Polled by the console. */
  @Get('inspection-imports/:jobId')
  @ApiTags(INSPECTION_IMPORT_TAG)
  @RequirePermissions('inspections:manage')
  inspectionImportJob(@Req() request: AuthenticatedRequest, @Param('jobId') id: string) {
    return this.inspectionImports.job(request.user, id);
  }

  /** Write the read report in, once somebody has looked at what it found. */
  @Post('inspection-imports/:jobId/commit')
  @ApiTags(INSPECTION_IMPORT_TAG)
  @RequirePermissions('inspections:manage')
  commitInspectionImport(
    @Req() request: AuthenticatedRequest,
    @Param('jobId') id: string,
    @Body() body: CommitInspectionImportDto,
  ) {
    return this.inspectionImports.commit(request.user, id, body.mode);
  }

  @Get('floor-plans/:floorPlanId/content')
  @ApiTags(FLOOR_PLAN_TAG)
  @RequirePermissions('properties:read')
  @Header('Cache-Control', 'private, no-store')
  async floorPlanContent(@Req() request: AuthenticatedRequest, @Param('floorPlanId') id: string) {
    const file = await this.floorPlans.content(request.user, id);
    return new StreamableFile(file.bytes, {
      type: file.mimeType,
      disposition: `inline; filename="${file.fileName}"`,
    });
  }
  /** Poll target for the extraction started by POST .../extract. */
  @Get('floor-plans/:floorPlanId/extraction-jobs/:jobId')
  @ApiTags(FLOOR_PLAN_TAG)
  @RequirePermissions('properties:manage')
  floorPlanExtractionJob(
    @Req() request: AuthenticatedRequest,
    @Param('floorPlanId') floorPlanId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.floorPlans.extractionJob(request.user, floorPlanId, jobId);
  }
  @Post('floor-plans/:floorPlanId/extract')
  @ApiTags(FLOOR_PLAN_TAG)
  @RequirePermissions('properties:manage')
  extractFloorPlan(@Req() request: AuthenticatedRequest, @Param('floorPlanId') id: string) {
    return this.floorPlans.extract(request.user, id);
  }
  @Post('floor-plans/:floorPlanId/retry-missing-markers')
  @ApiTags(FLOOR_PLAN_TAG)
  @RequirePermissions('properties:manage')
  retryMissingMarkers(@Req() request: AuthenticatedRequest, @Param('floorPlanId') id: string) {
    return this.floorPlans.retryMissingMarkers(request.user, id);
  }
  // Coverage checklist for one area. Read is `properties:read` because a
  // supervisor may need to see what technicians are asked to cover without
  // being able to change it.
  @Get('property-areas/:areaId/checklist')
  @RequirePermissions('properties:read')
  areaChecklist(@Req() request: AuthenticatedRequest, @Param('areaId') id: string) {
    return this.floorPlans.areaChecklist(request.user, id);
  }
  /**
   * The short list an occupied visit asks instead of the room checklist above.
   *
   * Not addressed by area, because it is not stored by area: it is the same two
   * questions in every room, held once for the organization with a null area.
   * The route above therefore cannot return it — it matches on
   * `propertyAreaId` — and until this existed the console showed the room list
   * as though it were the only one, which is exactly how a reader concluded an
   * occupied visit still asks nine questions about a bathroom.
   *
   * Read-only on purpose. Editing one organization-wide list from a dialog
   * titled after a single area would let somebody change every property while
   * believing they had changed one room.
   */
  @Get('checklists/occupied')
  @RequirePermissions('properties:read')
  occupiedChecklist(@Req() request: AuthenticatedRequest) {
    return this.floorPlans.occupiedChecklist(request.user);
  }
  @Post('property-areas/:areaId/checklist')
  @RequirePermissions('properties:manage')
  createChecklistItem(
    @Req() request: AuthenticatedRequest,
    @Param('areaId') id: string,
    @Body() body: CreateAreaChecklistItemDto,
  ) {
    return this.floorPlans.createChecklistItem(request.user, id, body);
  }
  @Patch('checklist-items/:itemId')
  @RequirePermissions('properties:manage')
  updateChecklistItem(
    @Req() request: AuthenticatedRequest,
    @Param('itemId') id: string,
    @Body() body: UpdateAreaChecklistItemDto,
  ) {
    return this.floorPlans.updateChecklistItem(request.user, id, body);
  }
  @Delete('checklist-items/:itemId')
  @RequirePermissions('properties:manage')
  archiveChecklistItem(@Req() request: AuthenticatedRequest, @Param('itemId') id: string) {
    return this.floorPlans.archiveChecklistItem(request.user, id);
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
  @Patch('property-areas/:areaId/marker')
  @ApiTags(FLOOR_PLAN_TAG)
  @RequirePermissions('properties:manage')
  updateAreaMarker(
    @Req() request: AuthenticatedRequest,
    @Param('areaId') id: string,
    @Body() body: UpdateAreaMarkerDto,
  ) {
    return this.floorPlans.updateAreaMarker(request.user, id, body);
  }
  /**
   * `properties:delete-areas` rather than `properties:manage`.
   *
   * Managing a layout means correcting it; this erases part of it, and there is
   * no restore. An area any inspection has used is refused outright, so what
   * this reaches is the plan future inspections are copied from — which is
   * exactly what somebody clearing mock areas needs and exactly what nobody
   * else should hold. Archive stays on `properties:manage`: it hides an area
   * without destroying it.
   */
  @Delete('property-areas/:areaId')
  @RequirePermissions('properties:delete-areas')
  deletePropertyArea(@Req() request: AuthenticatedRequest, @Param('areaId') id: string) {
    return this.floorPlans.deleteArea(request.user, id);
  }
  @Post('property-areas/:areaId/reject')
  @RequirePermissions('properties:manage')
  rejectPropertyArea(
    @Req() request: AuthenticatedRequest,
    @Param('areaId') id: string,
    @Body() body: RejectPropertyAreaDto,
  ) {
    return this.floorPlans.rejectArea(request.user, id, body.reason);
  }
  @Post('property-areas/:areaId/archive')
  @RequirePermissions('properties:manage')
  archivePropertyArea(@Req() request: AuthenticatedRequest, @Param('areaId') id: string) {
    return this.floorPlans.archiveArea(request.user, id);
  }
  /** Same permission as the single delete, and for the same reason. */
  @Post('properties/:propertyId/areas/delete')
  @RequirePermissions('properties:delete-areas')
  deletePropertyAreas(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
    @Body() body: DeletePropertyAreasDto,
  ) {
    return this.floorPlans.deleteAreas(request.user, id, body.areaIds);
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
  @Get('media/:mediaId/playback')
  @RequirePermissions('inspections:read')
  mediaPlayback(@Req() request: AuthenticatedRequest, @Param('mediaId') id: string) {
    return this.service.mediaPlaybackUrl(request.user, id);
  }
  @Get('inspections/:inspectionId/photos')
  @RequirePermissions('inspections:read')
  inspectionPhotos(@Req() request: AuthenticatedRequest, @Param('inspectionId') id: string) {
    return this.service.inspectionPhotos(request.user, id);
  }
  @Get('photos/:photoId/content')
  @RequirePermissions('inspections:read')
  @Header('Cache-Control', 'private, no-store')
  async photoContent(
    @Req() request: AuthenticatedRequest,
    @Param('photoId') id: string,
    /** Bounded gallery variant; omit for the full-resolution original. */
    @Query('w') width?: string,
  ) {
    const file = await this.service.photoContent(
      request.user,
      id,
      width ? Number(width) : undefined,
    );
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
  /**
   * Close an inspection the technician never submitted.
   *
   * `inspections:finalize` rather than `:manage`, because this is the same
   * class of decision as finalizing — it ends the work — even though it
   * deliberately does not freeze the evidence.
   */
  @Post('inspections/:inspectionId/complete')
  @RequirePermissions('inspections:finalize')
  completeInspection(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: CompleteInspectionDto,
  ) {
    return this.service.completeInspection(request.user, id, body);
  }
  @Post('inspections/:inspectionId/finalize')
  @RequirePermissions('inspections:finalize')
  finalizeInspection(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: FinalizeInspectionDto,
  ) {
    return this.service.finalizeInspection(request.user, id, body);
  }
  @Post('inspections/:inspectionId/mark-tbd')
  @RequirePermissions('inspections:manage')
  markInspectionTbd(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: InspectionTbdDto,
  ) {
    return this.service.markInspectionTbd(request.user, id, body);
  }
  @Post('inspections/:inspectionId/require-follow-up')
  @RequirePermissions('inspections:manage')
  requireInspectionFollowUp(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: InspectionFollowUpDto,
  ) {
    return this.service.requireInspectionFollowUp(request.user, id, body);
  }
  @Post('inspections/:inspectionId/under-review')
  @RequirePermissions('inspections:manage')
  markInspectionUnderReview(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: InspectionUnderReviewDto,
  ) {
    return this.service.markInspectionUnderReview(request.user, id, body);
  }
  /**
   * Gated on `inspections:finalize`, not `inspections:manage`, because this can
   * reverse a finalization. The permission that closes an inspection is the one
   * that may reopen it.
   */
  /**
   * Ask the technician for more evidence in one area.
   *
   * `inspections:manage`, not `inspections:finalize`: this sends work back to
   * the field, which is ordinary review traffic — it does not reverse a
   * finalization the way reopen can.
   */
  @Post('inspections/:inspectionId/evidence-requests')
  @ApiTags(AREA_EVIDENCE_TAG)
  @RequirePermissions('inspections:manage')
  createEvidenceRequest(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: CreateEvidenceRequestDto,
  ) {
    return this.service.createEvidenceRequest(request.user, id, body);
  }
  @Get('inspections/:inspectionId/evidence-requests')
  @ApiTags(AREA_EVIDENCE_TAG)
  @RequirePermissions('inspections:read')
  evidenceRequests(@Req() request: AuthenticatedRequest, @Param('inspectionId') id: string) {
    return this.service.evidenceRequests(request.user, id);
  }
  @Delete('evidence-requests/:requestId')
  @ApiTags(AREA_EVIDENCE_TAG)
  @RequirePermissions('inspections:manage')
  cancelEvidenceRequest(@Req() request: AuthenticatedRequest, @Param('requestId') id: string) {
    return this.service.cancelEvidenceRequest(request.user, id);
  }
  @Post('inspections/:inspectionId/reopen')
  @RequirePermissions('inspections:finalize')
  reopenInspection(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: ReopenInspectionDto,
  ) {
    return this.service.reopenInspection(request.user, id, body);
  }
  /**
   * Area-first evidence index: counts and status for every area, no media.
   * The review screen loads this first and fetches one area's evidence on open.
   */
  @Get('inspections/:inspectionId/area-evidence-summary')
  @ApiTags(AREA_EVIDENCE_TAG)
  @RequirePermissions('inspections:read')
  areaEvidenceSummary(@Req() request: AuthenticatedRequest, @Param('inspectionId') id: string) {
    return this.areaEvidence.summary(request.user, id);
  }
  @Get('inspections/:inspectionId/areas/:areaId/evidence')
  @ApiTags(AREA_EVIDENCE_TAG)
  @RequirePermissions('inspections:read')
  areaEvidenceDetail(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') inspectionId: string,
    @Param('areaId') areaId: string,
  ) {
    return this.areaEvidence.areaEvidence(request.user, inspectionId, areaId);
  }
  @Get('inspections/:inspectionId/areas')
  @RequirePermissions('inspections:read')
  inspectionAreas(@Req() request: AuthenticatedRequest, @Param('inspectionId') id: string) {
    return this.service.inspectionAreas(request.user, id);
  }
  /**
   * Records how one checklist item was found, during review.
   *
   * `inspections:manage` rather than `:read`, because this writes to the record
   * the report prints from. PUT, not PATCH: the body is the item's complete
   * assessment, so clearing a control clears it on the server.
   */
  @Put('inspections/:inspectionId/areas/:areaId/checklist/:itemId')
  @RequirePermissions('inspections:manage')
  recordAreaChecklistItem(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') inspectionId: string,
    @Param('areaId') areaId: string,
    @Param('itemId') itemId: string,
    @Body() body: AdminChecklistAssessmentDto,
  ) {
    return this.areaEvidence.recordChecklistItem(request.user, inspectionId, areaId, itemId, body);
  }
  /**
   * Adds approved property areas to an inspection already under way.
   *
   * `inspections:manage`, the same permission as assigning and reopening: this
   * changes what a technician is expected to walk, which is the same kind of
   * decision. `inspections:read` would let anyone who can view the queue add
   * work to someone else's day.
   */
  @Post('inspections/:inspectionId/areas')
  @RequirePermissions('inspections:manage')
  addInspectionAreas(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: AddInspectionAreasDto,
  ) {
    return this.service.addInspectionAreas(request.user, id, body);
  }
  @Post('inspections/:inspectionId/merge-areas')
  @RequirePermissions('inspections:manage')
  mergeInspectionAreas(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: MergeInspectionAreasDto,
  ) {
    return this.service.mergeInspectionAreas(request.user, id, body);
  }
  @Get('inspections/:inspectionId/comparison')
  @RequirePermissions('inspections:read')
  inspectionComparison(@Req() request: AuthenticatedRequest, @Param('inspectionId') id: string) {
    return this.comparison.get(request.user, id);
  }
  /**
   * The comparison as a printable document: both inspections side by side.
   *
   * Same permission as reading the comparison itself -- it is the same
   * information, laid out for a person rather than a list.
   */
  @Get('inspections/:inspectionId/comparison-report')
  @RequirePermissions('inspections:read')
  inspectionComparisonReport(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
  ) {
    return this.comparisonReport.report(request.user, id);
  }
  @Post('inspections/:inspectionId/comparison/generate')
  @RequirePermissions('inspections:manage')
  generateInspectionComparison(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
  ) {
    return this.comparison.generate(id, {
      organizationId: request.user.organizationId,
      userId: request.user.id,
    });
  }
  @Post('comparisons/:comparisonId/review')
  @RequirePermissions('comparisons:review')
  reviewComparison(
    @Req() request: AuthenticatedRequest,
    @Param('comparisonId') id: string,
    @Body() body: ComparisonReviewDto,
  ) {
    return this.comparison.review(request.user, id, body.decision, body.note);
  }
  @Post('area-comparisons/:areaComparisonId/override')
  @RequirePermissions('comparisons:review')
  overrideAreaComparison(
    @Req() request: AuthenticatedRequest,
    @Param('areaComparisonId') id: string,
    @Body() body: AreaComparisonOverrideDto,
  ) {
    return this.comparison.overrideArea(
      request.user,
      id,
      body.classification as ComparisonClassification,
      body.reason,
    );
  }
  @Get('charge-rules')
  @ApiTags(CHARGES_TAG)
  @RequirePermissions('charges:review')
  chargeRules(@Req() request: AuthenticatedRequest) {
    return this.charges.listRules(request.user);
  }
  @Post('charge-rules')
  @ApiTags(CHARGES_TAG)
  @RequirePermissions('charges:configure')
  upsertChargeRule(@Req() request: AuthenticatedRequest, @Body() body: ChargeRuleDto) {
    return this.charges.upsertRule(request.user, body);
  }
  @Get('inspections/:inspectionId/pets')
  @ApiTags(CHARGES_TAG)
  @RequirePermissions('charges:review')
  inspectionPets(@Req() request: AuthenticatedRequest, @Param('inspectionId') id: string) {
    return this.charges.listPets(request.user, id);
  }
  @Post('inspections/:inspectionId/pets/generate')
  @ApiTags(CHARGES_TAG)
  @RequirePermissions('charges:review')
  generatePetCandidates(@Req() request: AuthenticatedRequest, @Param('inspectionId') id: string) {
    return this.charges.generateCandidates(request.user, id);
  }
  @Post('pet-candidates/:candidateId/review')
  @ApiTags(CHARGES_TAG)
  @RequirePermissions('charges:review')
  reviewPetCandidate(
    @Req() request: AuthenticatedRequest,
    @Param('candidateId') id: string,
    @Body() body: PetCandidateReviewDto,
  ) {
    return this.charges.reviewCandidate(request.user, id, body);
  }
  @Get('inspections/:inspectionId/charges')
  @ApiTags(CHARGES_TAG)
  @RequirePermissions('charges:review')
  inspectionCharges(@Req() request: AuthenticatedRequest, @Param('inspectionId') id: string) {
    return this.charges.listCharges(request.user, id);
  }
  @Post('inspections/:inspectionId/charges/generate')
  @ApiTags(CHARGES_TAG)
  @RequirePermissions('charges:review')
  generateCharges(@Req() request: AuthenticatedRequest, @Param('inspectionId') id: string) {
    return this.charges.generateCharges(request.user, id);
  }
  @Post('inspections/:inspectionId/charges')
  @ApiTags(CHARGES_TAG)
  @RequirePermissions('charges:review')
  createCharge(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: CreateChargeDto,
  ) {
    return this.charges.createCharge(request.user, id, body);
  }
  @Post('charges/:chargeId/review')
  @ApiTags(CHARGES_TAG)
  @RequirePermissions('charges:review')
  reviewCharge(
    @Req() request: AuthenticatedRequest,
    @Param('chargeId') id: string,
    @Body() body: ChargeReviewDto,
  ) {
    return this.charges.reviewCharge(request.user, id, body);
  }
  @Get('inspections/:inspectionId/charge-report')
  @ApiTags(CHARGES_TAG)
  @RequirePermissions('charges:review')
  chargeReport(@Req() request: AuthenticatedRequest, @Param('inspectionId') id: string) {
    return this.charges.report(request.user, id);
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

  /**
   * Every technician's most recent position, for the map.
   *
   * Behind `technicians:locate`, not `technicians:read`. The same argument that
   * separated this from `inspections:read` applies one step further in: "see the
   * technician directory" and "watch where a named employee is right now" are
   * different decisions, and bundling them meant granting the first silently
   * granted the second.
   */
  @Get('technician-locations')
  @ApiTags(CONSOLE_MAP_TAG)
  @RequirePermissions('technicians:locate')
  technicianLocations(@Req() request: AuthenticatedRequest) {
    return this.locations.latestPositions(request.user);
  }

  /**
   * Every property that has been placed on the map.
   *
   * Behind `properties:read`, the same grant that lists them anywhere else: a
   * property's location is part of the property, not a separate secret, and it
   * is on the tenancy agreement long before it reaches this console.
   */
  @Get('property-locations')
  @ApiTags(CONSOLE_MAP_TAG)
  @RequirePermissions('properties:read')
  propertyLocations(@Req() request: AuthenticatedRequest) {
    return this.propertyGeocoding.positions(request.user);
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
  /**
   * Mail a technician a password reset link.
   *
   * Behind `technicians:provision` — the permission that already covers
   * issuing a technician their first temporary password. A reset link is the
   * same act performed again, so it belongs with that rather than with
   * `technicians:manage`, which is about activating and deactivating people.
   */
  /**
   * Let this technician into the console as well.
   *
   * Behind `users:manage`, not `technicians:provision`. The button lives on the
   * technician page, but the act is creating console access for somebody — the
   * same decision `POST /admin/access/users` makes, and it must not be reachable
   * by a permission that only covers issuing handset credentials.
   *
   * Grants the membership and no roles, so the person can sign in and do
   * nothing until an administrator assigns some. That second step is what
   * `users:manage` normally guards, and it stays guarded.
   */
  @Post('technicians/:technicianId/console-access')
  @RequirePermissions('users:manage')
  grantTechnicianConsoleAccess(
    @Req() request: AuthenticatedRequest,
    @Param('technicianId') id: string,
  ) {
    return this.access.grantConsoleAccess(request.user, id);
  }

  @Post('technicians/:technicianId/password-reset')
  @RequirePermissions('technicians:provision')
  sendTechnicianPasswordReset(
    @Req() request: AuthenticatedRequest,
    @Param('technicianId') id: string,
  ) {
    return this.passwordResets.sendForTechnician(request.user, id);
  }

  /**
   * A technician's day, ordered from where they are now.
   *
   * `technicians:locate`, the same key as the map: this reads a named person's
   * live position to decide where the route starts.
   *
   * `date` defaults to today. The schema stores a calendar day and no clock
   * value, so there is no narrower window to ask for.
   */
  /**
   * Who is working today and which properties are theirs, for the map panel.
   *
   * `technicians:read`, the same key as the map itself: this says where named
   * people are expected to be, which is a fact about them.
   */
  @Get('map/assignments')
  @RequirePermissions('technicians:read')
  mapAssignments(@Req() request: AuthenticatedRequest, @Query('date') date?: string) {
    const day = date ? new Date(date) : new Date();
    return this.routes.assignmentsByTechnician(
      request.user.organizationId,
      Number.isNaN(day.getTime()) ? new Date() : day,
    );
  }

  @Get('technicians/:technicianId/route')
  @RequirePermissions('technicians:locate')
  technicianRoute(
    @Req() request: AuthenticatedRequest,
    @Param('technicianId') id: string,
    @Query('date') date?: string,
  ) {
    const day = date ? new Date(date) : new Date();
    return this.routes.planDay(
      request.user.organizationId,
      id,
      Number.isNaN(day.getTime()) ? new Date() : day,
    );
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

  /**
   * What deleting this technician would cost. The ongoing-inspection count
   * drives the confirmation: those are released back to the unassigned pool,
   * and an administrator should know how many before agreeing to it.
   */
  @Get('technicians/:technicianId/deletion-preflight')
  @RequirePermissions('technicians:manage')
  technicianDeletionPreflight(
    @Req() request: AuthenticatedRequest,
    @Param('technicianId') id: string,
  ) {
    return this.profileDeletion.preflight(request.user, id, 'TECHNICIAN');
  }

  @Delete('technicians/:technicianId')
  @RequirePermissions('technicians:manage')
  deleteTechnician(@Req() request: AuthenticatedRequest, @Param('technicianId') id: string) {
    return this.profileDeletion.remove(request.user, id, 'TECHNICIAN');
  }

  /**
   * What technicians are qualified to do.
   *
   * Reading is `technicians:read` — a skill is part of the directory entry, and
   * anyone who may see who the technicians are may see what they do. Changing
   * one is `technicians:skills`, its own grant, because these decide who
   * scheduling is allowed to send to a job: quietly granting somebody a skill
   * puts them on work nobody chose them for.
   */
  @Get('technician-skills')
  @RequirePermissions('technicians:read')
  skillCatalog(@Req() request: AuthenticatedRequest, @Query() query: SkillCatalogQueryDto) {
    return this.skills.catalog(request.user, query.includeInactive === 'true');
  }

  @Post('technician-skills')
  @RequirePermissions('technicians:skills')
  createSkill(@Req() request: AuthenticatedRequest, @Body() body: TechnicianSkillDto) {
    return this.skills.createSkill(request.user, body);
  }

  @Patch('technician-skills/:skillId')
  @RequirePermissions('technicians:skills')
  updateSkill(
    @Req() request: AuthenticatedRequest,
    @Param('skillId') skillId: string,
    @Body() body: UpdateTechnicianSkillDto,
  ) {
    return this.skills.updateSkill(request.user, skillId, body);
  }

  @Get('technicians/:technicianId/skills')
  @RequirePermissions('technicians:read')
  technicianSkills(@Req() request: AuthenticatedRequest, @Param('technicianId') id: string) {
    return this.skills.technicianSkills(request.user, id);
  }

  @Post('technicians/:technicianId/skills')
  @RequirePermissions('technicians:skills')
  grantTechnicianSkill(
    @Req() request: AuthenticatedRequest,
    @Param('technicianId') id: string,
    @Body() body: GrantTechnicianSkillDto,
  ) {
    return this.skills.grant(request.user, id, body);
  }

  @Delete('technicians/:technicianId/skills/:skillId')
  @RequirePermissions('technicians:skills')
  revokeTechnicianSkill(
    @Req() request: AuthenticatedRequest,
    @Param('technicianId') id: string,
    @Param('skillId') skillId: string,
    @Body() body: RevokeTechnicianSkillDto,
  ) {
    return this.skills.revoke(request.user, id, skillId, body?.reason);
  }

  @Get('skill-requirements')
  @RequirePermissions('technicians:read')
  skillRequirements(@Req() request: AuthenticatedRequest) {
    return this.skills.requirements(request.user);
  }

  @Put('skill-requirements')
  @RequirePermissions('technicians:skills')
  setSkillRequirement(@Req() request: AuthenticatedRequest, @Body() body: SetSkillRequirementDto) {
    return this.skills.setRequirement(request.user, body);
  }

  @Delete('skill-requirements/:inspectionType/:skillId')
  @RequirePermissions('technicians:skills')
  removeSkillRequirement(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionType', new ParseEnumPipe(InspectionType)) inspectionType: InspectionType,
    @Param('skillId') skillId: string,
  ) {
    return this.skills.removeRequirement(request.user, inspectionType, skillId);
  }

  /**
   * Permanently erase an inspection and all of its evidence.
   *
   * `inspections:delete` rather than `inspections:manage`: managing means
   * editing and cancelling, and cancelling is the reversible way to close an
   * inspection. This one cannot be undone, so it is grantable separately.
   */
  @Delete('inspections/:inspectionId')
  @RequirePermissions('inspections:delete')
  deleteInspection(@Req() request: AuthenticatedRequest, @Param('inspectionId') id: string) {
    return this.service.deleteInspection(request.user, id);
  }

  /**
   * Bulk erase.
   *
   * POST with the ids in the body rather than DELETE, matching
   * `properties/:propertyId/areas/delete` above: a DELETE carrying a body is
   * poorly supported by proxies and by `fetch`.
   *
   * `inspections/delete` cannot be shadowed by a route parameter — every other
   * POST under `inspections` carries a second segment (`/finalize`, `/assign`,
   * `/reopen`), so none of them matches a single-segment path.
   */
  @Post('inspections/delete')
  @RequirePermissions('inspections:delete')
  deleteInspections(@Req() request: AuthenticatedRequest, @Body() body: DeleteInspectionsDto) {
    return this.service.deleteInspections(request.user, body.inspectionIds);
  }

  @Get('integrations/providers/status')
  @RequirePermissions('integrations:read')
  providerStatus() {
    return this.service.providerStatus();
  }

  @Post('integrations/mail/test')
  @RequirePermissions('integrations:manage')
  testMail(@Body() body: TestMailDto) {
    return this.mailer.sendTest(body.recipientEmail.trim().toLowerCase());
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
