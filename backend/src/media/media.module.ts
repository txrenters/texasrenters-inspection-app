import { Module } from '@nestjs/common';

import { ApiAuthGuard } from '../common/auth';
import { CloudflareStreamWebhookGuard } from './cloudflare-stream-webhook.guard';
import { CloudflareStreamService } from './cloudflare-stream.service';
import {
  CloudflareStreamWebhookController,
  InspectionVideoController,
} from './inspection-video.controller';
import { InspectionVideoService } from './inspection-video.service';

/**
 * Direct-to-Cloudflare video upload and the provider callback that reports what
 * became of it.
 *
 * Exports the Stream service so the playback endpoint can mint signed tokens
 * from the same credential holder rather than growing a second one.
 */
@Module({
  controllers: [InspectionVideoController, CloudflareStreamWebhookController],
  providers: [
    InspectionVideoService,
    CloudflareStreamService,
    CloudflareStreamWebhookGuard,
    ApiAuthGuard,
  ],
  exports: [CloudflareStreamService, InspectionVideoService],
})
export class MediaModule {}
