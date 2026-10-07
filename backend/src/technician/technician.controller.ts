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
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  REPORTABLE_VISIT_SERVICES,
  UserRole,
  type ReportableVisitService,
} from '@texasrenters/shared';
import { diskStorage } from 'multer';

import { ChargeService } from '../admin/charge.service';
import { PetObservationDto } from '../admin/admin.dto';
import { ApiAuthGuard, Roles, RolesGuard, type AuthenticatedRequest } from '../common/auth';
import { businessDayFromQuery } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { MobilePushService } from '../realtime/mobile-push.service';
import { MediaProcessingService } from './media-processing.service';
import {
  ChecklistAssessmentDto,
  MobilePushDeviceDto,
  RemoveMobilePushDeviceDto,
  TechnicianAdditionalVideoDto,
  TechnicianCompleteInspectionDto,
  TechnicianStartInspectionDto,
  TechnicianCouldNotAccessDto,
  TechnicianReplaceEvidenceDto,
  TechnicianCreateAreaDto,
  TechnicianFindingsQueryDto,
  TechnicianInspectionListQueryDto,
  TechnicianJobDaysQueryDto,
  TechnicianMediaUploadDto,
  TechnicianNoteDto,
  TechnicianPhotoUploadDto,
  TechnicianReasonDto,
  TechnicianSaveServicesDto,
  TechnicianUpdateAreaDto,
  TechnicianHomeDto,
  TechnicianLocationBatchDto,
  TechnicianLocationStatusDto,
} from './technician.dto';
import {
  isTileInRange,
  MapTilesClient,
  MAP_TILE_TYPES,
  type MapTileOptions,
  type MapTileType,
} from '../routing/map-tiles.client';
import { RouteService } from '../routing/route.service';
import { TechnicianHomeService } from './technician-home.service';
import { TechnicianLocationService } from './technician-location.service';
import { TechnicianService, type UploadedRoomVideo } from './technician.service';

/**
 * Which map the phone asked for, with anything unrecognised read as the
 * ordinary one.
 *
 * Unrecognised rather than refused on purpose: these arrive as query strings
 * from a handset that may be several OTA updates behind, and a technician
 * driving somewhere should get a light road map rather than a 400 because a
 * newer name for a map type was added after their build.
 */
function tileOptions(mapType?: string, theme?: string, traffic?: string): MapTileOptions {
  return {
    mapType: (MAP_TILE_TYPES as readonly string[]).includes(mapType ?? '')
      ? (mapType as MapTileType)
      : 'roadmap',
    theme: theme === 'dark' ? 'dark' : 'light',
    traffic: traffic === '1' || traffic === 'true',
  };
}

