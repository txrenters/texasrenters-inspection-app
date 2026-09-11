/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TbpPlanStatus, TbpStopStatus } from '@prisma/client';

import {
  ApiAuthGuard,
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedRequest,
} from '../common/auth';
import { PrismaService } from '../common/prisma.service';
import { PlanQuarterDto, PlanStopListQueryDto } from './planning.dto';
import { QuarterPlannerService } from './quarter-planner.service';
import { TbpPlanScheduler } from './tbp-plan.scheduler';
import { TbpPlanService } from './tbp-plan.service';
import { TbpPublishService } from './tbp-publish.service';

export const PLANNING_TAG = 'Quarterly planning';

@ApiTags(PLANNING_TAG)
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/planning')
export class PlanningController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TbpPlanService) private readonly plans: TbpPlanService,
    @Inject(QuarterPlannerService) private readonly planner: QuarterPlannerService,
    @Inject(TbpPublishService) private readonly publisher: TbpPublishService,
    @Inject(TbpPlanScheduler) private readonly scheduler: TbpPlanScheduler,
  ) {}

  /** Whether the cron is alive and when it next wakes, for the console. */
  @Get('schedule')
  @RequirePermissions('planning:read')
  schedule() {
    return this.scheduler.describe();
  }

  @Get('quarters')
  @RequirePermissions('planning:read')
  quarters(@Req() request: AuthenticatedRequest) {
    return this.prisma.tbpQuarterPlan.findMany({
      where: { organizationId: request.user.organizationId },
      orderBy: [{ quarterYear: 'desc' }, { quarterNumber: 'desc' }],
      select: {
        id: true,
        quarterYear: true,
        quarterNumber: true,
        quarterStartsOn: true,
        status: true,
        stopCount: true,
        blockedCount: true,
        publishedCount: true,
        unverifiedEnrollmentCount: true,
        generatedAt: true,
        publishedAt: true,
        lastError: true,
      },
    });
  }

  @Get('quarters/:planId/stops')
  @RequirePermissions('planning:read')
  stops(
    @Req() request: AuthenticatedRequest,
    @Param('planId') planId: string,
    @Query() query: PlanStopListQueryDto,
  ) {
    return this.prisma.tbpQuarterPlanStop.findMany({
      where: {
        planId,
        organizationId: request.user.organizationId,
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: { sequence: 'asc' },
      take: query.pageSize,
      skip: (query.page - 1) * query.pageSize,
      select: {
        id: true,
        sequence: true,
        previousSequence: true,
        orderSource: true,
        zone: true,
        scheduledOn: true,
        positionInDay: true,
        assignedTechnicianId: true,
        assignedTechnician: { select: { id: true, displayName: true } },
        unitResolution: true,
        status: true,
        blockedCode: true,
        blockedMessage: true,
        visitTitle: true,
        inspectionId: true,
        tenant: { select: { leaseName: true, addressLine1: true, city: true, postalCode: true } },
      },
    });
  }

  /** The forecast per technician-day, which is what the map draws. */
  @Get('quarters/:planId/days')
  @RequirePermissions('planning:read')
  days(@Req() request: AuthenticatedRequest, @Param('planId') planId: string) {
    return this.prisma.tbpQuarterPlanDay.findMany({
      where: { planId, organizationId: request.user.organizationId },
      orderBy: [{ date: 'asc' }, { technicianId: 'asc' }],
      select: {
        id: true,
        date: true,
        technicianId: true,
        technician: { select: { id: true, displayName: true } },
        stopCount: true,
        totalDriveSeconds: true,
        totalDriveMeters: true,
        originKind: true,
        durationSource: true,
        departureAssumedAt: true,
      },
    });
  }

  /**
   * Build or rebuild a quarter's draft by hand.
   *
   * `planning:publish` rather than `planning:read`, even though this creates
   * nothing real: regenerating replaces the ordering a coordinator may have
   * been reviewing, and that is not a read.
   */
  @Post('quarters')
  @RequirePermissions('planning:publish')
  async generate(@Req() request: AuthenticatedRequest, @Body() body: PlanQuarterDto) {
    const quarter = { year: body.year, quarter: body.quarter as 1 | 2 | 3 | 4 };
    const generated = await this.plans.generate(request.user.organizationId, quarter);
    const routed = await this.planner.route(
      request.user.organizationId,
      generated.planId,
      body.holidays ?? [],
    );
    return { ...generated, routing: routed };
  }

  @Post('quarters/:planId/route')
  @RequirePermissions('planning:publish')
  route(
    @Req() request: AuthenticatedRequest,
    @Param('planId') planId: string,
    @Body() body: PlanQuarterDto,
  ) {
    return this.planner.route(request.user.organizationId, planId, body.holidays ?? []);
  }

  /**
   * Turn the draft into real inspections.
   *
   * Synchronous, and that is a deliberate limit rather than an oversight. A few
   * hundred stops at one short transaction each takes tens of seconds, which a
   * request can carry — and the alternative, a detached promise, would report
   * success before anything had been created and leave a failure visible only
   * in the logs. The plan's own status is the progress record either way, so a
   * client that times out can poll `GET quarters` and see PUBLISHING.
   */
  @Post('quarters/:planId/publish')
  @RequirePermissions('planning:publish')
  @HttpCode(200)
  publish(@Req() request: AuthenticatedRequest, @Param('planId') planId: string) {
    return this.publisher.publish(request.user, planId);
  }

  /**
   * A stop the office has decided not to inspect this quarter.
   *
   * The only way past a blocked stop, and it takes a reason: publishing around
   * one silently would leave a tenancy uninspected with nothing saying why.
   */
  @Post('stops/:stopId/exclude')
  @RequirePermissions('planning:publish')
  async exclude(
    @Req() request: AuthenticatedRequest,
    @Param('stopId') stopId: string,
    @Body() body: { reason?: string },
  ) {
    const reason = body?.reason?.trim();
    if (!reason || reason.length < 2)
      return { excluded: false, message: 'A reason is required to exclude a stop.' };

    const { count } = await this.prisma.tbpQuarterPlanStop.updateMany({
      where: {
        id: stopId,
        organizationId: request.user.organizationId,
        // Published work is real; excluding it here would only hide it from the
        // plan while the inspection and the visit carried on existing.
        status: { in: [TbpStopStatus.PLANNED, TbpStopStatus.BLOCKED, TbpStopStatus.FAILED] },
        plan: { status: { in: [TbpPlanStatus.DRAFT, TbpPlanStatus.PUBLISH_FAILED] } },
      },
      data: { status: TbpStopStatus.EXCLUDED, blockedMessage: reason },
    });
    return { excluded: count === 1 };
  }
}
