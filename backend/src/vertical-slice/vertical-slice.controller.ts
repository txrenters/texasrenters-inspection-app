/* DTO classes and injection tokens are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@texasrenters/shared';

import { ApiAuthGuard, Roles, RolesGuard, type AuthenticatedRequest } from '../common/auth';
import {
  AreaOrderDto,
  CreateAreaDto,
  CreateInspectionDto,
  CreatePropertyDto,
  ReasonDto,
  RegisterFloorPlanDto,
  RegisterMediaDto,
  UpdateAreaDto,
  UpdateFindingDto,
  UpdatePropertyDto,
  UploadSessionDto,
} from './dto';
import { VerticalSliceService } from './vertical-slice.service';

const PROPERTY_MANAGERS = [
  UserRole.SYSTEM_ADMIN,
  UserRole.PROPERTY_ADMIN,
  UserRole.INSPECTION_SUPERVISOR,
];

@ApiTags('mock vertical slice')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, RolesGuard)
@Controller()
export class VerticalSliceController {
  constructor(@Inject(VerticalSliceService) private readonly service: VerticalSliceService) {}

  @Get('auth/me') me(@Req() request: AuthenticatedRequest) {
    return this.service.me(request.user);
  }

  @Post('properties')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.PROPERTY_ADMIN)
  createProperty(@Req() request: AuthenticatedRequest, @Body() body: CreatePropertyDto) {
    return this.service.createProperty(request.user, body);
  }
  @Patch('properties/:propertyId')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.PROPERTY_ADMIN)
  updateProperty(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
    @Body() body: UpdatePropertyDto,
  ) {
    return this.service.updateProperty(request.user, id, body);
  }

  @Post('properties/:propertyId/floor-plans')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.PROPERTY_ADMIN)
  @ApiOperation({ summary: 'Register a validated private floor-plan file' })
  registerFloorPlan(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
    @Body() body: RegisterFloorPlanDto,
  ) {
    return this.service.registerFloorPlan(request.user, id, body);
  }
  @Get('properties/:propertyId/floor-plans') listFloorPlans(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
  ) {
    return this.service.listFloorPlans(request.user, id);
  }
  @Post('floor-plans/:floorPlanId/extraction-jobs')
  @Roles(...PROPERTY_MANAGERS)
  extractFloorPlan(@Req() request: AuthenticatedRequest, @Param('floorPlanId') id: string) {
    return this.service.extractFloorPlan(request.user, id);
  }
  @Get('floor-plan-extraction-jobs/:jobId') getExtractionJob(@Param('jobId') id: string) {
    return this.service.getExtractionJob(id);
  }

  @Get('properties/:propertyId/areas') listAreas(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
  ) {
    return this.service.listAreas(request.user, id);
  }
  @Post('properties/:propertyId/areas')
  @Roles(...PROPERTY_MANAGERS)
  createArea(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
    @Body() body: CreateAreaDto,
  ) {
    return this.service.createArea(request.user, id, body);
  }
  @Patch('property-areas/:areaId')
  @Roles(...PROPERTY_MANAGERS)
  updateArea(
    @Req() request: AuthenticatedRequest,
    @Param('areaId') id: string,
    @Body() body: UpdateAreaDto,
  ) {
    return this.service.updateArea(request.user, id, body);
  }
  @Delete('property-areas/:areaId')
  @Roles(...PROPERTY_MANAGERS)
  deleteArea(@Req() request: AuthenticatedRequest, @Param('areaId') id: string) {
    return this.service.deleteArea(request.user, id);
  }
  @Post('properties/:propertyId/areas/approve')
  @Roles(...PROPERTY_MANAGERS)
  approveAreas(@Req() request: AuthenticatedRequest, @Param('propertyId') id: string) {
    return this.service.approveAreas(request.user, id);
  }
  @Post('properties/:propertyId/areas/reorder')
  @Roles(...PROPERTY_MANAGERS)
  reorderAreas(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
    @Body() body: AreaOrderDto,
  ) {
    return this.service.reorderAreas(request.user, id, body.areaIds);
  }

  @Post('inspections')
  @Roles(...PROPERTY_MANAGERS)
  createInspection(@Req() request: AuthenticatedRequest, @Body() body: CreateInspectionDto) {
    return this.service.createInspection(request.user, body);
  }
  @Get('inspections/assigned')
  @Roles(UserRole.INSPECTION_TECHNICIAN)
  assignedInspections(@Req() request: AuthenticatedRequest) {
    return this.service.assignedInspections(request.user);
  }
  @Get('inspections/:inspectionId') getInspection(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
  ) {
    return this.service.getInspection(request.user, id);
  }
  @Post('inspections/:inspectionId/start')
  @Roles(UserRole.INSPECTION_TECHNICIAN)
  startInspection(@Req() request: AuthenticatedRequest, @Param('inspectionId') id: string) {
    return this.service.startInspection(request.user, id);
  }
  @Post('inspections/:inspectionId/complete')
  @Roles(UserRole.INSPECTION_TECHNICIAN)
  completeInspection(@Req() request: AuthenticatedRequest, @Param('inspectionId') id: string) {
    return this.service.completeInspection(request.user, id);
  }

  @Get('inspection-areas/:inspectionAreaId') getInspectionArea(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionAreaId') id: string,
  ) {
    return this.service.getInspectionArea(request.user, id);
  }
  @Post('inspection-areas/:inspectionAreaId/skip')
  @Roles(UserRole.INSPECTION_TECHNICIAN)
  skipArea(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionAreaId') id: string,
    @Body() body: ReasonDto,
  ) {
    return this.service.skipArea(request.user, id, body.reason);
  }
  @Post('inspection-areas/:inspectionAreaId/unskip')
  @Roles(UserRole.INSPECTION_TECHNICIAN)
  unskipArea(@Req() request: AuthenticatedRequest, @Param('inspectionAreaId') id: string) {
    return this.service.unskipArea(request.user, id);
  }
  @Post('inspection-areas/:inspectionAreaId/complete')
  @Roles(UserRole.INSPECTION_TECHNICIAN)
  completeArea(@Req() request: AuthenticatedRequest, @Param('inspectionAreaId') id: string) {
    return this.service.completeArea(request.user, id);
  }

  @Post('inspection-areas/:inspectionAreaId/media/upload-session')
  @Roles(UserRole.INSPECTION_TECHNICIAN)
  createUploadSession(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionAreaId') id: string,
    @Body() body: UploadSessionDto,
  ) {
    return this.service.createUploadSession(request.user, id, body.idempotencyKey);
  }
  @Post('inspection-areas/:inspectionAreaId/media')
  @Roles(UserRole.INSPECTION_TECHNICIAN)
  registerMedia(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionAreaId') id: string,
    @Body() body: RegisterMediaDto,
  ) {
    return this.service.registerMedia(request.user, id, body);
  }
  @Get('inspection-areas/:inspectionAreaId/media') listMedia(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionAreaId') id: string,
  ) {
    return this.service.listMedia(request.user, id);
  }
  @Get('inspection-media/:mediaId') getMedia(
    @Req() request: AuthenticatedRequest,
    @Param('mediaId') id: string,
  ) {
    return this.service.getMedia(request.user, id);
  }
  @Post('inspection-media/:mediaId/retry-processing')
  @Roles(UserRole.INSPECTION_TECHNICIAN)
  retryMedia(@Req() request: AuthenticatedRequest, @Param('mediaId') id: string) {
    return this.service.retryMedia(request.user, id);
  }

  @Get('inspections/:inspectionId/findings') listFindings(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
  ) {
    return this.service.listFindings(request.user, id);
  }
  @Get('findings/:findingId') getFinding(
    @Req() request: AuthenticatedRequest,
    @Param('findingId') id: string,
  ) {
    return this.service.getFinding(request.user, id);
  }
  @Patch('findings/:findingId')
  @Roles(UserRole.CONDITION_REVIEWER)
  editFinding(
    @Req() request: AuthenticatedRequest,
    @Param('findingId') id: string,
    @Body() body: UpdateFindingDto,
  ) {
    return this.service.editFinding(request.user, id, body);
  }
  @Post('findings/:findingId/approve')
  @Roles(UserRole.CONDITION_REVIEWER)
  approveFinding(@Req() request: AuthenticatedRequest, @Param('findingId') id: string) {
    return this.service.approveFinding(request.user, id);
  }
  @Post('findings/:findingId/reject')
  @Roles(UserRole.CONDITION_REVIEWER)
  rejectFinding(
    @Req() request: AuthenticatedRequest,
    @Param('findingId') id: string,
    @Body() body: ReasonDto,
  ) {
    return this.service.rejectFinding(request.user, id, body.reason);
  }
  @Post('findings/:findingId/request-reinspection')
  @Roles(UserRole.CONDITION_REVIEWER)
  requestReinspection(
    @Req() request: AuthenticatedRequest,
    @Param('findingId') id: string,
    @Body() body: ReasonDto,
  ) {
    return this.service.requestReinspection(request.user, id, body.reason);
  }
}
