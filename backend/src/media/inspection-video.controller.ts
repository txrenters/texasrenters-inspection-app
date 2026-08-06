/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';

import { ApiAuthGuard, type AuthenticatedRequest } from '../common/auth';
import { CloudflareStreamWebhookGuard } from './cloudflare-stream-webhook.guard';
import { CreateUploadSessionDto } from './inspection-video.dto';
import { InspectionVideoService } from './inspection-video.service';

@ApiTags('Inspection video')
@Controller('inspection-videos')
export class InspectionVideoController {
  constructor(@Inject(InspectionVideoService) private readonly service: InspectionVideoService) {}

  /**
   * Reserve a direct-to-Cloudflare upload.
   *
   * Authenticated as the technician, and authorized against the assignment
   * inside the service — holding a valid token is not enough to attach evidence
   * to an arbitrary inspection. Returns a short-lived upload URL and nothing
   * else; the Cloudflare API token never leaves the backend.
   */
  @Post('upload-session')
  @ApiBearerAuth()
  @UseGuards(ApiAuthGuard)
  createUploadSession(
    @Req() request: AuthenticatedRequest,
    @Body() body: CreateUploadSessionDto,
  ) {
    return this.service.createUploadSession(request.user, body);
  }

  /**
   * A short-lived signed manifest URL for one recording.
   *
   * Deliberately not permission-gated by a decorator: this serves both the web
   * console and the technician who recorded the video, who holds no admin
   * permissions at all. The service authorizes each caller against the
   * inspection instead, so neither is granted the other's reach.
   */
  @Get(':videoId/playback')
  @ApiBearerAuth()
  @UseGuards(ApiAuthGuard)
  playback(@Req() request: AuthenticatedRequest, @Param('videoId') videoId: string) {
    return this.service.getPlayback(request.user, videoId);
  }
}

/**
 * Cloudflare's callback, on its own controller because it is authenticated
 * completely differently: no bearer token, no user, only a signature over the
 * raw body. Mounting it beside the technician routes would put an unauthenticated
 * path one decorator slip away from them.
 */
@ApiTags('Inspection video')
@Controller('webhooks/cloudflare-stream')
export class CloudflareStreamWebhookController {
  constructor(@Inject(InspectionVideoService) private readonly service: InspectionVideoService) {}

  @Post()
  @ApiExcludeEndpoint()
  @UseGuards(CloudflareStreamWebhookGuard)
  // 200 for anything that passed the signature check, including payloads this
  // backend cannot use. Cloudflare retries non-2xx, so answering 4xx to a video
  // we deleted would earn an indefinite retry loop for no benefit.
  @HttpCode(200)
  async receive(@Body() body: Record<string, unknown>) {
    const result = await this.service.applyWebhook(body);
    return { received: true, ...result };
  }
}
