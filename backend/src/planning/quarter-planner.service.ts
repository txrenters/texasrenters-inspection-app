import { Inject, Injectable, Logger } from '@nestjs/common';
import { DriveTimeSource, InspectionType, PlanOriginKind, TbpPlanStatus, TbpStopStatus } from '@prisma/client';
import {
  type AssignedCrew,
  type DayLimits,
  type PlannableDay,
  type PlannableStop,
  type Quarter,
  type UnplacedReason,
  assignQuarter,
  byZoneNumber,
  crewKey,
  estimatedDriveMinutes,
  haversineMeters,
  plannedVisitDaysOfQuarter,
  quarterLabel,
  quarterWeekIndex,
  shortestOpenPathOrder,
  shortestRouteOrder,
  weekStartOf,
  weeklyZoneTechnicians,
  zoneNumberOf,
} from '@texasrenters/shared';

import { TechnicianSkillsService } from '../admin/technician-skills.service';
import { businessInstant } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { GoogleRoutesClient } from '../routing/google-routes.client';
import type { GeoPoint } from '../routing/osrm.client';
import { OsrmClient } from '../routing/osrm.client';

/**
 * When a planned day starts, in Texas: the first job at nine.
 *
 * A quarter is planned months ahead, so Google needs a *when* as well as a
 * where -- a Tuesday morning and a Friday evening are different roads -- and
 * a Texas wall-clock time rather than a UTC hour, which would slide an hour
 * when daylight saving ends in November.
 */
const DAY_STARTS_AT = '09:00:00';

/**
 * How many times days that measure over the drive limit are repaired.
 *
 * Each round moves the stops a measured day could not keep and measures only
 * the days that took them. Whatever still does not fit after that is left for a
 * person rather than chased further at Google's per-element price.
 */
const MAX_REPAIR_ROUNDS = 3;

/** Block codes routing owns, cleared whenever the plan is routed again. */
const ROUTING_BLOCK_CODES = ['NO_COORDINATES', 'NOT_PLACED'];

/** The office's limits and visit lengths, as a coordinator may set them for a plan. */
export interface PlanRoutingSettings {
  occupiedVisitMinutes?: number;
  hvacVisitMinutes?: number;
  maxOnSiteMinutes?: number;
  maxDriveMinutes?: number;
  /**
   * Days the office is closed besides weekends and US federal holidays,
   * `YYYY-MM-DD`. Those are always left out; this is for any other day.
   */
  holidays?: string[];
}

export type RoutingUnplacedReason = UnplacedReason | 'DRIVE_LIMIT' | 'ZONE_OUT_OF_REACH';

export interface RoutingSummary {
  planId: string;
  quarter: Quarter;
  placed: number;
  unplaced: { stopId: string; reason: RoutingUnplacedReason }[];
  capacity: { stops: number; onSiteMinutes: number; availableMinutes: number };
  days: number;
  durationSource: DriveTimeSource | null;
  settings: Required<PlanRoutingSettings>;
  /** Stops moved off a day that measured over the drive limit. */
  repaired: number;
}

/** Who has which zone in each week of a plan's quarter, for the console. */
export interface PlanRotation {
  /** The benefit-package crew, in the order the zones go round. */
  crew: { technicianId: string; displayName: string | null; hasHome: boolean }[];
  /** The zones the crew goes round, in order. */
  zones: string[];
  /** Zones no crew member's home is within the day's drive of. */
  outOfReach: string[];
  weeks: { weekOf: string; zones: { zone: string; technicianId: string }[] }[];
}

/** What a stop routing could not place says, on the stop. */
const UNPLACED_MESSAGE: Record<RoutingUnplacedReason, string> = {
  NO_WORKING_DAYS: 'The quarter has no days to plan this visit on.',
  NO_QUALIFIED_TECHNICIAN:
    'Nobody on the benefit-package crew can take this visit. The crew is set on the technicians’ planning profiles.',
  NO_CAPACITY: 'No day this quarter has room for this visit inside the day limits, with the technician who has its zone.',
  LONGER_THAN_A_DAY: 'This visit is longer than a whole day on site.',
  OUT_OF_REACH: 'This property is further from home, for every technician who could take it, than the day’s drive allows.',
  DRIVE_LIMIT: 'No day it could join keeps the drive, counted from home, inside the limit.',
  ZONE_OUT_OF_REACH:
    'No one on the benefit-package crew lives within the day’s drive of this zone, so the office needs to arrange these visits.',
};

/** A technician-day, measured on real roads where anything could measure it. */
interface MeasuredCrew {
  date: string;
  technicianId: string;
  /** In driving order. */
  stops: PlannableStop[];
  /** Seconds from the stop before, per stop; null for the first, or when nothing measured it. */
  legSeconds: (number | null)[];
  /**
   * The drive the day's limit counts: from home to the first property when the
   * day is routed from home, and between the properties.
   */
  totalDriveSeconds: number | null;
  totalDriveMeters: number | null;
  /** Whether the day was routed from the technician's home. */
  fromHome: boolean;
  /** Home to the first property, when measured. Part of `totalDriveSeconds`. */
  homeDriveSeconds: number | null;
  homeDriveMeters: number | null;
  durationSource: DriveTimeSource | null;
  /**
   * The matrix it was measured with, so trimming the day needs no second call.
   * Holds the home first when the day has one (`homeIndex`).
   */
  matrix: {
    durations: number[][];
    distances: number[][] | null;
    index: Map<string, number>;
    homeIndex: number | null;
  } | null;
}

