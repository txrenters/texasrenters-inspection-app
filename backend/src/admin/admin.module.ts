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
import { ProfileDeletionService } from './profile-deletion.service';
import { ReportShareService } from './report-share.service';
import { ReportsController } from './reports.controller';
import { AuthModule } from '../auth/auth.module';
import { LocalIdentityProvider } from '../auth/local-identity.provider';
import { IDENTITY_PROVIDER } from './identity-provider';
import { TechnicianProvisioningService } from './technician-provisioning.service';

@Module({
  // AuthModule for LocalIdentityProvider, so provisioning and the password
  // flows share one instance rather than each registering their own.
  imports: [RealtimeModule, MailModule, AuthModule],
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
    ProfileDeletionService,
    ReportShareService,
    TechnicianProvisioningService,
    // One implementation now that Supabase is gone; the token remains so
    // call sites stay decoupled from whichever store is behind it.
    { provide: IDENTITY_PROVIDER, useExisting: LocalIdentityProvider },
    ApiAuthGuard,
    PermissionsGuard,
  ],
})
export class AdminModule {}
