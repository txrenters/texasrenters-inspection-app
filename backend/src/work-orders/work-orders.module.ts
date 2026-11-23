import { Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module';
import { AiProviderSettingsService } from '../admin/ai-provider-settings.service';
import { ApiAuthGuard, PermissionsGuard } from '../common/auth';
import { TechnicianScopeSheetService } from './technician-scope-sheet';
import { WorkOrderIntakeService } from './work-order-intake.service';
import { WorkOrderMatchingController } from './work-order-matching.controller';
import { WorkOrderTriageService } from './work-order-triage.service';

/**
 * Work orders handed over by the maintenance app. The hand-off route lives on
 * the gateway controller, where every third-party route is; this module
 * provides what files them, and what matches each to the technician who fits.
 */
@Module({
  imports: [AdminModule],
  controllers: [WorkOrderMatchingController],
  providers: [
    WorkOrderIntakeService,
    WorkOrderTriageService,
    TechnicianScopeSheetService,
    AiProviderSettingsService,
    ApiAuthGuard,
    PermissionsGuard,
  ],
  exports: [WorkOrderIntakeService],
})
export class WorkOrdersModule {}
