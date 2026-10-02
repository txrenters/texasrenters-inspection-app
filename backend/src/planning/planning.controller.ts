/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InspectionStatus, InspectionType, PlanOriginKind, TbpPlanStatus, TbpStopStatus } from '@prisma/client';
import { haversineMeters, type Quarter, quarterLabel } from '@texasrenters/shared';

import {
  ApiAuthGuard,
  PermissionsGuard,
  RequirePermissions,
  auditActor,
  type AuthenticatedRequest,
} from '../common/auth';
import { businessDate, businessInstant } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { holdRequestOpen } from '../common/long-request';
import { PrismaService } from '../common/prisma.service';
import { GoogleRoutesClient } from '../routing/google-routes.client';
import { MapboxDirectionsClient } from '../routing/mapbox-directions.client';
import { BUILDING_POSITION_SELECT, propertyPosition } from '../admin/property-position';
import { toLatLngPath } from '../routing/route.service';
import { PlanAdvisorService } from './plan-advisor.service';
import { PlanBuildGuard } from './plan-build-guard';
import { LateMoveOutService } from './late-move-outs.service';
import {
  LateMoveOutMoveDto,
  OfficeDetailsImportDto,
  PlanAdviceApplyDto,
  PlanQuarterDto,
  PlanRoutingSettingsDto,
  PlanStopEditDto,
  PlanStopListQueryDto,
  PlanStopTypeDto,
} from './planning.dto';
import { QuarterPlannerService } from './quarter-planner.service';
import { TbpPlanScheduler } from './tbp-plan.scheduler';
import { TbpPlanService } from './tbp-plan.service';
import { TbpPublishService } from './tbp-publish.service';
import { TbpStopEditService } from './tbp-stop-edit.service';

export const PLANNING_TAG = 'Quarterly planning';

/**
 * Road lines drawn for planned days, kept while the stops are the same.
 *
 * A coordinator clicks between days while reviewing; each draw is a Google
 * call, and the line for an unchanged day does not change. Bounded, because
 * this lives in the one backend process.
 */
const MAX_DRAWN_DAYS = 200;

type LatLng = [number, number];

/** A drawn day: the home leg apart from the drive between its properties, which is the one the limit counts. */
interface DrawnDay {
  geometry: LatLng[];
  homeGeometry: LatLng[];
  legs: { durationSeconds: number; distanceMeters: number }[];
  /** Which router drew it, cached with the line so a hit does not claim the wrong one. */
  source: 'MAPBOX_FREE_FLOW' | 'GOOGLE_TRAFFIC_AWARE';
}

/**
 * A road line from home through a day's stops, cut where it reaches the first.
 *
 * One Google call draws the whole drive, and the console shows the home leg
 * differently: it is driven, and not counted. Google snaps a stop to its road,
 * so the line passes the first stop rather than through its coordinates, and
 * can pass it again later in the day. So the cut is found by distance along the
 * line -- the home leg's own length, as Google measured it -- and settled on the
 * vertex nearest the stop around there. Without a length, it is the first
 * vertex beside the stop, or the nearest one on the whole line.
 */
export function splitAtFirstStop(
  path: readonly LatLng[],
  first: { latitude: number; longitude: number },
  homeLegMeters?: number,
) {
  if (path.length < 2) return { homeGeometry: [...path], geometry: [] as LatLng[] };
  const toStop = ([latitude, longitude]: LatLng) => haversineMeters({ latitude, longitude }, first);
  const nearestIn = (from: number, to: number) => {
    let best = from;
    for (let index = from; index <= to; index += 1) if (toStop(path[index]!) < toStop(path[best]!)) best = index;
    return best;
  };

  let cut: number;
  if (homeLegMeters && homeLegMeters > 0) {
    // Metres along the line to each vertex. A drawn line runs a little short of
    // the road it follows, so the stop is looked for within a margin of the
    // leg's length -- never far enough to reach a later pass by the same stop.
    const along = [0];
    for (let index = 1; index < path.length; index += 1) {
      const [latitude, longitude] = path[index - 1]!;
      along.push(along[index - 1]! + haversineMeters({ latitude, longitude }, { latitude: path[index]![0], longitude: path[index]![1] }));
    }
    const margin = Math.max(250, homeLegMeters * 0.05);
    const near = along.flatMap((metres, index) => (Math.abs(metres - homeLegMeters) <= margin ? [index] : []));
    cut = near.length
      ? near.reduce((best, index) => (toStop(path[index]!) < toStop(path[best]!) ? index : best), near[0]!)
      : Math.max(0, along.findIndex((metres) => metres >= homeLegMeters));
  } else {
    cut = path.findIndex((point) => toStop(point) <= 60);
    if (cut === -1) cut = nearestIn(0, path.length - 1);
  }
  return { homeGeometry: path.slice(0, cut + 1), geometry: path.slice(cut) };
}

