import { Module } from '@nestjs/common';

import { ApiAuthGuard, RolesGuard } from '../common/auth';
import { AiProviderSettingsService } from '../admin/ai-provider-settings.service';
import { ChargeService } from '../admin/charge.service';
import { ComparisonService } from '../admin/comparison.service';
import { FloorPlanStorageService } from '../admin/floor-plan-storage.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { InspectionMediaStorageService } from './inspection-media-storage.service';
import { MediaProcessingService } from './media-processing.service';
import { CloudflareStreamService } from '../media/cloudflare-stream.service';
import { TechnicianController } from './technician.controller';
import { TechnicianService } from './technician.service';

@Module({
  imports: [RealtimeModule],
  controllers: [TechnicianController],
  providers: [
    TechnicianService,
    FloorPlanStorageService,
    InspectionMediaStorageService,
    MediaProcessingService,
    // Lets the pipeline ask Cloudflare for a media URL when a recording lives
    // there rather than in the bucket.
    CloudflareStreamService,
    AiProviderSettingsService,
    ComparisonService,
    ChargeService,
    ApiAuthGuard,
    RolesGuard,
  ],
  // Exported so the Cloudflare Stream webhook can start the pipeline. A video
  // uploaded straight to Stream never passes through this module's controller,
  // so without this nothing queued transcription or analysis for it.
  exports: [MediaProcessingService],
})
export class TechnicianModule {}
