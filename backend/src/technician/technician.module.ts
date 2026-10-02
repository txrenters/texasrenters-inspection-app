import { Module } from '@nestjs/common';

import { ApiAuthGuard, RolesGuard } from '../common/auth';
import { AreaChecklistAiService } from '../admin/area-checklist-ai.service';
import { AiGuidanceService } from '../admin/ai-guidance.service';
import { AiProviderSettingsService } from '../admin/ai-provider-settings.service';
import { ChargeService } from '../admin/charge.service';
import { ComparisonService } from '../admin/comparison.service';
import { FloorPlanStorageService } from '../admin/floor-plan-storage.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { RoutingModule } from '../routing/routing.module';
import { TimeTrackingModule } from '../time-tracking/time-tracking.module';
import { InspectionMediaStorageService } from './inspection-media-storage.service';
import { MediaProcessingService } from './media-processing.service';
import { VisualReviewService } from './visual-review.service';
import { CloudflareStreamService } from '../media/cloudflare-stream.service';
import { TechnicianController } from './technician.controller';
import { LocationRetentionScheduler } from './location-retention.scheduler';
import { PropertyGeocodingService } from '../admin/property-geocoding.service';
import { TechnicianHomeService } from './technician-home.service';
import { TechnicianLocationService } from './technician-location.service';
import { TechnicianService } from './technician.service';
import { TrackingStatusStore } from './tracking-status.store';

@Module({
  // TimeTracking so a submitted job's hours are read from the trail without
  // anybody asking. It imports only the database, so there is no cycle.
  imports: [RealtimeModule, RoutingModule, TimeTrackingModule],
  controllers: [TechnicianController],
  providers: [
    TechnicianService,
    TechnicianLocationService,
    TrackingStatusStore,
    TechnicianHomeService,
    // Its only dependency is Prisma. Provided here rather than importing the
    // whole admin module into the technician one for a single geocoder.
    PropertyGeocodingService,
    LocationRetentionScheduler,
    FloorPlanStorageService,
    InspectionMediaStorageService,
    MediaProcessingService,
    // The AI's look at a recording's frames, after the narration's analysis.
    VisualReviewService,
    // Lets the pipeline ask Cloudflare for a media URL when a recording lives
    // there rather than in the bucket.
    CloudflareStreamService,
    AiProviderSettingsService,
    // The office's house rules and its recent decisions, which both the
    // narration's analysis and the look at the video are given. Prisma only.
    AiGuidanceService,
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
