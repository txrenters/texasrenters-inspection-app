import { Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module';
import { DatabaseModule } from '../database/database.module';
import { RoutingModule } from '../routing/routing.module';
import { TbpPlanScheduler } from './tbp-plan.scheduler';
import { PlanningController } from './planning.controller';
import { QuarterPlannerService } from './quarter-planner.service';
import { TbpPlanService } from './tbp-plan.service';
import { TbpPublishService } from './tbp-publish.service';
import { TbpStopEditService } from './tbp-stop-edit.service';

@Module({
  imports: [DatabaseModule, RoutingModule, AdminModule],
  controllers: [PlanningController],
  providers: [TbpPlanService, QuarterPlannerService, TbpPublishService, TbpPlanScheduler, TbpStopEditService],
  exports: [TbpPlanService, QuarterPlannerService, TbpPublishService, TbpPlanScheduler],
})
export class PlanningModule {}