/** The benefit-package crew, in the order the zones go round, and where each lives. */
export interface Roster {
  technicianIds: string[];
  homes: Map<string, GeoPoint>;
}

@Injectable()
export class QuarterPlannerService {
  private readonly logger = new Logger(QuarterPlannerService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TechnicianSkillsService) private readonly skills: TechnicianSkillsService,
    @Inject(GoogleRoutesClient) private readonly google: GoogleRoutesClient,
    @Inject(OsrmClient) private readonly osrm: OsrmClient,
  ) {}

  /**
   * Give every stop in a draft a day, a technician and a place in the route.
   *
   * Separate from generation because it answers a different question and fails
   * for different reasons. Generation asks *who* is in the quarter and can only
   * be wrong about a tenancy; this asks *when and with whom*, and is wrong when
   * nobody is qualified, when the quarter has no room, or when routing is
   * unavailable. Splitting them means a coordinator can fix a blocked tenancy
   * and re-route without rebuilding the rotation underneath it.
   *
   * The office's rules (2026-09-16) hold for every day it writes:
   * - the crew each has one zone a week, moving one zone on each week, and a
   *   visit goes only to whoever has its zone (`weeklyZoneTechnicians`);
   * - at most `maxOnSiteMinutes` inspecting, and `maxDriveMinutes` driving
   *   counted from home to the first property and between the properties;
   * - no planned visit on a Monday from the quarter's second week on, which is
   *   kept for rescheduled visits.
   * Days are laid out on an estimate, measured on real roads, and a day that
   * measures over is repaired; a stop no day can take is blocked with the
   * reason, never squeezed in.
   */
  async route(organizationId: string, planId: string, input: PlanRoutingSettings = {}): Promise<RoutingSummary> {
    const plan = await this.prisma.tbpQuarterPlan.findFirst({
      where: { id: planId, organizationId },
      select: {
        id: true,
        status: true,
        quarterYear: true,
        quarterNumber: true,
        occupiedVisitMinutes: true,
        hvacVisitMinutes: true,
        maxOnSiteMinutes: true,
        maxDriveMinutes: true,
        holidays: true,
      },
    });
    if (!plan) throw new ApplicationError(404, 'PLAN_NOT_FOUND', 'This plan does not exist.');
    if (plan.status !== TbpPlanStatus.DRAFT)
      // A published stop is an inspection and a Jobber visit; moving it here
      // would only make the plan disagree with both.
      throw new ApplicationError(409, 'PLAN_NOT_DRAFT', 'Only a draft plan can be routed.');

    const quarter: Quarter = { year: plan.quarterYear, quarter: plan.quarterNumber as Quarter['quarter'] };
    const settings = routingSettings(plan, input);
    await this.prisma.tbpQuarterPlan.update({ where: { id: planId }, data: settings });

    await this.prisma.tbpQuarterPlanStop.updateMany({
      where: { planId, organizationId, status: TbpStopStatus.BLOCKED, blockedCode: { in: ROUTING_BLOCK_CODES } },
      data: { status: TbpStopStatus.PLANNED, blockedCode: null, blockedMessage: null },
    });
    for (const [inspectionType, minutes] of [
      [InspectionType.OCCUPIED, settings.occupiedVisitMinutes],
      [InspectionType.HVAC, settings.hvacVisitMinutes],
    ] as const)
      await this.prisma.tbpQuarterPlanStop.updateMany({
        where: { planId, organizationId, inspectionType },
        data: { onSiteMinutes: minutes },
      });

    const { stops, overrides } = await this.plannableStops(organizationId, planId, settings);
    const limits: DayLimits = { maxOnSiteMinutes: settings.maxOnSiteMinutes, maxDriveMinutes: settings.maxDriveMinutes };
    const roster = await this.roster(organizationId);
    const zones = zoneCircle(stops, roster, limits.maxDriveMinutes);
    const days = await this.availability(
      organizationId,
      quarter,
      plannedVisitDaysOfQuarter(quarter, settings.holidays),
      stops,
      roster,
      zones.circle,
    );
    const homes = roster.homes;

    // A zone nobody on the crew lives within the day's drive of is a person's to
    // arrange: its visits are blocked with that reason rather than attempted.
    const outOfReach = new Set(zones.outOfReach);
    const unreachable = stops.filter((stop) => stop.zone && outOfReach.has(stop.zone));
    const rotation = { position: new Map(stops.map((stop, index) => [stop.stopId, index])), size: stops.length };

    const assignment = assignQuarter(
      stops.filter((stop) => !stop.zone || !outOfReach.has(stop.zone)),
      days,
      { limits, homes, rotation },
    );
    const unplaced: RoutingSummary['unplaced'] = [
      ...unreachable.map((stop) => ({ stopId: stop.stopId, reason: 'ZONE_OUT_OF_REACH' as const })),
      ...assignment.unplaced,
    ];
    const limitSeconds = settings.maxDriveMinutes * 60;
    let measured = new Map<string, MeasuredCrew>();
    for (const crew of assignment.crews)
      measured.set(crewKey(crew.date, crew.technicianId), await this.measure(crew, homes.get(crew.technicianId)));

    const avoid = new Map<string, Set<string>>();
    let repaired = 0;
    for (let round = 0; round < MAX_REPAIR_ROUNDS; round += 1) {
      const displaced: PlannableStop[] = [];
      for (const [key, crew] of measured) {
        const trimmed = trimToLimit(crew, limitSeconds, homes.get(crew.technicianId));
        if (trimmed.dropped.length === 0) continue;
        if (trimmed.crew.stops.length) measured.set(key, trimmed.crew);
        else measured.delete(key);
        for (const stop of trimmed.dropped) {
          displaced.push(stop);
          const avoided = avoid.get(stop.stopId) ?? new Set<string>();
          avoided.add(key);
          avoid.set(stop.stopId, avoided);
        }
      }
      if (displaced.length === 0) break;
      repaired += displaced.length;

      const again = assignQuarter(displaced, days, {
        limits,
        homes,
        rotation,
        avoid,
        existing: [...measured.values()].map((crew) => ({
          date: crew.date,
          technicianId: crew.technicianId,
          stops: crew.stops,
          driveMinutes:
            crew.totalDriveSeconds === null || !Number.isFinite(crew.totalDriveSeconds)
              ? estimatedPathMinutes(crew.stops, homes.get(crew.technicianId))
              : crew.totalDriveSeconds / 60,
        })),
      });
      unplaced.push(...again.unplaced);
      const next = new Map<string, MeasuredCrew>();
      for (const crew of again.crews) {
        const key = crewKey(crew.date, crew.technicianId);
        const previous = measured.get(key);
        next.set(key, crew.changed || !previous ? await this.measure(crew, homes.get(crew.technicianId)) : previous);
      }
      measured = next;
    }

    // Whatever still measures over after the repairs gives its extra stops to a
    // person: the office's limit is a rule, not a target.
    for (const [key, crew] of measured) {
      const trimmed = trimToLimit(crew, limitSeconds, homes.get(crew.technicianId));
      if (trimmed.dropped.length === 0) continue;
      if (trimmed.crew.stops.length) measured.set(key, trimmed.crew);
      else measured.delete(key);
      for (const stop of trimmed.dropped) unplaced.push({ stopId: stop.stopId, reason: 'DRIVE_LIMIT' });
    }

    const crews = [...measured.values()].sort(
      (left, right) => left.date.localeCompare(right.date) || left.technicianId.localeCompare(right.technicianId),
    );
    await this.persist(organizationId, planId, crews, overrides, unplaced);

    const summary: RoutingSummary = {
      planId,
      quarter,
      placed: crews.reduce((total, crew) => total + crew.stops.length, 0),
      unplaced,
      capacity: assignment.capacity,
      days: crews.length,
      durationSource: crews.find((crew) => crew.durationSource !== null)?.durationSource ?? null,
      settings,
      repaired,
    };

    if (assignment.capacity.onSiteMinutes > assignment.capacity.availableMinutes)
      // Loudly, and before publish. Silently truncating a quarter would leave
      // tenancies uninspected with nothing anywhere saying which.
      this.logger.warn({
        event: 'tbp_plan_capacity_shortfall',
        quarter: quarterLabel(quarter),
        planId,
        onSiteMinutes: assignment.capacity.onSiteMinutes,
        availableMinutes: assignment.capacity.availableMinutes,
      });

    this.logger.log({
      event: 'tbp_plan_routed',
      organizationId,
      quarter: quarterLabel(quarter),
      planId,
      placed: summary.placed,
      unplaced: summary.unplaced.length,
      days: summary.days,
      repaired,
      crew: roster.technicianIds.length,
      zones: zones.circle,
      zonesOutOfReach: zones.outOfReach,
      durationSource: summary.durationSource,
    });

    return summary;
  }

  /**
   * Who has which zone in each week of a plan's quarter, for the console.
   *
   * Worked out as routing works it out -- the same crew, zones and reach -- so
   * the page shows the rotation the days were laid out with, as long as the
   * crew has not changed since. Reads only: it never blocks a stop.
   */
  async rotation(organizationId: string, planId: string): Promise<PlanRotation> {
    const plan = await this.prisma.tbpQuarterPlan.findFirst({
      where: { id: planId, organizationId },
      select: { quarterYear: true, quarterNumber: true, maxDriveMinutes: true, holidays: true },
    });
    if (!plan) throw new ApplicationError(404, 'PLAN_NOT_FOUND', 'This plan does not exist.');
    const quarter: Quarter = { year: plan.quarterYear, quarter: plan.quarterNumber as Quarter['quarter'] };

    const rows = await this.prisma.tbpQuarterPlanStop.findMany({
      where: { planId, organizationId, status: { not: TbpStopStatus.EXCLUDED } },
      select: {
        id: true,
        sequence: true,
        zone: true,
        inspectionType: true,
        propertywareBuilding: { select: { latitude: true, longitude: true } },
      },
    });
    const stops = withZones(
      rows.flatMap((row) =>
        row.propertywareBuilding?.latitude == null || row.propertywareBuilding.longitude == null
          ? []
          : [
              {
                stopId: row.id,
                sequence: row.sequence,
                latitude: Number(row.propertywareBuilding.latitude),
                longitude: Number(row.propertywareBuilding.longitude),
                onSiteMinutes: 0,
                inspectionType: row.inspectionType,
                zone: zoneNumberOf(row.zone),
              },
            ],
      ),
    );
    const roster = await this.roster(organizationId);
    const zones = zoneCircle(stops, roster, plan.maxDriveMinutes);
    const people = roster.technicianIds.length
      ? await this.prisma.userProfile.findMany({
          where: { id: { in: roster.technicianIds } },
          select: { id: true, displayName: true },
        })
      : [];
    const names = new Map(people.map((person) => [person.id, person.displayName]));

    const weeks = new Map<string, Record<string, string>>();
    for (const date of plannedVisitDaysOfQuarter(quarter, plan.holidays)) {
      const weekOf = weekStartOf(date);
      if (!weeks.has(weekOf))
        weeks.set(weekOf, weeklyZoneTechnicians(roster.technicianIds, zones.circle, quarterWeekIndex(date, quarter)));
    }

    return {
      crew: roster.technicianIds.map((technicianId) => ({
        technicianId,
        displayName: names.get(technicianId) ?? null,
        hasHome: roster.homes.has(technicianId),
      })),
      zones: zones.circle,
      outOfReach: zones.outOfReach,
      weeks: [...weeks.entries()].map(([weekOf, owners]) => ({
        weekOf,
        zones: Object.entries(owners)
          .map(([zone, technicianId]) => ({ zone, technicianId }))
          .sort((left, right) => byZoneNumber(left.zone, right.zone)),
      })),
    };
  }

  /**
   * The stops that can be placed at all, with each visit's length and zone.
   *
   * A stop whose building never geocoded has no coordinates, so no day can be
   * chosen for it on any sensible basis. It is marked rather than dropped —
   * `NO_COORDINATES` on the stop is what turns "this tenancy vanished" into
   * "this address needs geocoding", which is a thing somebody can act on.
   */
  private async plannableStops(
    organizationId: string,
    planId: string,
    settings: Required<PlanRoutingSettings>,
  ) {
    const rows = await this.prisma.tbpQuarterPlanStop.findMany({
      where: { planId, organizationId, status: TbpStopStatus.PLANNED },
      select: {
        id: true,
        sequence: true,
        zone: true,
        inspectionType: true,
        previousTechnicianId: true,
        scheduleOverriddenAt: true,
        technicianOverriddenAt: true,
        propertywareBuilding: { select: { latitude: true, longitude: true } },
      },
      orderBy: { sequence: 'asc' },
    });

    const stops: PlannableStop[] = [];
    const overrides = new Map<string, { scheduleOverriddenAt: Date | null; technicianOverriddenAt: Date | null }>();
    const unplaceable: string[] = [];
    for (const row of rows) {
      const latitude = row.propertywareBuilding?.latitude;
      const longitude = row.propertywareBuilding?.longitude;
      if (latitude === null || latitude === undefined || longitude === null || longitude === undefined) {
        unplaceable.push(row.id);
        continue;
      }
      overrides.set(row.id, {
        scheduleOverriddenAt: row.scheduleOverriddenAt ?? null,
        technicianOverriddenAt: row.technicianOverriddenAt ?? null,
      });
      stops.push({
        stopId: row.id,
        sequence: row.sequence,
        latitude: Number(latitude),
        longitude: Number(longitude),
        inspectionType: row.inspectionType ?? InspectionType.OCCUPIED,
        onSiteMinutes:
          row.inspectionType === InspectionType.HVAC ? settings.hvacVisitMinutes : settings.occupiedVisitMinutes,
        previousTechnicianId: row.previousTechnicianId ?? null,
        zone: zoneNumberOf(row.zone),
      });
    }

    if (unplaceable.length > 0)
      await this.prisma.tbpQuarterPlanStop.updateMany({
        where: { id: { in: unplaceable } },
        data: {
          status: TbpStopStatus.BLOCKED,
          blockedCode: 'NO_COORDINATES',
          blockedMessage: 'This property has not been geocoded, so it cannot be routed.',
        },
      });

    return { stops: withZones(stops), overrides };
  }

  /**
   * The benefit-package crew, in the order the zones go round, and where each lives.
   *
   * Set on the technicians' planning profiles by their place in the rotation
   * (`tbpZoneOrder`): the office's crew -- Moses, Kevin and Emanuel, 2026-09-16
   * -- takes both kinds of visit, and nobody else is sent, however plannable. A
   * profile marked unplannable is left out even with a place: somebody on leave
   * keeps it for when they are back.
   *
   * The home is where each day's route starts, and the drive from it counts
   * against the day's drive limit.
   */
  private async roster(organizationId: string): Promise<Roster> {
    const profiles = await this.prisma.technicianPlanningProfile.findMany({
      where: { organizationId, isPlannable: true, tbpZoneOrder: { not: null } },
      orderBy: [{ tbpZoneOrder: 'asc' }, { technicianId: 'asc' }],
      select: { technicianId: true, homeLatitude: true, homeLongitude: true },
    });
    const homes = new Map<string, GeoPoint>();
    for (const row of profiles)
      if (row.homeLatitude != null && row.homeLongitude != null)
        homes.set(row.technicianId, { latitude: Number(row.homeLatitude), longitude: Number(row.homeLongitude) });
    return { technicianIds: profiles.map((row) => row.technicianId), homes };
  }

  /**
   * Who can work each planned day, per zone and kind of visit.
   *
   * Each day's zones come from the week it falls in: the crew each has one zone,
   * and all move one zone on each week. Qualification still applies on top, per
   * date and per kind of visit, because a certificate lapsing mid-quarter must
   * take away the later days and leave the earlier ones alone.
   */
  private async availability(
    organizationId: string,
    quarter: Quarter,
    dates: readonly string[],
    stops: readonly PlannableStop[],
    roster: Roster,
    circle: readonly string[],
  ): Promise<PlannableDay[]> {
    const types = [...new Set(stops.map((stop) => stop.inspectionType as InspectionType))];
    const asDates = dates.map((date) => new Date(`${date}T00:00:00.000Z`));
    const calendars = new Map<InspectionType, Awaited<ReturnType<TechnicianSkillsService['qualificationCalendar']>>>();
    for (const type of types) calendars.set(type, await this.skills.qualificationCalendar(organizationId, type, asDates));

    return dates.map((date) => {
      const zoneTechnicians = circle.length
        ? weeklyZoneTechnicians(roster.technicianIds, circle, quarterWeekIndex(date, quarter))
        : undefined;
      const working = zoneTechnicians ? [...new Set(Object.values(zoneTechnicians))] : [...roster.technicianIds];
      const qualified: Record<string, string[]> = {};
      for (const [type, calendar] of calendars) {
        const onCalendar = new Set((calendar.get(date) ?? []).map((candidate) => candidate.technicianId));
        qualified[type] = working.filter((technicianId) => onCalendar.has(technicianId));
      }
      return { date, technicianIds: working, qualified, ...(zoneTechnicians ? { zoneTechnicians } : {}) };
    });
  }

  /**
   * Order one technician-day and measure its drives.
   *
   * Google first, OSRM second, straight-line last. The fallbacks are ordered by
   * how much they can honestly claim: traffic-aware seconds, free-flow seconds,
   * and then a distance with no time attached at all — because a made-up
   * duration is worse than an absent one, and a plan that says "five hours"
   * when it means "we did not measure" is how somebody ends up late.
   *
   * One matrix of the technician's home and the day's stops. The day is routed
   * from home, and the drive from home counts against the day's limit with the
   * drives between the properties (the office, 2026-09-16). Without a home on
   * file the matrix is the stops alone and the day starts at its first job.
   */
  private async measure(
    crew: Pick<AssignedCrew, 'date' | 'technicianId' | 'stops'>,
    home: GeoPoint | undefined,
  ): Promise<MeasuredCrew> {
    const stops = [...crew.stops];
    const base = { date: crew.date, technicianId: crew.technicianId, fromHome: Boolean(home) };
    if (stops.length === 0 || (stops.length === 1 && !home))
      // Nothing to drive between, which is a true zero rather than an unknown.
      return {
        ...base,
        stops,
        legSeconds: stops.map(() => null),
        totalDriveSeconds: 0,
        totalDriveMeters: 0,
        homeDriveSeconds: null,
        homeDriveMeters: null,
        durationSource: null,
        matrix: null,
      };

    // The home first, so row and column zero are the drives from and to it.
    const points: GeoPoint[] = home ? [home, ...stops] : stops;
    const offset = home ? 1 : 0;
    const google = await this.google.matrix(points, businessInstant(crew.date, DAY_STARTS_AT));
    const durations = google?.durations ?? (await this.osrm.durations(points));
    if (durations) {
      const matrix = {
        durations,
        distances: google?.distances ?? null,
        index: new Map(stops.map((stop, position) => [stop.stopId, position + offset])),
        homeIndex: home ? 0 : null,
      };
      return {
        ...base,
        ...inMatrixOrder(stops, matrix, home),
        durationSource: google ? DriveTimeSource.GOOGLE_TRAFFIC_AWARE : DriveTimeSource.OSRM_FREE_FLOW,
        matrix,
      };
    }

    // Straight-line: a real distance, and deliberately no seconds. We know how
    // far apart the stops are; we do not know how long the drive takes.
    const metres = points.map((from) => points.map((to) => haversineMeters(from, to)));
    const between = stops.map((_, from) => stops.map((__, to) => metres[from + offset]![to + offset]!));
    const order = dayOrder(between, home ? stops.map((_, to) => metres[0]![to + offset]!) : null, stops, home);
    const homeLeg = home && order.length ? metres[0]![order[0]! + offset]! : null;
    return {
      ...base,
      stops: order.map((index) => stops[index]!),
      legSeconds: order.map(() => null),
      totalDriveSeconds: null,
      totalDriveMeters: (homeLeg ?? 0) + pathCost(between, order),
      homeDriveSeconds: null,
      homeDriveMeters: homeLeg,
      durationSource: DriveTimeSource.HAVERSINE,
      matrix: null,
    };
  }

  private async persist(
    organizationId: string,
    planId: string,
    crews: readonly MeasuredCrew[],
    overrides: ReadonlyMap<string, { scheduleOverriddenAt: Date | null; technicianOverriddenAt: Date | null }>,
    unplaced: RoutingSummary['unplaced'],
  ) {
    // Cleared first, so a re-route never leaves a day from the previous run
    // sitting beside the new ones and doubling the forecast -- and so a stop
    // this run could not place does not keep the day the last run gave it,
    // which publish would otherwise book.
    await this.prisma.tbpQuarterPlanDay.deleteMany({ where: { planId } });
    await this.prisma.tbpQuarterPlanStop.updateMany({
      where: { planId, organizationId, status: TbpStopStatus.PLANNED },
      data: { positionInDay: null, driveSecondsForecast: null },
    });
    await this.prisma.tbpQuarterPlanStop.updateMany({
      where: { planId, organizationId, status: TbpStopStatus.PLANNED, scheduleOverriddenAt: null },
      data: { scheduledOn: null },
    });
    await this.prisma.tbpQuarterPlanStop.updateMany({
      where: { planId, organizationId, status: TbpStopStatus.PLANNED, technicianOverriddenAt: null },
      data: { assignedTechnicianId: null },
    });

    // A drive nothing could measure between two points is Infinity in the
    // matrix; the database takes a whole number or nothing.
    const whole = (value: number | null) => (value === null || !Number.isFinite(value) ? null : Math.round(value));

    for (const batch of chunk(crews, 10)) {
      await this.prisma.$transaction(async (tx) => {
        for (const crew of batch) {
          const first = crew.stops[0]!;
          await tx.tbpQuarterPlanDay.create({
            data: {
              organizationId,
              planId,
              technicianId: crew.technicianId,
              date: new Date(`${crew.date}T00:00:00.000Z`),
              stopCount: crew.stops.length,
              onSiteMinutes: crew.stops.reduce((total, stop) => total + stop.onSiteMinutes, 0),
              hvacStopCount: crew.stops.filter((stop) => stop.inspectionType === InspectionType.HVAC).length,
              totalDriveSeconds: whole(crew.totalDriveSeconds),
              totalDriveMeters: whole(crew.totalDriveMeters),
              homeDriveSeconds: whole(crew.homeDriveSeconds),
              homeDriveMeters: whole(crew.homeDriveMeters),
              // A day routed from home says so, and does not copy the home's
              // coordinates onto every day of the quarter: the planning profile
              // stays the one place a technician's address is kept.
              originLatitude: crew.fromHome ? null : first.latitude,
              originLongitude: crew.fromHome ? null : first.longitude,
              originKind: crew.fromHome ? PlanOriginKind.HOME : PlanOriginKind.FIRST_STOP,
              durationSource: crew.durationSource,
              departureAssumedAt: businessInstant(crew.date, DAY_STARTS_AT),
            },
          });

          for (const [index, stop] of crew.stops.entries()) {
            const pinned = overrides.get(stop.stopId);
            const leg = crew.legSeconds[index];
            await tx.tbpQuarterPlanStop.update({
              where: { id: stop.stopId },
              // A coordinator's own choice of day or technician is never
              // overwritten by a re-route; the two `*OverriddenAt` guards are
              // what make re-routing safe to run more than once.
              data: {
                ...(pinned?.scheduleOverriddenAt ? {} : { scheduledOn: new Date(`${crew.date}T00:00:00.000Z`) }),
                ...(pinned?.technicianOverriddenAt ? {} : { assignedTechnicianId: crew.technicianId }),
                positionInDay: index + 1,
                driveSecondsForecast: whole(leg ?? null),
              },
            });
          }
        }
      });
    }

    // A stop no day can take is blocked with the reason, so publish refuses
    // until somebody excludes it or changes the settings and routes again.
    const byReason = new Map<RoutingUnplacedReason, string[]>();
    for (const entry of unplaced) byReason.set(entry.reason, [...(byReason.get(entry.reason) ?? []), entry.stopId]);
    for (const [reason, ids] of byReason)
      await this.prisma.tbpQuarterPlanStop.updateMany({
        where: { id: { in: ids }, planId },
        data: { status: TbpStopStatus.BLOCKED, blockedCode: 'NOT_PLACED', blockedMessage: UNPLACED_MESSAGE[reason] },
      });

    const blockedCount = await this.prisma.tbpQuarterPlanStop.count({
      where: { planId, organizationId, status: TbpStopStatus.BLOCKED },
    });
    await this.prisma.tbpQuarterPlan.update({ where: { id: planId }, data: { blockedCount } });
  }
}

