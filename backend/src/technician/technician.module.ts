import { Module } from '@nestjs/common';

import { ApiAuthGuard, RolesGuard } from '../common/auth';
import { AiProviderSettingsService } from '../admin/ai-provider-settings.service';
import { FloorPlanStorageService } from '../admin/floor-plan-storage.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { InspectionMediaStorageService } from './inspection-media-storage.service';
import { MediaProcessingService } from './media-processing.service';
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
    AiProviderSettingsService,
    ApiAuthGuard,
    RolesGuard,
  ],
})
export class TechnicianModule {}
