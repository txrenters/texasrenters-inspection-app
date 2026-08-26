import { Module } from '@nestjs/common';

import { ApiAuthGuard, RolesGuard } from '../common/auth';
import { AreaChecklistAiService } from '../admin/area-checklist-ai.service';
import { AiProviderSettingsService } from '../admin/ai-provider-settings.service';
import { ChargeService } from '../admin/charge.service';
import { ComparisonService } from '../admin/comparison.service';
import { FloorPlanStorageService } from '../admin/floor-plan-storage.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { RoutingModule } from '../routing/routing.module';
import { InspectionMediaStorageService } from './inspection-media-storage.service';
import { MediaProcessingService } from './media-processing.service';
import { CloudflareStreamService } from '../media/cloudflare-stream.service';
import { TechnicianController } from './technician.controller';
import { LocationRetentionScheduler } from './location-retention.scheduler';
import { TechnicianLocationService } from './technician-location.service';
import { TechnicianService } from './technician.service';

@Module({
  imports: [RealtimeModule, RoutingModule],
  controllers: [TechnicianController],
  providers: [
    TechnicianService,
    TechnicianLocationService,
    LocationRetentionScheduler,
    FloorPlanStorageService,
    InspectionMediaStorageService,
    MediaProcessingService,
    // Lets the pipeline ask Cloudflare for a media URL when a recording lives
    // there rather than in the bucket.
    CloudflareStreamService,
    AiProviderSettingsService,
    // Stateless and dependency-free, so it is provided here rather than
    // imported from AdminModule — which imports MediaModule, which imports this
    // one. A second instance costs nothing and avoids the cycle.
    AreaChecklistAiService,
    ComparisonService,
    ChargeService,
    ApiAuthGuard,
    RolesGuard,
  ],
  // Exported so the Cloudflare Stream webhook can start the pipeline. A video
  // uploaded straight to Stream never passes through this module's controller,
  // so without this nothing queued transcription or analysis for it.
  // `TechnicianLocationService` too, so the console's map can read the same
  // positions the handsets write without a second copy of the query.
  exports: [MediaProcessingService, TechnicianLocationService],
})
export class TechnicianModule {}