/**
 * The plan's settings with a request's changes applied, checked.
 *
 * Refused rather than clamped: a visit length of 3 or a drive limit of 900 is a
 * typo, and routing a quarter on it would look like a plan.
 */
export function routingSettings(
  current: Required<Omit<PlanRoutingSettings, 'holidays'>> & { holidays: string[] },
  input: PlanRoutingSettings,
): Required<PlanRoutingSettings> {
  const within = (name: keyof Omit<PlanRoutingSettings, 'holidays'>, min: number, max: number) => {
    const value = input[name] ?? current[name];
    if (!Number.isInteger(value) || value < min || value > max)
      throw new ApplicationError(422, 'INVALID_PLAN_SETTINGS', `${name} must be a whole number from ${min} to ${max}.`);
    return value;
  };
  const holidays = input.holidays ?? current.holidays;
  if (!Array.isArray(holidays) || holidays.length > 100 || holidays.some((day) => !/^\d{4}-\d{2}-\d{2}$/.test(day)))
    throw new ApplicationError(422, 'INVALID_PLAN_SETTINGS', 'Closed days must be dates written as YYYY-MM-DD.');
  return {
    occupiedVisitMinutes: within('occupiedVisitMinutes', 5, 240),
    hvacVisitMinutes: within('hvacVisitMinutes', 5, 240),
    maxOnSiteMinutes: within('maxOnSiteMinutes', 30, 720),
    maxDriveMinutes: within('maxDriveMinutes', 0, 480),
    holidays: [...new Set(holidays)].sort(),
  };
}

