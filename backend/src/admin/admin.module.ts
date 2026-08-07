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
import { LocalIdentityProvider } from '../auth/local-identity.provider';
import { IDENTITY_PROVIDER } from './identity-provider';
import {
  SupabaseAdminGateway,
  TechnicianProvisioningService,
} from './technician-provisioning.service';

/**
 * Which credential store provisioning writes to.
 *
 * Defaults to Supabase, so this ships inert and the switch is one environment
 * variable rather than a deploy. Set `AUTH_IDENTITY_PROVIDER=local` once the
 * credentials are imported and the clients sign in against this backend.
 *
 * Both are registered, so flipping back is the same one-line change — which
 * matters while Supabase is still the fallback.
 * See docs/migration/SUPABASE_TO_SELF_HOSTED.md.
 */
const identityProvider = {
  provide: IDENTITY_PROVIDER,
  inject: [SupabaseAdminGateway, LocalIdentityProvider],
  useFactory: (supabase: SupabaseAdminGateway, local: LocalIdentityProvider) =>
    process.env.AUTH_IDENTITY_PROVIDER?.trim().toLowerCase() === 'local' ? local : supabase,
};

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
    ProfileDeletionService,
    ReportShareService,
    TechnicianProvisioningService,
    SupabaseAdminGateway,
    LocalIdentityProvider,
    identityProvider,
    ApiAuthGuard,
    PermissionsGuard,
  ],
})
export class AdminModule {}