@ApiTags('Technician mobile application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, RolesGuard)
@Roles(UserRole.INSPECTION_TECHNICIAN)
@Controller('technician')
export class TechnicianController {
  constructor(
    private readonly service: TechnicianService,
    private readonly mobilePush: MobilePushService,
    private readonly locations: TechnicianLocationService,
    private readonly routes: RouteService,
    private readonly mapTiles: MapTilesClient,
    private readonly mediaProcessing: MediaProcessingService,
    private readonly charges: ChargeService,
    private readonly homes: TechnicianHomeService,
  ) {}

  /**
   * Where this handset has been since it last reached the API.
   *
   * A batch, because that is how they arrive: a phone out of signal for an
   * hour has a great deal to say at once. The response says how many fixes
   * were stored and how many were dropped, so a device losing points to a bad
   * clock finds out rather than reporting a technician standing still.
   */
  /**
   * The technician's own day, ordered from where they are now.
   *
   * No permission beyond being themselves: the id comes from the token, never
   * from the request, so this cannot be pointed at a colleague. That is also
   * why it is here rather than reusing the console's route — the admin
   * endpoint takes an id, and an endpoint that takes an id is one a technician
   * must never be handed.
   */
  @Get('route')
  technicianRoute(@Req() request: AuthenticatedRequest, @Query('date') date?: string) {
    return this.routes.planDay(
      request.user.organizationId,
      request.user.id,
      businessDayFromQuery(date),
    );
  }

  /**
   * The drive to one of their own stops, turn by turn.
   *
   * Guarded exactly like `route` above, and it takes an id only because
   * `navigateLeg` refuses to *fetch* by it: the id is looked for inside the
   * technician's own day, so a colleague's inspection resolves to nothing
   * rather than to a route. See the note on that method.
   *
   * `lat`/`lng` are where the phone is now, which is where the leg is drawn
   * from -- deliberately not the last position the handset uploaded, because
   * the location queue can be minutes behind on a bad signal and a leg drawn
   * from a mile back tells somebody to turn where they have already turned.
   *
   * Answers 200 with a null body when no route could be drawn: no key, an
   * outage, a property that never geocoded, an id that is not on the day. The
   * app has a designed screen for that, and an exception would show it a crash
   * instead of a sentence.
   */
  @Get('navigation/leg')
  navigationLeg(
    @Req() request: AuthenticatedRequest,
    @Query('to') to?: string,
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
  ) {
    return this.routes.navigateLeg(request.user.organizationId, request.user.id, to ?? '', {
      latitude: Number(lat),
      longitude: Number(lng),
    });
  }

  /**
   * One basemap tile, fetched with our key and handed on.
   *
   * The phone cannot hold the key -- a bare `fetch` from React Native proves no
   * application identity, so an application-restricted key is useless there and
   * an unrestricted one in the bundle is a published key. So the tile comes
   * through here, where the technician is already authenticated.
   *
   * `z`, `x` and `y` are validated before the upstream URL is built. They are
   * path segments from a handset, and an unchecked one is a string pasted into
   * a request we then make with our own key on it.
   *
   * The upstream `Cache-Control` and `ETag` are passed through untouched rather
   * than replaced. Google's terms require clients to respect the lifetime it
   * sets, so lengthening it would be a licensing decision and shortening it
   * would bill us for tiles the phone already has.
   */
  @Get('map-tiles/:z/:x/:y')
  async mapTile(
    @Param('z') z: string,
    @Param('x') x: string,
    @Param('y') y: string,
    @Res() response: Response,
    @Query('mapType') mapType?: string,
    @Query('theme') theme?: string,
    @Query('traffic') traffic?: string,
  ) {
    const zoom = Number(z);
    const column = Number(x);
    const row = Number(y);
    if (!isTileInRange(zoom, column, row))
      throw new ApplicationError(400, 'TILE_OUT_OF_RANGE', 'That is not a tile that can exist.');

    const tile = await this.mapTiles.tile(zoom, column, row, tileOptions(mapType, theme, traffic));
    if (!tile)
      // Not a 500: the map being unavailable is a degraded screen, not an
      // incident, and the app draws the route on a blank field rather than
      // failing the drive.
      throw new ApplicationError(
        503,
        'MAP_TILE_UNAVAILABLE',
        'The map could not be loaded right now.',
      );

    response.setHeader('Content-Type', tile.contentType);
    if (tile.cacheControl) response.setHeader('Cache-Control', tile.cacheControl);
    if (tile.etag) response.setHeader('ETag', tile.etag);
    response.setHeader('Content-Length', tile.bytes.length);
    response.end(tile.bytes);
  }

  /**
   * Who the map data belongs to, for the line the map is required to show.
   *
   * Separate from the tiles because it is one string per session rather than
   * one per tile, and because showing it is not optional: Google's terms make
   * the attribution a condition of drawing their tiles at all. It therefore
   * always answers with something, falling back to the minimum Google states
   * rather than leaving the screen with nothing to display.
   */
  @Get('map-attribution')
  async mapAttribution(
    @Query('mapType') mapType?: string,
    @Query('theme') theme?: string,
    @Query('traffic') traffic?: string,
  ) {
    return { attribution: await this.mapTiles.attribution(tileOptions(mapType, theme, traffic)) };
  }

  @Post('locations')
  recordLocations(@Req() request: AuthenticatedRequest, @Body() body: TechnicianLocationBatchDto) {
    return this.locations.record(request.user, body);
  }

  /**
   * How this phone is recording location: whether it records with the app
   * minimised, what the technician has allowed, which update it runs, and how
   * much is waiting to send. The office sees it beside the technician on the
   * map, so a marker that stops moving comes with a reason.
   *
   * Their own phone only -- the id comes from the token.
   */
  @Put('location-status')
  reportLocationStatus(
    @Req() request: AuthenticatedRequest,
    @Body() body: TechnicianLocationStatusDto,
  ) {
    return this.locations.recordTrackingStatus(request.user, body);
  }

  /**
   * The technician's own home, which is where their day's route starts before
   * they set off. Their own only -- there is no id in the path, so one
   * technician cannot read or change another's.
   */
  @Get('home')
  home(@Req() request: AuthenticatedRequest) {
    return this.homes.get(request.user);
  }

  @Put('home')
  setHome(@Req() request: AuthenticatedRequest, @Body() body: TechnicianHomeDto) {
    return this.homes.set(request.user, body.address);
  }

  @Delete('home')
  clearHome(@Req() request: AuthenticatedRequest) {
    return this.homes.clear(request.user);
  }

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
  // Above `inspections/:inspectionId`, which would otherwise take "days" for an id.
  @Get('inspections/days') jobDays(
    @Req() request: AuthenticatedRequest,
    @Query() query: TechnicianJobDaysQueryDto,
  ) {
    return this.service.jobDays(request.user, query);
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
    @Body() body: TechnicianStartInspectionDto,
  ) {
    return this.service.startInspection(request.user, id, body?.startedAt);
  }
  @Post('inspections/:inspectionId/complete') completeInspection(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: TechnicianCompleteInspectionDto,
  ) {
    return this.service.completeInspection(request.user, id, body);
  }
  /**
   * The job's checklist as it stands, saved while it is still being walked.
   *
   * Every tick, rather than the whole report at submission: the checklist is
   * answered at the start of the job now, and a phone that dies at noon must
   * not lose the morning.
   */
  @Patch('inspections/:inspectionId/services') saveServices(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: TechnicianSaveServicesDto,
  ) {
    return this.service.saveServicesReport(request.user, id, body);
  }
  /**
   * The area a job's filter photographs are filed under, made on the first one.
   *
   * Kept beside `service-area/:service`: phones on v2.5.75 ask for it by this
   * name, and an OTA is not guaranteed to have reached every one of them.
   */
  @Post('inspections/:inspectionId/filters-area') filtersArea(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
  ) {
    return this.service.filtersArea(request.user, id);
  }
  /** The area a service's photographs are filed under: the filters, pest control, or flea treatment. */
  @Post('inspections/:inspectionId/service-area/:service') serviceArea(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Param('service') service: string,
  ) {
    if (!(REPORTABLE_VISIT_SERVICES as readonly string[]).includes(service))
      throw new ApplicationError(404, 'SERVICE_NOT_FOUND', 'There is no such service on a job.');
    return this.service.serviceArea(request.user, id, service as ReportableVisitService);
  }
  /** Nobody let the technician in: the office books the whole visit again. */
  @Post('inspections/:inspectionId/no-access') couldNotAccess(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId') id: string,
    @Body() body: TechnicianCouldNotAccessDto,
  ) {
    return this.service.couldNotAccess(request.user, id, body);
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
  /**
   * Corrects an area the technician added themselves.
   *
   * Authorized in the service against `source: TECHNICIAN` and their own
   * `createdById`: fixing a name they just mistyped is a different act from
   * renaming the office's catalog record, which every future inspection of the
   * property reuses.
   */
  @Patch('rooms/:roomId/area') updateArea(
    @Req() request: AuthenticatedRequest,
    @Param('roomId') id: string,
    @Body() body: TechnicianUpdateAreaDto,
  ) {
    return this.service.updateArea(request.user, id, body);
  }
  @Patch('rooms/:roomId/note') note(
    @Req() request: AuthenticatedRequest,
    @Param('roomId') id: string,
    @Body() body: TechnicianNoteDto,
  ) {
    return this.service.updateRoomNote(request.user, id, body.note);
  }
  /**
   * Removes an area from this inspection — a room the property does not have.
   *
   * DELETE on the room itself rather than a `/remove` verb: the resource is
   * gone afterwards, and the route should say so. Refused outright when the
   * area holds any evidence; skipping is the answer for a room that exists and
   * cannot be inspected.
   */
  @Delete('rooms/:roomId') removeArea(
    @Req() request: AuthenticatedRequest,
    @Param('roomId') id: string,
  ) {
    return this.service.removeArea(request.user, id);
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
  /** Change Evidence: a submitted area back to work, as if not yet submitted. */
  @Post('rooms/:roomId/reopen') reopenRoom(
    @Req() request: AuthenticatedRequest,
    @Param('roomId') id: string,
  ) {
    return this.service.reopenRoom(request.user, id);
  }
  /** A changed area's old photographs, removed once new evidence replaces them. */
  @Post('rooms/:roomId/evidence/replace') replaceRoomEvidence(
    @Req() request: AuthenticatedRequest,
    @Param('roomId') id: string,
    @Body() body: TechnicianReplaceEvidenceDto,
  ) {
    return this.service.replaceRoomEvidence(request.user, id, body);
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