/** The middle of each zone's stops, as a place. */
function zoneMiddles(stops: readonly PlannableStop[]): Map<string, GeoPoint> {
  const sums = new Map<string, { latitude: number; longitude: number; count: number }>();
  for (const stop of stops) {
    if (!stop.zone) continue;
    const sum = sums.get(stop.zone) ?? { latitude: 0, longitude: 0, count: 0 };
    sums.set(stop.zone, { latitude: sum.latitude + stop.latitude, longitude: sum.longitude + stop.longitude, count: sum.count + 1 });
  }
  return new Map(
    [...sums.entries()].map(([zone, sum]) => [zone, { latitude: sum.latitude / sum.count, longitude: sum.longitude / sum.count }]),
  );
}

/**
 * Every stop with a zone: its own, or for the few the tenant report leaves
 * without one ("Not Set"), the zone whose middle is nearest -- so it is still
 * worked by whoever has that part of town that week.
 */
export function withZones<T extends PlannableStop>(stops: readonly T[]): T[] {
  const middles = zoneMiddles(stops);
  if (middles.size === 0) return [...stops];
  return stops.map((stop) => {
    if (stop.zone) return stop;
    let nearest: string | null = null;
    let nearestMetres = Number.POSITIVE_INFINITY;
    for (const [zone, middle] of middles) {
      const metres = haversineMeters(stop, middle);
      if (metres < nearestMetres) {
        nearest = zone;
        nearestMetres = metres;
      }
    }
    return { ...stop, zone: nearest };
  });
}

