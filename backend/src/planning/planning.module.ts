import { Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module';
import { DatabaseModule } from '../database/database.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RoutingModule } from '../routing/routing.module';
import { GroupTemplateController } from './group-template.controller';
import { GroupTemplateGateway } from './group-template.gateway';
import { GroupTemplateService } from './group-template.service';
import { LeaseInspectionsController } from './lease-inspections.controller';
import { LeaseInspectionScheduler } from './lease-inspections.scheduler';
import { LateMoveOutService } from './late-move-outs.service';
import { LeaseInspectionService } from './lease-inspections.service';
import { TbpPlanScheduler } from './tbp-plan.scheduler';
import { PlanBuildGuard } from './plan-build-guard';
import { PlanDayMoveService } from './plan-day-move.service';
import { PlanDayRouteController } from './plan-day-route.controller';
import { PlanningController } from './planning.controller';
import { QuarterPlannerService } from './quarter-planner.service';
import { TbpGroupFileController } from './tbp-group-file.controller';
import { TbpPlanService } from './tbp-plan.service';
import { TbpPublishService } from './tbp-publish.service';
import { TbpStopEditService } from './tbp-stop-edit.service';

@Module({
  // Realtime: a lease call-off tells the technician whose job it was (2026-10-07).
  imports: [DatabaseModule, RoutingModule, AdminModule, RealtimeModule],
  controllers: [
    PlanningController,
    TbpGroupFileController,
    GroupTemplateController,
    LeaseInspectionsController,
    PlanDayRouteController,
  ],
  providers: [
    TbpPlanService,
    QuarterPlannerService,
    TbpPublishService,
    TbpPlanScheduler,
    TbpStopEditService,
    PlanBuildGuard,
    LeaseInspectionService,
    LeaseInspectionScheduler,
    GroupTemplateService,
    GroupTemplateGateway,
    LateMoveOutService,
    PlanDayMoveService,
  ],
  exports: [TbpPlanService, QuarterPlannerService, TbpPublishService, TbpPlanScheduler],
})
export class PlanningModule {}
