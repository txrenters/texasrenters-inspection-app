import { Module } from '@nestjs/common';

import { ApiAuthGuard, RolesGuard } from '../common/auth';
import { RealtimeModule } from '../realtime/realtime.module';
import { InspectionMediaStorageService } from '../technician/inspection-media-storage.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AiProviderSettingsService } from './ai-provider-settings.service';
import { FloorPlanAdminService } from './floor-plan-admin.service';
import { FloorPlanExtractionService } from './floor-plan-extraction.service';
import { FloorPlanStorageService } from './floor-plan-storage.service';
import { ReportShareService } from './report-share.service';
import { ReportsController } from './reports.controller';
import {
  SupabaseAdminGateway,
  TechnicianProvisioningService,
} from './technician-provisioning.service';

@Module({
  imports: [RealtimeModule],
  controllers: [AdminController, ReportsController],
  providers: [
    AdminService,
    AiProviderSettingsService,
    FloorPlanAdminService,
    FloorPlanExtractionService,
    FloorPlanStorageService,
    InspectionMediaStorageService,
    ReportShareService,
    TechnicianProvisioningService,
    SupabaseAdminGateway,
    ApiAuthGuard,
    RolesGuard,
  ],
})
export class AdminModule {}