/**
 * The zones the crew goes round, in order, and the zones none of them can reach.
 *
 * A zone is out of reach when every crew member's home is further from its
 * middle than the day's drive allows even to get there -- zone 5, some 200 km
 * from the three homes in Q4 2026. Left in the circle, it would take a person's
 * week and leave another zone without anybody; out of it, its visits are
 * blocked with the reason for the office to arrange. A crew member with no home
 * on file starts at their first job, so reaches anywhere.
 */
export function zoneCircle(
  stops: readonly PlannableStop[],
  roster: Roster,
  maxDriveMinutes: number,
): { circle: string[]; outOfReach: string[] } {
  const zones = [...zoneMiddles(stops).entries()].sort(([left], [right]) => byZoneNumber(left, right));
  // Without a crew there is nobody to be out of reach of: routing says so per stop.
  if (roster.technicianIds.length === 0) return { circle: zones.map(([zone]) => zone), outOfReach: [] };
  const reachable = (middle: GeoPoint) =>
    roster.technicianIds.some((technicianId) => {
      const home = roster.homes.get(technicianId);
      return !home || estimatedDriveMinutes(home, middle) <= maxDriveMinutes;
    });
  return {
    circle: zones.filter(([, middle]) => reachable(middle)).map(([zone]) => zone),
    outOfReach: zones.filter(([, middle]) => !reachable(middle)).map(([zone]) => zone),
  };
}

