import { Module } from '@nestjs/common';

import { ApiAuthGuard, PermissionsGuard } from '../common/auth';
import { MailModule } from '../mail/mail.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { InspectionMediaStorageService } from '../technician/inspection-media-storage.service';
import { AccessController } from './access.controller';
import { AccessService } from './access.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AiProviderSettingsService } from './ai-provider-settings.service';
import { ChargeService } from './charge.service';
import { ComparisonService } from './comparison.service';
import { FloorPlanAdminService } from './floor-plan-admin.service';
import { FloorPlanExtractionService } from './floor-plan-extraction.service';
import { FloorPlanStorageService } from './floor-plan-storage.service';
import { AreaEvidenceService } from './area-evidence.service';
import { ReportShareService } from './report-share.service';
import { ReportsController } from './reports.controller';
import {
  SupabaseAdminGateway,
  TechnicianProvisioningService,
} from './technician-provisioning.service';

@Module({
  imports: [RealtimeModule, MailModule],
  controllers: [AdminController, AccessController, ReportsController],
  providers: [
    AdminService,
    AccessService,
    AreaEvidenceService,
    AiProviderSettingsService,
    ChargeService,
    ComparisonService,
    FloorPlanAdminService,
    FloorPlanExtractionService,
    FloorPlanStorageService,
    InspectionMediaStorageService,
    ReportShareService,
    TechnicianProvisioningService,
    SupabaseAdminGateway,
    ApiAuthGuard,
    PermissionsGuard,
  ],
})
export class AdminModule {}
