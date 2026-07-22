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

import { ApiAuthGuard, Roles, RolesGuard, type AuthenticatedRequest } from '../common/auth';
import { MobilePushService } from '../realtime/mobile-push.service';
import {
  MobilePushDeviceDto,
  RemoveMobilePushDeviceDto,
  TechnicianFindingsQueryDto,
  TechnicianMediaUploadDto,
  TechnicianNoteDto,
  TechnicianInspectionListQueryDto,
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
  @Get('inspections/:inspectionId/findings') findings(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Query() query: TechnicianFindingsQueryDto,
  ) {
    return this.service.findings(request.user, id, query);
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
  @Get('uploads') uploads(@Req() request: AuthenticatedRequest) {
    return this.service.uploads(request.user);
  }
}