/** The drive through stops in the order given, in seconds, from a matrix. */
function pathCost(matrix: readonly (readonly number[])[], order: readonly number[]): number {
  let total = 0;
  for (let index = 1; index < order.length; index += 1)
    total += matrix[order[index - 1]!]?.[order[index]!] ?? Number.POSITIVE_INFINITY;
  return total;
}

/** The estimated drive of a day in the order given, from home when it has one, in minutes. */
function estimatedPathMinutes(stops: readonly PlannableStop[], home?: GeoPoint): number {
  let total = home && stops.length ? estimatedDriveMinutes(home, stops[0]!) : 0;
  for (let index = 1; index < stops.length; index += 1) total += estimatedDriveMinutes(stops[index - 1]!, stops[index]!);
  return total;
}

/**
 * The order to drive a day in: the shortest route from the technician's home.
 *
 * The drive from home counts against the day's limit with the drives between
 * the properties (the office, 2026-09-16), so the route that drives least from
 * home is the one to keep. Between two that drive the same, the day starts at
 * the property nearer home: a tie in the numbers is not a tie on the road.
 * Without a home, the shortest path through the stops from any of them.
 *
 * `between` is the stops' own matrix; `fromHome` the drive from home to each.
 */
function dayOrder(
  between: readonly (readonly number[])[],
  fromHome: readonly number[] | null,
  stops: readonly GeoPoint[],
  home: GeoPoint | undefined,
): number[] {
  if (!fromHome || !home || stops.length === 0) return shortestOpenPathOrder(between);
  // The solver's origin is row zero; nothing ever drives back to it.
  const withHome = [[0, ...fromHome], ...between.map((row) => [0, ...row])];
  const solved = shortestRouteOrder(withHome).map((index) => index - 1);
  const total = (order: readonly number[]) => (order.length ? fromHome[order[0]!]! : 0) + pathCost(between, order);
  const reversed = [...solved].reverse();
  return total(reversed) <= total(solved) &&
    haversineMeters(home, stops[reversed[0]!]!) < haversineMeters(home, stops[solved[0]!]!)
    ? reversed
    : solved;
}

