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
import { businessInstant } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { GoogleRoutesClient } from '../routing/google-routes.client';
import { toLatLngPath } from '../routing/route.service';
import {
  OfficeDetailsImportDto,
  PlanQuarterDto,
  PlanRoutingSettingsDto,
  PlanStopListQueryDto,
  PlanStopTypeDto,
} from './planning.dto';
import { QuarterPlannerService } from './quarter-planner.service';
import { TbpPlanScheduler } from './tbp-plan.scheduler';
import { TbpPlanService } from './tbp-plan.service';
import { TbpPublishService } from './tbp-publish.service';

export const PLANNING_TAG = 'Quarterly planning';

/**
 * Road lines drawn for planned days, kept while the stops are the same.
 *
 * A coordinator clicks between days while reviewing; each draw is a Google
 * call, and the line for an unchanged day does not change. Bounded, because
 * this lives in the one backend process.
 */
const MAX_DRAWN_DAYS = 200;

@ApiTags(PLANNING_TAG)
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/planning')
export class PlanningController {
  private readonly drawnDays = new Map<string, { geometry: [number, number][]; legs: { durationSeconds: number; distanceMeters: number }[] }>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TbpPlanService) private readonly plans: TbpPlanService,
    @Inject(QuarterPlannerService) private readonly planner: QuarterPlannerService,
    @Inject(TbpPublishService) private readonly publisher: TbpPublishService,
    @Inject(TbpPlanScheduler) private readonly scheduler: TbpPlanScheduler,
    @Inject(GoogleRoutesClient) private readonly google: GoogleRoutesClient,
  ) {}

  /** Whether the cron is alive and when it next wakes, for the console. */
  @Get('schedule')
  @RequirePermissions('planning:read')
  schedule() {
    return this.scheduler.describe();
  }

  @Get('quarters')
  @RequirePermissions('planning:read')
  async quarters(@Req() request: AuthenticatedRequest) {
    const organizationId = request.user.organizationId;
    const [plans, kinds] = await Promise.all([
      this.prisma.tbpQuarterPlan.findMany({
        where: { organizationId },
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
          occupiedVisitMinutes: true,
          hvacVisitMinutes: true,
          maxOnSiteMinutes: true,
          maxDriveMinutes: true,
          holidays: true,
          officeDetailsImportedAt: true,
        },
      }),
      this.prisma.tbpQuarterPlanStop.groupBy({
        by: ['planId', 'inspectionType'],
        where: { organizationId, status: { not: TbpStopStatus.EXCLUDED } },
        _count: { _all: true },
      }),
    ]);
    return plans.map((plan) => {
      const count = (inspectionType: string) =>
        kinds.find((row) => row.planId === plan.id && row.inspectionType === inspectionType)?._count._all ?? 0;
      return { ...plan, hvacStopCount: count('HVAC'), occupiedStopCount: count('OCCUPIED') };
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
        inspectionType: true,
        inspectionTypeReason: true,
        inspectionTypeNeedsReview: true,
        inspectionTypeOverriddenAt: true,
        onSiteMinutes: true,
        driveSecondsForecast: true,
        officeDetails: true,
        visitTitle: true,
        visitDetails: true,
        inspectionId: true,
        tenant: {
          select: {
            leaseName: true,
            addressLine1: true,
            city: true,
            postalCode: true,
            managementPlan: true,
            hvacPlan: true,
          },
        },
      },
    });
  }

  /**
   * The forecast per technician-day, with the day's stops in driving order.
   *
   * What the map draws. Stops are joined by day and technician rather than
   * held on the day row, because a coordinator's pinned day or technician is
   * written on the stop.
   */
  @Get('quarters/:planId/days')
  @RequirePermissions('planning:read')
  async days(@Req() request: AuthenticatedRequest, @Param('planId') planId: string) {
    const organizationId = request.user.organizationId;
    const [days, stops] = await Promise.all([
      this.prisma.tbpQuarterPlanDay.findMany({
        where: { planId, organizationId },
        orderBy: [{ date: 'asc' }, { technicianId: 'asc' }],
        select: {
          id: true,
          date: true,
          technicianId: true,
          technician: { select: { id: true, displayName: true } },
          stopCount: true,
          onSiteMinutes: true,
          hvacStopCount: true,
          totalDriveSeconds: true,
          totalDriveMeters: true,
          originKind: true,
          durationSource: true,
          departureAssumedAt: true,
        },
      }),
      this.prisma.tbpQuarterPlanStop.findMany({
        where: {
          planId,
          organizationId,
          scheduledOn: { not: null },
          assignedTechnicianId: { not: null },
          status: { in: [TbpStopStatus.PLANNED, TbpStopStatus.PUBLISHED] },
        },
        orderBy: [{ scheduledOn: 'asc' }, { positionInDay: 'asc' }],
        select: {
          id: true,
          sequence: true,
          scheduledOn: true,
          assignedTechnicianId: true,
          positionInDay: true,
          inspectionType: true,
          onSiteMinutes: true,
          driveSecondsForecast: true,
          zone: true,
          status: true,
          tenant: { select: { addressLine1: true, city: true } },
          propertywareBuilding: { select: { latitude: true, longitude: true } },
        },
      }),
    ]);

    const byDay = new Map<string, typeof stops>();
    for (const stop of stops) {
      const key = `${stop.scheduledOn!.toISOString().slice(0, 10)}|${stop.assignedTechnicianId}`;
      byDay.set(key, [...(byDay.get(key) ?? []), stop]);
    }

    return days.map((day) => ({
      ...day,
      stops: (byDay.get(`${day.date.toISOString().slice(0, 10)}|${day.technicianId}`) ?? []).map((stop) => ({
        id: stop.id,
        sequence: stop.sequence,
        positionInDay: stop.positionInDay,
        inspectionType: stop.inspectionType,
        onSiteMinutes: stop.onSiteMinutes,
        driveSecondsForecast: stop.driveSecondsForecast,
        zone: stop.zone,
        status: stop.status,
        address: stop.tenant.addressLine1,
        city: stop.tenant.city,
        latitude: stop.propertywareBuilding?.latitude === null || stop.propertywareBuilding?.latitude === undefined ? null : Number(stop.propertywareBuilding.latitude),
        longitude: stop.propertywareBuilding?.longitude === null || stop.propertywareBuilding?.longitude === undefined ? null : Number(stop.propertywareBuilding.longitude),
      })),
    }));
  }

  /**
   * The road line through one planned day, for the map.
   *
   * Drawn on request rather than stored: a plan holds sixty-odd days and a
   * coordinator looks at a handful. With no Google key the line is empty and
   * the console joins the stops with straight lines, saying so.
   */
  @Get('quarters/:planId/days/:dayId/route')
  @RequirePermissions('planning:read')
  async dayRoute(@Req() request: AuthenticatedRequest, @Param('planId') planId: string, @Param('dayId') dayId: string) {
    const organizationId = request.user.organizationId;
    const day = await this.prisma.tbpQuarterPlanDay.findFirst({
      where: { id: dayId, planId, organizationId },
      select: { id: true, date: true, technicianId: true },
    });
    if (!day) throw new ApplicationError(404, 'PLAN_DAY_NOT_FOUND', 'This planned day does not exist.');

    const stops = await this.prisma.tbpQuarterPlanStop.findMany({
      where: { planId, organizationId, scheduledOn: day.date, assignedTechnicianId: day.technicianId },
      orderBy: { positionInDay: 'asc' },
      select: { id: true, propertywareBuilding: { select: { latitude: true, longitude: true } } },
    });
    const points = stops
      .filter((stop) => stop.propertywareBuilding?.latitude != null && stop.propertywareBuilding?.longitude != null)
      .map((stop) => ({
        id: stop.id,
        latitude: Number(stop.propertywareBuilding!.latitude),
        longitude: Number(stop.propertywareBuilding!.longitude),
      }));
    if (points.length < 2) return { source: null, geometry: [], legs: [] };

    const key = `${day.id}:${points.map((point) => point.id).join(',')}`;
    const cached = this.drawnDays.get(key);
    if (cached) return { source: 'GOOGLE_TRAFFIC_AWARE', ...cached };

    const date = day.date.toISOString().slice(0, 10);
    const drawn = await this.google.route(points, businessInstant(date, '09:00:00'));
    if (!drawn) return { source: null, geometry: [], legs: [] };

    // `[lat, lng]`, the order a map draws in; Google's decoder gives `[lon, lat]`.
    const line = { geometry: toLatLngPath(drawn.geometry), legs: drawn.legs };
    if (this.drawnDays.size >= MAX_DRAWN_DAYS) this.drawnDays.delete(this.drawnDays.keys().next().value!);
    this.drawnDays.set(key, line);
    return { source: 'GOOGLE_TRAFFIC_AWARE', ...line };
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
    const { year, quarter: number, ...settings } = body;
    const quarter = { year, quarter: number as 1 | 2 | 3 | 4 };
    const generated = await this.plans.generate(request.user.organizationId, quarter);
    const routed = await this.planner.route(request.user.organizationId, generated.planId, settings);
    return { ...generated, routing: routed };
  }

  /** Lay the draft's days out again, with the plan's settings or new ones. */
  @Post('quarters/:planId/route')
  @RequirePermissions('planning:publish')
  route(
    @Req() request: AuthenticatedRequest,
    @Param('planId') planId: string,
    @Body() body: PlanRoutingSettingsDto,
  ) {
    return this.planner.route(request.user.organizationId, planId, body);
  }

  /**
   * The office's sheet of visit Details for the quarter.
   *
   * The console reads the sheet in the browser and sends its rows: the address
   * and the services line. Matched to the plan's tenancies by address, and the
   * addresses nothing matched are returned for the coordinator to check.
   */
  @Post('quarters/:planId/office-details')
  @RequirePermissions('planning:publish')
  @HttpCode(200)
  importOfficeDetails(
    @Req() request: AuthenticatedRequest,
    @Param('planId') planId: string,
    @Body() body: OfficeDetailsImportDto,
  ) {
    return this.plans.importOfficeDetails(request.user, planId, body.rows);
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

  /** A coordinator deciding a stop is an HVAC or an occupied inspection. */
  @Post('stops/:stopId/inspection-type')
  @RequirePermissions('planning:publish')
  @HttpCode(200)
  setInspectionType(
    @Req() request: AuthenticatedRequest,
    @Param('stopId') stopId: string,
    @Body() body: PlanStopTypeDto,
  ) {
    return this.plans.setInspectionType(request.user, stopId, body.inspectionType);
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
