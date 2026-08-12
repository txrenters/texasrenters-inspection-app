/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { tmpdir } from 'node:os';

import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Put,
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
import { diskStorage } from 'multer';

import { ChargeService } from '../admin/charge.service';
import { PetObservationDto } from '../admin/admin.dto';
import { ApiAuthGuard, Roles, RolesGuard, type AuthenticatedRequest } from '../common/auth';
import { MobilePushService } from '../realtime/mobile-push.service';
import { MediaProcessingService } from './media-processing.service';
import {
  ChecklistAssessmentDto,
  MobilePushDeviceDto,
  RemoveMobilePushDeviceDto,
  TechnicianAdditionalVideoDto,
  TechnicianCreateAreaDto,
  TechnicianFindingsQueryDto,
  TechnicianInspectionListQueryDto,
  TechnicianMediaUploadDto,
  TechnicianNoteDto,
  TechnicianPhotoUploadDto,
  TechnicianReasonDto,
} from './technician.dto';
import { TechnicianService, type UploadedRoomVideo } from './technician.service';

@ApiTags('Technician mobile application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, RolesGuard)
@Roles(UserRole.INSPECTION_TECHNICIAN)
@Controller('technician')
export class TechnicianController {
  constructor(
    private readonly service: TechnicianService,
    private readonly mobilePush: MobilePushService,
    private readonly mediaProcessing: MediaProcessingService,
    private readonly charges: ChargeService,
  ) {}

  @Post('notification-devices')
  registerNotificationDevice(
    @Req() request: AuthenticatedRequest,
    @Body() body: MobilePushDeviceDto,
  ) {
    return this.mobilePush.register(request.user, body);
  }

  @Delete('notification-devices')
  async removeNotificationDevice(
    @Req() request: AuthenticatedRequest,
    @Body() body: RemoveMobilePushDeviceDto,
  ) {
    await this.mobilePush.unregister(request.user, body.expoPushToken);
  }

  @Get('dashboard') dashboard(@Req() request: AuthenticatedRequest) {
    return this.service.dashboard(request.user);
  }
  @Get('inspections') inspections(
    @Req() request: AuthenticatedRequest,
    @Query() query: TechnicianInspectionListQueryDto,
  ) {
    return this.service.inspections(request.user, query);
  }
  @Get('inspections/:inspectionId') inspection(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
  ) {
    return this.service.inspection(request.user, id);
  }
  @Get('inspections/:inspectionId/context') inspectionContext(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
  ) {
    return this.service.inspectionContext(request.user, id);
  }
  @Post('inspections/:inspectionId/start') startInspection(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
  ) {
    return this.service.startInspection(request.user, id);
  }
  @Post('inspections/:inspectionId/complete') completeInspection(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
  ) {
    return this.service.completeInspection(request.user, id);
  }
  @Get('inspections/:inspectionId/rooms') rooms(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
  ) {
    return this.service.rooms(request.user, id);
  }
  @Post('inspections/:inspectionId/areas') createArea(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: TechnicianCreateAreaDto,
  ) {
    return this.service.createArea(request.user, id, body);
  }
  @Post('inspections/:inspectionId/pet-observations') recordPetObservation(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: PetObservationDto,
  ) {
    // Technicians record pet evidence only; uniqueness/authorization/charges are
    // an administrator's decision (spec §13).
    return this.charges.recordObservation(
      { organizationId: request.user.organizationId, userId: request.user.id },
      id,
      body,
    );
  }
  @Get('inspections/:inspectionId/findings') findings(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Query() query: TechnicianFindingsQueryDto,
  ) {
    return this.service.findings(request.user, id, query);
  }
  /**
   * Everything waiting on this technician, across their assignments.
   *
   * Read outside any one inspection — it is what the app polls and the realtime
   * gateway invalidates to tell a technician the office needs something.
   */
  @Get('evidence-requests') openEvidenceRequests(@Req() request: AuthenticatedRequest) {
    return this.service.openEvidenceRequests(request.user);
  }
  @Get('inspections/:inspectionId/evidence-requests') evidenceRequests(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
  ) {
    return this.service.evidenceRequests(request.user, id);
  }
  /**
   * The technician's own call that a request is satisfied. Deliberately not
   * inferred from a new upload arriving: only they know whether what they just
   * captured is what was asked for.
   */
  @Post('evidence-requests/:requestId/resolve') resolveEvidenceRequest(
    @Req() request: AuthenticatedRequest,
    @Param('requestId') id: string,
  ) {
    return this.service.resolveEvidenceRequest(request.user, id);
  }
  @Get('inspections/:inspectionId/report') report(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
  ) {
    return this.service.report(request.user, id);
  }
  @Get('properties/:propertyId') property(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
  ) {
    return this.service.property(request.user, id);
  }
  @Get('properties/:propertyId/floor-plan')
  floorPlan(@Req() request: AuthenticatedRequest, @Param('propertyId') id: string) {
    return this.service.floorPlan(request.user, id);
  }
  @Get('floor-plans/:floorPlanId/content')
  @Header('Cache-Control', 'private, no-store')
  async floorPlanContent(@Req() request: AuthenticatedRequest, @Param('floorPlanId') id: string) {
    const file = await this.service.floorPlanContent(request.user, id);
    return new StreamableFile(file.bytes, {
      type: file.mimeType,
      disposition: `inline; filename="${file.fileName}"`,
    });
  }
  @Get('rooms/:roomId') room(@Req() request: AuthenticatedRequest, @Param('roomId') id: string) {
    return this.service.room(request.user, id);
  }
  @Patch('rooms/:roomId/note') note(
    @Req() request: AuthenticatedRequest,
    @Param('roomId') id: string,
    @Body() body: TechnicianNoteDto,
  ) {
    return this.service.updateRoomNote(request.user, id, body.note);
  }
  @Post('rooms/:roomId/skip') skip(
    @Req() request: AuthenticatedRequest,
    @Param('roomId') id: string,
    @Body() body: TechnicianReasonDto,
  ) {
    return this.service.skipRoom(request.user, id, body.reason);
  }
  /**
   * Confirms the AI summary for an area reflects the walkthrough.
   *
   * Note what this route deliberately does not offer: no body, no verdict, no
   * finding id. A technician confirms that the narrative matches the room they
   * stood in — approving or rejecting the findings themselves stays an
   * administrator decision, and there is no technician route that can reach it.
   */
  @Post('rooms/:roomId/confirm-summary') confirmRoomSummary(
    @Req() request: AuthenticatedRequest,
    @Param('roomId') id: string,
  ) {
    return this.service.confirmRoomSummary(request.user, id);
  }
  @Post('rooms/:roomId/complete') completeRoom(
    @Req() request: AuthenticatedRequest,
    @Param('roomId') id: string,
  ) {
    return this.service.completeRoom(request.user, id);
  }
  @Get('rooms/:roomId/media') media(
    @Req() request: AuthenticatedRequest,
    @Param('roomId') id: string,
  ) {
    return this.service.media(request.user, id);
  }
  @Post('rooms/:roomId/media')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({ destination: tmpdir() }),
      limits: { fileSize: 2_000_000_000, files: 1 },
    }),
  )
  uploadMedia(
    @Req() request: AuthenticatedRequest,
    @Param('roomId') id: string,
    @Body() body: TechnicianMediaUploadDto,
    @UploadedFile() file?: UploadedRoomVideo,
  ) {
    return this.service.uploadRoomMedia(request.user, id, body, file);
  }
  @Post('rooms/:roomId/videos')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({ destination: tmpdir() }),
      limits: { fileSize: 2_000_000_000, files: 1 },
    }),
  )
  uploadAdditionalVideo(
    @Req() request: AuthenticatedRequest,
    @Param('roomId') id: string,
    @Body() body: TechnicianAdditionalVideoDto,
    @UploadedFile() file?: UploadedRoomVideo,
  ) {
    return this.service.uploadAdditionalVideo(request.user, id, body, file);
  }
  /**
   * PUT, not PATCH: the body is the item's complete assessment, so clearing a
   * checkbox in the app clears it on the server rather than leaving a stale
   * value the report would still print.
   */
  @Put('rooms/:roomId/checklist/:itemId') recordRoomChecklistItem(
    @Req() request: AuthenticatedRequest,
    @Param('roomId') roomId: string,
    @Param('itemId') itemId: string,
    @Body() body: ChecklistAssessmentDto,
  ) {
    return this.service.recordRoomChecklistItem(request.user, roomId, itemId, body);
  }
  @Get('rooms/:roomId/checklist') roomChecklist(
    @Req() request: AuthenticatedRequest,
    @Param('roomId') id: string,
  ) {
    return this.service.roomChecklist(request.user, id);
  }
  @Get('rooms/:roomId/photos') photos(
    @Req() request: AuthenticatedRequest,
    @Param('roomId') id: string,
  ) {
    return this.service.listPhotos(request.user, id);
  }
  @Post('rooms/:roomId/photos')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({ destination: tmpdir() }),
      limits: { fileSize: 30_000_000, files: 1 },
    }),
  )
  uploadPhoto(
    @Req() request: AuthenticatedRequest,
    @Param('roomId') id: string,
    @Body() body: TechnicianPhotoUploadDto,
    @UploadedFile() file?: UploadedRoomVideo,
  ) {
    return this.service.uploadPhoto(request.user, id, body, file);
  }
  @Delete('photos/:photoId') deletePhoto(
    @Req() request: AuthenticatedRequest,
    @Param('photoId') id: string,
  ) {
    return this.service.deletePhoto(request.user, id);
  }
  @Get('photos/:photoId/content')
  @Header('Cache-Control', 'private, no-store')
  async photoContent(@Req() request: AuthenticatedRequest, @Param('photoId') id: string) {
    const file = await this.service.photoContent(request.user, id);
    return new StreamableFile(file.bytes, {
      type: file.mimeType,
      disposition: `inline; filename="${file.fileName}"`,
    });
  }
  @Get('uploads') uploads(@Req() request: AuthenticatedRequest) {
    return this.service.uploads(request.user);
  }
  @Post('media/:mediaId/reprocess') reprocessMedia(
    @Req() request: AuthenticatedRequest,
    @Param('mediaId') id: string,
  ) {
    return this.mediaProcessing.reprocess(request.user.organizationId, request.user.id, id);
  }
}