/** Stops ordered and measured from a matrix that holds them all, and the home when it has one. */
function inMatrixOrder(
  stops: readonly PlannableStop[],
  matrix: NonNullable<MeasuredCrew['matrix']>,
  home: GeoPoint | undefined,
): Pick<
  MeasuredCrew,
  'stops' | 'legSeconds' | 'totalDriveSeconds' | 'totalDriveMeters' | 'homeDriveSeconds' | 'homeDriveMeters'
> {
  const indexes = stops.map((stop) => matrix.index.get(stop.stopId)!);
  const durations = indexes.map((from) => indexes.map((to) => matrix.durations[from]![to]!));
  const homeRow = matrix.homeIndex === null ? null : matrix.durations[matrix.homeIndex]!;
  const order = dayOrder(durations, homeRow ? indexes.map((to) => homeRow[to]!) : null, stops, home);
  const ordered = order.map((index) => stops[index]!);
  const legSeconds = order.map((index, position) => (position === 0 ? null : durations[order[position - 1]!]![index]!));
  const distances = matrix.distances;
  const first = order.length ? indexes[order[0]!]! : null;
  const homeSeconds = homeRow && first !== null ? homeRow[first]! : null;
  const homeMeters = distances && matrix.homeIndex !== null && first !== null ? distances[matrix.homeIndex]![first]! : null;
  const betweenMeters = distances
    ? pathCost(
        indexes.map((from) => indexes.map((to) => distances[from]![to]!)),
        order,
      )
    : null;
  return {
    stops: ordered,
    legSeconds,
    totalDriveSeconds: (homeSeconds ?? 0) + pathCost(durations, order),
    totalDriveMeters: betweenMeters === null ? null : (homeMeters ?? 0) + betweenMeters,
    homeDriveSeconds: homeSeconds !== null && Number.isFinite(homeSeconds) ? homeSeconds : null,
    homeDriveMeters: homeMeters !== null && Number.isFinite(homeMeters) ? homeMeters : null,
  };
}

