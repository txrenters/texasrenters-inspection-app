import { Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module';
import { DatabaseModule } from '../database/database.module';
import { RoutingModule } from '../routing/routing.module';
import { TbpPlanScheduler } from './tbp-plan.scheduler';
import { QuarterPlannerService } from './quarter-planner.service';
import { TbpPlanService } from './tbp-plan.service';

@Module({
  imports: [DatabaseModule, RoutingModule, AdminModule],
  providers: [TbpPlanService, QuarterPlannerService, TbpPlanScheduler],
  exports: [TbpPlanService, QuarterPlannerService, TbpPlanScheduler],
})
export class PlanningModule {}