@ApiTags(PLANNING_TAG)
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/planning')
export class PlanningController {
  private readonly drawnDays = new Map<string, DrawnDay>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TbpPlanService) private readonly plans: TbpPlanService,
    @Inject(QuarterPlannerService) private readonly planner: QuarterPlannerService,
    @Inject(TbpPublishService) private readonly publisher: TbpPublishService,
    @Inject(TbpPlanScheduler) private readonly scheduler: TbpPlanScheduler,
    @Inject(GoogleRoutesClient) private readonly google: GoogleRoutesClient,
    @Inject(MapboxDirectionsClient) private readonly mapbox: MapboxDirectionsClient,
    @Inject(TbpStopEditService) private readonly edits: TbpStopEditService,
    @Inject(PlanBuildGuard) private readonly builds: PlanBuildGuard,
    @Inject(PlanAdvisorService) private readonly advisor: PlanAdvisorService,
    @Inject(LateMoveOutService) private readonly lateMoveOuts: LateMoveOutService,
  ) {}

  /**
   * Move-outs and move-ins booked onto a technician's benefit-package day after
   * the quarter was published, with the visits to move to the Monday after.
   * See `LateMoveOutService`.
   */
  @Get('quarters/:planId/late-move-outs')
  @RequirePermissions('planning:read')
  lateMoveOutConflicts(@Req() request: AuthenticatedRequest, @Param('planId', ParseUUIDPipe) planId: string) {
    return this.lateMoveOuts.conflicts(request.user.organizationId, planId);
  }

  /**
   * Moves the visits the office confirmed to the Monday after their day: here,
   * in Jobber, and their plan stops with them -- a reschedule as the console
   * makes one, so it takes that grant as well as the planner's.
   */
  @Post('quarters/:planId/late-move-outs/move')
  @RequirePermissions('planning:publish', 'inspections:manage')
  @HttpCode(200)
  moveLateMoveOutVisits(
    @Req() request: AuthenticatedRequest,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() body: LateMoveOutMoveDto,
  ) {
    return this.lateMoveOuts.moveToMonday(request.user, planId, body);
  }

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
          minStopsPerDay: true,
          maxStopsPerDay: true,
          maxLegMinutes: true,
          holidays: true,
        excludedZones: true,
          startsOn: true,
          crewTechnicianIds: true,
          jobberUnassigned: true,
          groupTemplateId: true,
          groupTemplateRevision: true,
          // Named, so the build dialog can say which grouping the quarter has, and whether it changed since.
          groupTemplate: { select: { id: true, name: true, revision: true, archivedAt: true } },
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

  /**
   * The plan's visits, with everything the console's visit window shows: what
   * Jobber will be sent, the property and its tenancy, and why the visit is the
   * kind it is.
   */
  @Get('quarters/:planId/stops')
  @RequirePermissions('planning:read')
  async stops(
    @Req() request: AuthenticatedRequest,
    @Param('planId') planId: string,
    @Query() query: PlanStopListQueryDto,
  ) {
    const organizationId = request.user.organizationId;
    const stops = await this.prisma.tbpQuarterPlanStop.findMany({
      where: {
        planId,
        organizationId,
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: { sequence: 'asc' },
      take: query.pageSize,
      skip: (query.page - 1) * query.pageSize,
      select: {
        id: true,
        sequence: true,
        previousSequence: true,
        previousVisitOn: true,
        previousVisitMonth: true,
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
        jobberVisitId: true,
        hvacFilterSizes: true,
        previousTechnicianId: true,
        scheduleOverriddenAt: true,
        technicianOverriddenAt: true,
        visitTitleOverriddenAt: true,
        visitDetailsOverriddenAt: true,
        onSiteMinutesOverriddenAt: true,
        unitOverriddenAt: true,
        propertywareUnit: { select: { id: true, name: true, addressLine1: true } },
        propertywareBuilding: {
          select: {
            // Where it is, for the map of the visits that need attention.
            latitude: true,
            longitude: true,
            geofence: { select: { latitude: true, longitude: true } },
            // A building of several units: the ones a coordinator can choose from.
            units: {
              where: { isActive: true },
              select: { id: true, name: true, addressLine1: true },
              orderBy: { name: 'asc' },
            },
          },
        },
        tenant: {
          select: {
            leaseName: true,
            addressLine1: true,
            city: true,
            state: true,
            postalCode: true,
            managementPlan: true,
            hvacPlan: true,
            startDate: true,
            endDate: true,
            hvacFilterLocation: true,
            hvacFilterSizes: true,
            lastFilterDelivery: true,
            lastHvacInspection: true,
            lastOccupiedInspection: true,
          },
        },
      },
    });

    // Last quarter's technician, by name: the stop keeps only the id.
    const previousIds = [
      ...new Set(stops.map((stop) => stop.previousTechnicianId).filter((id): id is string => Boolean(id))),
    ];
    const previous = previousIds.length
      ? await this.prisma.userProfile.findMany({
          where: { id: { in: previousIds }, memberships: { some: { organizationId } } },
          select: { id: true, displayName: true },
        })
      : [];
    const names = new Map(previous.map((technician) => [technician.id, technician.displayName]));
    // A quarter sent out to nobody names its days' groups, not people.
    const groups = await this.planner.dayGroups(
      organizationId,
      planId,
      stops.flatMap((stop) => (stop.assignedTechnicianId ? [stop.assignedTechnicianId] : [])),
    );
    return stops.map(({ previousTechnicianId, propertywareBuilding, ...stop }) => ({
      ...stop,
      assignedTechnician:
        groups && stop.assignedTechnician
          ? { ...stop.assignedTechnician, displayName: groups.get(stop.assignedTechnician.id) ?? 'Day group' }
          : stop.assignedTechnician,
      // Prisma gives a decimal; the console wants a number it can put on a map.
      latitude: propertyPosition(propertywareBuilding)?.latitude ?? null,
      longitude: propertyPosition(propertywareBuilding)?.longitude ?? null,
      buildingUnits: propertywareBuilding?.units ?? [],
      previousTechnician: previousTechnicianId
        ? { id: previousTechnicianId, displayName: names.get(previousTechnicianId) ?? null }
        : null,
    }));
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
    const [days, stops, anchors] = await Promise.all([
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
          homeDriveSeconds: true,
          homeDriveMeters: true,
          originKind: true,
          durationSource: true,
          departureAssumedAt: true,
          // The office's template group the day was laid out from, as it was then (see below).
          templateGroupId: true,
          templateGroupPosition: true,
          templateGroupName: true,
          templateGroupColor: true,
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
          propertywareBuilding: { select: { id: true, ...BUILDING_POSITION_SELECT } },
        },
      }),
      this.prisma.tbpQuarterPlanAnchor.findMany({
        where: { planId, organizationId },
        orderBy: [{ date: 'asc' }, { positionInDay: 'asc' }],
        select: {
          id: true,
          inspectionId: true,
          technicianId: true,
          date: true,
          onSiteMinutes: true,
          positionInDay: true,
          driveSecondsForecast: true,
          inspection: {
            select: {
              inspectionType: true,
              scheduledAt: true,
              status: true,
              propertywareBuilding: { select: { id: true, addressLine1: true, city: true, ...BUILDING_POSITION_SELECT } },
              assignments: { where: { isCurrent: true }, select: { technician: { select: { id: true, displayName: true } } } },
            },
          },
        },
      }),
    ]);

    const byDay = new Map<string, typeof stops>();
    for (const stop of stops) {
      const key = `${stop.scheduledOn!.toISOString().slice(0, 10)}|${stop.assignedTechnicianId}`;
      byDay.set(key, [...(byDay.get(key) ?? []), stop]);
    }
    const anchorsByDay = new Map<string, typeof anchors>();
    for (const anchor of anchors) {
      const key = `${anchor.date.toISOString().slice(0, 10)}|${anchor.technicianId}`;
      anchorsByDay.set(key, [...(anchorsByDay.get(key) ?? []), anchor]);
    }

    // A quarter sent out to nobody names its days' groups, not people.
    const groups = await this.planner.dayGroups(
      organizationId,
      planId,
      days.map((day) => day.technicianId),
    );
    return days.map(({ templateGroupId, templateGroupPosition, templateGroupName, templateGroupColor, ...day }) => ({
      ...day,
      // Its number, name and colour as they were when the day was laid out, as
      // in the Group maker: kept on the day, because the template's own groups
      // are made again each time it is saved (the office, 2026-10-03).
      templateGroup:
        templateGroupPosition == null
          ? null
          : {
              id: templateGroupId,
              position: templateGroupPosition,
              name: templateGroupName ?? '',
              color: templateGroupColor ?? '',
            },
      technician: groups
        ? { ...day.technician, displayName: groups.get(day.technicianId) ?? 'Day group' }
        : day.technician,
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
        buildingId: stop.propertywareBuilding?.id ?? null,
        latitude: propertyPosition(stop.propertywareBuilding)?.latitude ?? null,
        longitude: propertyPosition(stop.propertywareBuilding)?.longitude ?? null,
      })),
      // The move-outs and move-ins the day is built around (the office, 2026-09-17 and -18).
      anchors: (anchorsByDay.get(`${day.date.toISOString().slice(0, 10)}|${day.technicianId}`) ?? []).map((anchor) => {
        const building = anchor.inspection.propertywareBuilding;
        const assigned = anchor.inspection.assignments[0]?.technician ?? null;
        const kind = anchor.inspection.inspectionType === InspectionType.MOVE_IN ? ('MOVE_IN' as const) : ('MOVE_OUT' as const);
        return {
          id: anchor.id,
          inspectionId: anchor.inspectionId,
          kind,
          positionInDay: anchor.positionInDay,
          onSiteMinutes: anchor.onSiteMinutes,
          driveSecondsForecast: anchor.driveSecondsForecast,
          address: building?.addressLine1 ?? null,
          city: building?.city ?? null,
          buildingId: building?.id ?? null,
          latitude: propertyPosition(building)?.latitude ?? null,
          longitude: propertyPosition(building)?.longitude ?? null,
          // Whoever it is assigned to now. A move-out or move-in is on the day of whoever it was assigned to
          // when the plan was laid out (2026-10-01); assigned to somebody else since, the day no longer holds it.
          assignedTechnician: assigned,
          // Moved or cancelled since the plan was laid out: a rebuild places the day again.
          scheduledOn: anchor.inspection.scheduledAt.toISOString().slice(0, 10),
          cancelled: anchor.inspection.status === InspectionStatus.CANCELLED,
        };
      }),
    }));
  }

  /**
   * The crew the plan's quarter goes out with and the zones it goes round.
   *
   * The office's crew each has one zone a day and moves one zone on each
   * planned day (2026-10-03). The page shows who goes out, and the zones too far
   * for a day's drive, so a coordinator can see why a visit went to whom.
   */
  @Get('quarters/:planId/rotation')
  @RequirePermissions('planning:read')
  rotation(@Req() request: AuthenticatedRequest, @Param('planId') planId: string) {
    return this.planner.rotation(request.user.organizationId, planId);
  }

  /**
   * The road line through one planned day, for the map.
   *
   * Drawn on request rather than stored: a plan holds sixty-odd days and a
   * coordinator looks at a handful. With no Google key the line is empty and
   * the console joins the stops with straight lines, saying so.
   *
   * The technician's home is where the day starts -- the "From" on the map --
   * and is read from the planning profile at the time of drawing, the one place
   * the address is kept. A day routed from it starts the line there, with the
   * leg to the first stop returned apart; a day built before days started from
   * home still shows the home, with no leg drawn to it.
   */
  @Get('quarters/:planId/days/:dayId/route')
  @RequirePermissions('planning:read')
  async dayRoute(@Req() request: AuthenticatedRequest, @Param('planId') planId: string, @Param('dayId') dayId: string) {
    const organizationId = request.user.organizationId;
    const day = await this.prisma.tbpQuarterPlanDay.findFirst({
      where: { id: dayId, planId, organizationId },
      select: { id: true, date: true, technicianId: true, originKind: true },
    });
    if (!day) throw new ApplicationError(404, 'PLAN_DAY_NOT_FOUND', 'This planned day does not exist.');

    const [stops, anchors] = await Promise.all([
      this.prisma.tbpQuarterPlanStop.findMany({
        where: { planId, organizationId, scheduledOn: day.date, assignedTechnicianId: day.technicianId },
        orderBy: { positionInDay: 'asc' },
        select: { id: true, positionInDay: true, propertywareBuilding: { select: BUILDING_POSITION_SELECT } },
      }),
      // The day's move-outs are on its road, in their places among the visits.
      this.prisma.tbpQuarterPlanAnchor.findMany({
        where: { planId, organizationId, date: day.date, technicianId: day.technicianId },
        select: { id: true, positionInDay: true, inspection: { select: { propertywareBuilding: { select: BUILDING_POSITION_SELECT } } } },
      }),
    ]);
    const points = [
      ...stops.map((stop) => ({ id: stop.id, position: stop.positionInDay, building: stop.propertywareBuilding })),
      ...anchors.map((anchor) => ({ id: anchor.id, position: anchor.positionInDay, building: anchor.inspection.propertywareBuilding })),
    ]
      .sort((left, right) => (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER))
      .flatMap((stop) => {
        const at = propertyPosition(stop.building);
        return at ? [{ id: stop.id, ...at }] : [];
      });
    const profile = await this.prisma.technicianPlanningProfile.findFirst({
      where: { technicianId: day.technicianId, organizationId },
      select: { homeLatitude: true, homeLongitude: true, homeGeocodedFor: true },
    });
    const home =
      profile?.homeLatitude != null && profile?.homeLongitude != null
        ? {
            latitude: Number(profile.homeLatitude),
            longitude: Number(profile.homeLongitude),
            address: profile.homeGeocodedFor ?? null,
          }
        : null;
    // Only a day routed from home drives from it.
    const start = day.originKind === PlanOriginKind.HOME ? home : null;
    const undrawn = { source: null, geometry: [], homeGeometry: [], legs: [], home };
    if (points.length === 0 || points.length + (start ? 1 : 0) < 2) return undrawn;

    const key = `${day.id}:${start ? `${start.latitude},${start.longitude};` : ''}${points.map((point) => point.id).join(',')}`;
    const cached = this.drawnDays.get(key);
    if (cached) return { home, ...cached };

    const date = day.date.toISOString().slice(0, 10);
    const waypoints = start ? [start, ...points] : points;
    /**
     * Mapbox draws the road, and Google is the fallback rather than the other
     * way round.
     *
     * The office was reading a quarter against straight lines between its
     * stops: the day map draws whatever geometry arrives, this asked Google,
     * and that account's billing had lapsed -- so every day came back undrawn
     * and the console said so in small grey text above a map of chords across
     * Houston.
     */
    const viaMapbox = this.mapbox.configured ? await this.mapbox.route(waypoints) : null;
    const drawn =
      viaMapbox ?? (await this.google.route(waypoints, businessInstant(date, '09:00:00')));
    if (!drawn) return undrawn;
    const source = viaMapbox ? ('MAPBOX_FREE_FLOW' as const) : ('GOOGLE_TRAFFIC_AWARE' as const);

    // `[lat, lng]`, the order a map draws in; Google's decoder gives `[lon, lat]`.
    const path = toLatLngPath(drawn.geometry);
    const line: DrawnDay = start
      ? {
          ...splitAtFirstStop(path, points[0]!, drawn.legs[0]?.distanceMeters),
          legs: drawn.legs.slice(1),
          source,
        }
      : { geometry: path, homeGeometry: [], legs: drawn.legs, source };
    if (this.drawnDays.size >= MAX_DRAWN_DAYS) this.drawnDays.delete(this.drawnDays.keys().next().value!);
    this.drawnDays.set(key, line);
    return { home, ...line };
  }

  /**
   * Build or rebuild a quarter's draft by hand.
   *
   * `planning:publish` rather than `planning:read`, even though this creates
   * nothing real: regenerating replaces the ordering a coordinator may have
   * been reviewing, and that is not a read.
   *
   * The console asks who to send out and when to start before it builds (the
   * office, 2026-09-19), and both are kept on the plan for the next rebuild;
   * the choice is audited, as the crew is a coordinator's decision. Days are
   * never laid out before today.
   *
   * Minutes of work, because Google's drive times are paced. The request is
   * held open past the server's 30-second idle timeout, which cut the console
   * off with a 502 while the build carried on (2026-09-16), and a second build
   * while one runs is refused rather than written over the top of it.
   *
   * A published visit is never moved from here. `movePublishedVisits` is
   * accepted in the body, because consoles up to 2026-09-30 send it on every
   * build, and deliberately not passed on: moving a visit sends Jobber a visit
   * edit, which production has never sent. Only `quarters/:planId/route` moves one.
   */
  @Post('quarters')
  @RequirePermissions('planning:publish')
  generate(@Req() request: AuthenticatedRequest, @Body() body: PlanQuarterDto) {
    const { year, quarter: number, ...settings } = body;
    const quarter: Quarter = { year, quarter: number as Quarter['quarter'] };
    const organizationId = request.user.organizationId;
    holdRequestOpen(request);
    return this.builds.run(organizationId, quarterLabel(quarter), async () => {
      const generated = await this.plans.generate(organizationId, quarter);
      const routed = await this.planner.route(organizationId, generated.planId, settings, { today: businessDate() });
      await this.auditBuild(request, generated.planId, routed);
      return { ...generated, routing: routed };
    });
  }

  /** Lay the draft's days out again, with the plan's settings or new ones. Minutes of work, as a build is. */
  @Post('quarters/:planId/route')
  @RequirePermissions('planning:publish')
  async route(
    @Req() request: AuthenticatedRequest,
    @Param('planId') planId: string,
    @Body() body: PlanRoutingSettingsDto,
  ) {
    const organizationId = request.user.organizationId;
    holdRequestOpen(request);
    const plan = await this.prisma.tbpQuarterPlan.findFirst({
      where: { id: planId, organizationId },
      select: { quarterYear: true, quarterNumber: true },
    });
    const label = plan
      ? quarterLabel({ year: plan.quarterYear, quarter: plan.quarterNumber as Quarter['quarter'] })
      : 'quarter';
    return this.builds.run(organizationId, label, async () => {
      const routed = await this.planner.route(organizationId, planId, body, {
        today: businessDate(),
        // Asked for explicitly, never assumed: this is what lets a rebuild
        // move a visit somebody has already been booked to attend.
        movePublishedVisits: body.movePublishedVisits === true,
        actorId: request.user.id,
      });
      await this.auditBuild(request, planId, routed);
      return routed;
    });
  }

  /**
   * Who a coordinator sent out on a plan and from when, and what that made:
   * the crew is theirs to choose (2026-09-19), and "why is nobody on zone 3
   * this quarter" is answered here.
   */
  private async auditBuild(
    request: AuthenticatedRequest,
    planId: string,
    routed: Awaited<ReturnType<QuarterPlannerService['route']>>,
  ) {
    await this.prisma.auditLog.create({
      data: {
        organizationId: request.user.organizationId,
        ...auditActor(request.user),
        action: 'TBP_PLAN_BUILT',
        entityType: 'TbpQuarterPlan',
        entityId: planId,
        metadata: {
          quarter: quarterLabel(routed.quarter),
          technicianIds: routed.settings.technicianIds,
          startsOn: routed.settings.startsOn,
          maxLegMinutes: routed.settings.maxLegMinutes,
          placed: routed.placed,
          unplaced: routed.unplaced.length,
          days: routed.days,
          // Which grouping decided the days: the office's template, or the planner's own.
          groupTemplateId: routed.template?.id ?? null,
          groupTemplateRevision: routed.template?.revision ?? null,
          notInTemplate: routed.template?.notInTemplate ?? null,
        },
      },
    });
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
   * Re-read this quarter's filter sizes from the tenant report.
   *
   * Asked for rather than automatic, and allowed on a published quarter, which
   * is the case it exists for: the office fills a missing size into
   * Propertyware and needs the visits a technician is already holding to catch
   * up. See `TbpPlanService.refreshFilterSizes`.
   */
  @Post('quarters/:planId/filter-sizes')
  @RequirePermissions('planning:publish')
  @HttpCode(200)
  refreshFilterSizes(@Req() request: AuthenticatedRequest, @Param('planId') planId: string) {
    return this.plans.refreshFilterSizes(request.user, planId);
  }

  /**
   * Turn the draft into real inspections.
   *
   * Synchronous, and that is a deliberate limit rather than an oversight. A few
   * hundred stops at one short transaction each takes tens of seconds or more,
   * which a request held open past the server's idle timeout can carry — and
   * the alternative, a detached promise, would report
   * success before anything had been created and leave a failure visible only
   * in the logs. The plan's own status is the progress record either way, so a
   * client that times out can poll `GET quarters` and see PUBLISHING.
   */
  @Post('quarters/:planId/publish')
  @RequirePermissions('planning:publish')
  @HttpCode(200)
  publish(@Req() request: AuthenticatedRequest, @Param('planId') planId: string) {
    // Never while a build is rewriting the very stops this would publish.
    this.builds.refuseWhileBuilding(request.user.organizationId);
    holdRequestOpen(request);
    return this.publisher.publish(request.user, planId);
  }

  /**
   * What AI makes of the quarter: what looks wrong, and the moves worth making.
   *
   * One call to the provider the organization has configured. Nothing is
   * changed here -- every move it proposes is judged against the office's own
   * rules first, and the office applies the ones it wants
   * (`quarters/:planId/advice/apply`).
   */
  @Post('quarters/:planId/advice')
  @RequirePermissions('planning:publish')
  @HttpCode(200)
  advice(@Req() request: AuthenticatedRequest, @Param('planId') planId: string) {
    this.builds.refuseWhileBuilding(request.user.organizationId);
    holdRequestOpen(request);
    return this.advisor.advise(request.user, planId);
  }

  /** The moves the office took from the advice, each judged again before it is written. */
  @Post('quarters/:planId/advice/apply')
  @RequirePermissions('planning:publish')
  @HttpCode(200)
  applyAdvice(
    @Req() request: AuthenticatedRequest,
    @Param('planId') planId: string,
    @Body() body: PlanAdviceApplyDto,
  ) {
    this.builds.refuseWhileBuilding(request.user.organizationId);
    holdRequestOpen(request);
    return this.advisor.apply(request.user, planId, body.moves);
  }

  /** A coordinator deciding a stop is an HVAC or an occupied inspection; its day is measured again. */
  @Post('stops/:stopId/inspection-type')
  @RequirePermissions('planning:publish')
  @HttpCode(200)
  setInspectionType(
    @Req() request: AuthenticatedRequest,
    @Param('stopId') stopId: string,
    @Body() body: PlanStopTypeDto,
  ) {
    return this.edits.edit(request.user, stopId, { inspectionType: body.inspectionType });
  }

  /**
   * A coordinator's change to one visit in a draft, from its window: the day,
   * technician, unit, title, Details, kind of visit or length.
   *
   * Kept through a rebuild, and the days it touches are measured again. A
   * visit routing could not place is placed by giving it a day and a
   * technician; a tenancy in a building of several units, by choosing its unit.
   */
  @Patch('stops/:stopId')
  @RequirePermissions('planning:publish')
  editStop(@Req() request: AuthenticatedRequest, @Param('stopId') stopId: string, @Body() body: PlanStopEditDto) {
    return this.edits.edit(request.user, stopId, body);
  }

  /** The technicians a visit can be given to, the benefit-package crew first. */
  @Get('technicians')
  @RequirePermissions('planning:read')
  technicians(@Req() request: AuthenticatedRequest) {
    return this.edits.technicians(request.user.organizationId);
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