/**
 * A measured day cut back to the drive limit, and the stops it gave up.
 *
 * One stop at a time, the one whose leaving saves the most driving -- usually
 * the one out on its own -- until the day fits. Reordered and re-measured from
 * the matrix already fetched, home included, so a trimmed day's numbers are
 * real, not estimated. A tie goes to the stop later in the rotation, so the
 * earlier keeps its day. A day nothing measured is left alone: there is nothing
 * to trim by. A day of one stop too far from home gives that stop up too.
 */
function trimToLimit(
  crew: MeasuredCrew,
  limitSeconds: number,
  home: GeoPoint | undefined,
): { crew: MeasuredCrew; dropped: PlannableStop[] } {
  const matrix = crew.matrix;
  if (!matrix || crew.totalDriveSeconds === null || crew.totalDriveSeconds <= limitSeconds) return { crew, dropped: [] };

  let current = crew;
  const dropped: PlannableStop[] = [];
  while (current.stops.length > 0 && (current.totalDriveSeconds ?? 0) > limitSeconds) {
    let worst = current.stops.length - 1;
    let worstSaved = Number.NEGATIVE_INFINITY;
    for (const [position, stop] of current.stops.entries()) {
      const rest = current.stops.filter((_, index) => index !== position);
      const cost = rest.length ? (inMatrixOrder(rest, matrix, home).totalDriveSeconds ?? Number.POSITIVE_INFINITY) : 0;
      const saved = Number.isFinite(cost) ? (current.totalDriveSeconds ?? 0) - cost : Number.NEGATIVE_INFINITY;
      const later = stop.sequence > current.stops[worst]!.sequence;
      if (saved > worstSaved || (saved === worstSaved && later)) {
        worst = position;
        worstSaved = saved;
      }
    }
    dropped.push(current.stops[worst]!);
    const rest = current.stops.filter((_, index) => index !== worst);
    current = rest.length
      ? { ...current, ...inMatrixOrder(rest, matrix, home) }
      : {
          ...current,
          stops: [],
          legSeconds: [],
          totalDriveSeconds: 0,
          totalDriveMeters: 0,
          homeDriveSeconds: null,
          homeDriveMeters: null,
        };
  }
  return { crew: current, dropped };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    batches.push(items.slice(index, index + size));
  return batches;
}
