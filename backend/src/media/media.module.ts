import { Module } from '@nestjs/common';

import { ApiAuthGuard } from '../common/auth';
import { CloudflareStreamWebhookGuard } from './cloudflare-stream-webhook.guard';
import { CloudflareStreamService } from './cloudflare-stream.service';
import {
  CloudflareStreamWebhookController,
  InspectionVideoController,
} from './inspection-video.controller';
import { InspectionVideoService } from './inspection-video.service';
import { TechnicianModule } from '../technician/technician.module';

/**
 * Direct-to-Cloudflare video upload and the provider callback that reports what
 * became of it.
 *
 * Exports the Stream service so the playback endpoint can mint signed tokens
 * from the same credential holder rather than growing a second one.
 */
@Module({
  // For MediaProcessingService only: the webhook is where a Stream recording
  // becomes playable, and therefore where transcription and analysis have to be
  // started. TechnicianModule does not import this one, so there is no cycle.
  imports: [TechnicianModule],
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
