import { Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module';
import { DatabaseModule } from '../database/database.module';
import { RoutingModule } from '../routing/routing.module';
import { GroupTemplateController } from './group-template.controller';
import { GroupTemplateService } from './group-template.service';
import { LeaseInspectionsController } from './lease-inspections.controller';
import { LeaseInspectionScheduler } from './lease-inspections.scheduler';
import { LeaseInspectionService } from './lease-inspections.service';
import { PlanAdvisorService } from './plan-advisor.service';
import { TbpPlanScheduler } from './tbp-plan.scheduler';
import { PlanBuildGuard } from './plan-build-guard';
import { PlanningController } from './planning.controller';
import { QuarterPlannerService } from './quarter-planner.service';
import { TbpGroupFileController } from './tbp-group-file.controller';
import { TbpPlanService } from './tbp-plan.service';
import { TbpPublishService } from './tbp-publish.service';
import { TbpStopEditService } from './tbp-stop-edit.service';

@Module({
  imports: [DatabaseModule, RoutingModule, AdminModule],
  controllers: [PlanningController, TbpGroupFileController, GroupTemplateController, LeaseInspectionsController],
  providers: [
    TbpPlanService,
    QuarterPlannerService,
    TbpPublishService,
    TbpPlanScheduler,
    TbpStopEditService,
    PlanAdvisorService,
    PlanBuildGuard,
    LeaseInspectionService,
    LeaseInspectionScheduler,
    GroupTemplateService,
  ],
  exports: [TbpPlanService, QuarterPlannerService, TbpPublishService, TbpPlanScheduler],
})
export class PlanningModule {}
