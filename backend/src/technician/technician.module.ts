import { Module } from '@nestjs/common';

import { ApiAuthGuard, RolesGuard } from '../common/auth';
import { FloorPlanStorageService } from '../admin/floor-plan-storage.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { InspectionMediaStorageService } from './inspection-media-storage.service';
import { TechnicianController } from './technician.controller';
import { TechnicianService } from './technician.service';

@Module({
  imports: [RealtimeModule],
  controllers: [TechnicianController],
  providers: [
    TechnicianService,
    FloorPlanStorageService,
    InspectionMediaStorageService,
    ApiAuthGuard,
    RolesGuard,
  ],
})
export class TechnicianModule {}
