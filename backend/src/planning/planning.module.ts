import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { TbpPlanScheduler } from './tbp-plan.scheduler';
import { TbpPlanService } from './tbp-plan.service';

@Module({
  imports: [DatabaseModule],
  providers: [TbpPlanService, TbpPlanScheduler],
  exports: [TbpPlanService, TbpPlanScheduler],
})
export class PlanningModule {}
