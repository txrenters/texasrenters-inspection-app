import { Module } from '@nestjs/common';

import { ApiAuthGuard, RolesGuard } from '../common/auth';
import { RealtimeModule } from '../realtime/realtime.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { FloorPlanAdminService } from './floor-plan-admin.service';
import { FloorPlanExtractionService } from './floor-plan-extraction.service';
import { FloorPlanStorageService } from './floor-plan-storage.service';
import {
  SupabaseAdminGateway,
  TechnicianProvisioningService,
} from './technician-provisioning.service';

@Module({
  imports: [RealtimeModule],
  controllers: [AdminController],
  providers: [
    AdminService,
    FloorPlanAdminService,
    FloorPlanExtractionService,
    FloorPlanStorageService,
    TechnicianProvisioningService,
    SupabaseAdminGateway,
    ApiAuthGuard,
    RolesGuard,
  ],
})
export class AdminModule {}
