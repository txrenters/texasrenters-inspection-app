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
  crewKey,
  estimatedDriveMinutes,
  haversineMeters,
  quarterLabel,
  shortestOpenPathOrder,
  workingDaysOfQuarter,
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

/** How much longer a day's drive may be so that it starts at the end nearer the technician's home. */
const HOME_END_TOLERANCE_SECONDS = 120;

/** Block codes routing owns, cleared whenever the plan is routed again. */
const ROUTING_BLOCK_CODES = ['NO_COORDINATES', 'NOT_PLACED'];

/** The office's limits and visit lengths, as a coordinator may set them for a plan. */
export interface PlanRoutingSettings {
  occupiedVisitMinutes?: number;
  hvacVisitMinutes?: number;
  maxOnSiteMinutes?: number;
  maxDriveMinutes?: number;
  /** Days the office is closed, `YYYY-MM-DD`. */
  holidays?: string[];
}

export type RoutingUnplacedReason = UnplacedReason | 'DRIVE_LIMIT';

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

/** What a stop routing could not place says, on the stop. */
const UNPLACED_MESSAGE: Record<RoutingUnplacedReason, string> = {
  NO_WORKING_DAYS: 'The quarter has no working days to place this visit on.',
  NO_QUALIFIED_TECHNICIAN: 'No technician with a planning profile is qualified for this kind of visit.',
  NO_CAPACITY: 'No technician-day this quarter has room for this visit inside the day limits.',
  LONGER_THAN_A_DAY: 'This visit is longer than a whole day on site.',
  DRIVE_LIMIT: 'No day it could join keeps the drive between properties inside the limit.',
};

/** A technician-day, measured on real roads where anything could measure it. */
interface MeasuredCrew {
  date: string;
  technicianId: string;
  /** In driving order. */
  stops: PlannableStop[];
  /** Seconds from the stop before, per stop; null for the first, or when nothing measured it. */
  legSeconds: (number | null)[];
  totalDriveSeconds: number | null;
  totalDriveMeters: number | null;
  durationSource: DriveTimeSource | null;
  /** The matrix it was measured with, so trimming the day needs no second call. */
  matrix: { durations: number[][]; distances: number[][] | null; index: Map<string, number> } | null;
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
   * The office's limits hold for every day it writes: at most `maxOnSiteMinutes`
   * inspecting and `maxDriveMinutes` driving between the day's properties. Days
   * are laid out on an estimate, measured on real roads, and a day that
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
    const dates = workingDaysOfQuarter(quarter, settings.holidays);
    const { days, homes } = await this.availability(
      organizationId,
      dates,
      [...new Set(stops.map((stop) => stop.inspectionType as InspectionType))],
    );

    const limits: DayLimits = { maxOnSiteMinutes: settings.maxOnSiteMinutes, maxDriveMinutes: settings.maxDriveMinutes };
    const technicianRank = rankByLastQuarter(stops);
    const rotation = { position: new Map(stops.map((stop, index) => [stop.stopId, index])), size: stops.length };

    const assignment = assignQuarter(stops, days, { limits, technicianRank });
    const unplaced: RoutingSummary['unplaced'] = [...assignment.unplaced];
    let measured = new Map<string, MeasuredCrew>();
    for (const crew of assignment.crews)
      measured.set(crewKey(crew.date, crew.technicianId), await this.measure(crew, homes.get(crew.technicianId)));

    const limitSeconds = settings.maxDriveMinutes * 60;
    const avoid = new Map<string, Set<string>>();
    let repaired = 0;
    for (let round = 0; round < MAX_REPAIR_ROUNDS; round += 1) {
      const displaced: PlannableStop[] = [];
      for (const [key, crew] of measured) {
        const trimmed = trimToLimit(crew, limitSeconds, homes.get(crew.technicianId));
        if (trimmed.dropped.length === 0) continue;
        measured.set(key, trimmed.crew);
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
        technicianRank,
        rotation,
        avoid,
        existing: [...measured.values()].map((crew) => ({
          date: crew.date,
          technicianId: crew.technicianId,
          stops: crew.stops,
          driveMinutes: crew.totalDriveSeconds === null ? estimatedPathMinutes(crew.stops) : crew.totalDriveSeconds / 60,
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
      measured.set(key, trimmed.crew);
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
      durationSource: summary.durationSource,
    });

    return summary;
  }

  /**
   * The stops that can be placed at all, with each visit's length.
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

    return { stops, overrides };
  }

  /**
   * Who can work each day of the quarter, per kind of visit, and where they live.
   *
   * Two independent gates, and both matter. A planning profile marked plannable
   * is a coordinator saying "this person takes benefit-package days" -- and a
   * technician with no profile at all is not planned: accounts carrying the
   * technician role include office staff who test the app, and a plan books
   * real visits in Jobber under whoever it picks. Qualification is per date
   * and per kind of visit, because a certificate lapsing mid-quarter must take
   * away the later days and leave the earlier ones alone.
   *
   * The home is used only to start a day at the end nearer it. It is never
   * counted against the day: the office's drive limit starts at the first job.
   */
  private async availability(organizationId: string, dates: readonly string[], types: readonly InspectionType[]) {
    const profiles = await this.prisma.technicianPlanningProfile.findMany({
      where: { organizationId },
      select: { technicianId: true, isPlannable: true, homeLatitude: true, homeLongitude: true },
    });
    const plannable = new Set(profiles.filter((row) => row.isPlannable).map((row) => row.technicianId));
    const homes = new Map<string, GeoPoint>();
    for (const row of profiles)
      if (row.homeLatitude !== null && row.homeLatitude !== undefined && row.homeLongitude !== null && row.homeLongitude !== undefined)
        homes.set(row.technicianId, { latitude: Number(row.homeLatitude), longitude: Number(row.homeLongitude) });

    const asDates = dates.map((date) => new Date(`${date}T00:00:00.000Z`));
    const calendars = new Map<InspectionType, Awaited<ReturnType<TechnicianSkillsService['qualificationCalendar']>>>();
    for (const type of types) calendars.set(type, await this.skills.qualificationCalendar(organizationId, type, asDates));

    const days: PlannableDay[] = dates.map((date) => {
      const qualified: Record<string, string[]> = {};
      const available: string[] = [];
      for (const [type, calendar] of calendars) {
        qualified[type] = (calendar.get(date) ?? [])
          .filter((candidate) => plannable.has(candidate.technicianId))
          // Most qualified first, so the strongest are sent when a day does
          // not need everybody.
          .sort((left, right) => right.preferredHeld - left.preferredHeld)
          .map((candidate) => candidate.technicianId);
        for (const technicianId of qualified[type]) if (!available.includes(technicianId)) available.push(technicianId);
      }
      return { date, technicianIds: available, qualified };
    });

    return { days, homes };
  }

  /**
   * Order one technician-day and measure its drive between stops.
   *
   * Google first, OSRM second, straight-line last. The fallbacks are ordered by
   * how much they can honestly claim: traffic-aware seconds, free-flow seconds,
   * and then a distance with no time attached at all — because a made-up
   * duration is worse than an absent one, and a plan that says "five hours"
   * when it means "we did not measure" is how somebody ends up late.
   *
   * One matrix of the day's stops alone. The day starts at its first job, so
   * nothing is measured from home or from the middle of the day's stops.
   */
  private async measure(
    crew: Pick<AssignedCrew, 'date' | 'technicianId' | 'stops'>,
    home: GeoPoint | undefined,
  ): Promise<MeasuredCrew> {
    const stops = [...crew.stops];
    const base = { date: crew.date, technicianId: crew.technicianId };
    if (stops.length <= 1)
      // Nothing to drive between, which is a true zero rather than an unknown.
      return {
        ...base,
        stops,
        legSeconds: stops.map(() => null),
        totalDriveSeconds: 0,
        totalDriveMeters: 0,
        durationSource: null,
        matrix: null,
      };

    const google = await this.google.matrix(stops, businessInstant(crew.date, DAY_STARTS_AT));
    const durations = google?.durations ?? (await this.osrm.durations(stops));
    if (durations) {
      const matrix = {
        durations,
        distances: google?.distances ?? null,
        index: new Map(stops.map((stop, position) => [stop.stopId, position])),
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
    const metres = stops.map((from) => stops.map((to) => haversineMeters(from, to)));
    const order = orientTowardHome(shortestOpenPathOrder(metres), metres, stops, home, 0);
    return {
      ...base,
      stops: order.map((index) => stops[index]!),
      legSeconds: order.map(() => null),
      totalDriveSeconds: null,
      totalDriveMeters: pathCost(metres, order),
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
              totalDriveSeconds: crew.totalDriveSeconds === null ? null : Math.round(crew.totalDriveSeconds),
              totalDriveMeters: crew.totalDriveMeters === null ? null : Math.round(crew.totalDriveMeters),
              originLatitude: first.latitude,
              originLongitude: first.longitude,
              originKind: PlanOriginKind.FIRST_STOP,
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
                driveSecondsForecast: leg === null || leg === undefined ? null : Math.round(leg),
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

/**
 * Technicians ranked by how many of the quarter's tenancies they visited last
 * quarter, so the office's benefit-package technician is sent first. In Q3
 * 2026 one technician took 330 of 344 visits.
 */
function rankByLastQuarter(stops: readonly PlannableStop[]) {
  const visits = new Map<string, number>();
  for (const stop of stops)
    if (stop.previousTechnicianId) visits.set(stop.previousTechnicianId, (visits.get(stop.previousTechnicianId) ?? 0) + 1);
  return (technicianId: string) => -(visits.get(technicianId) ?? 0);
}

/** The drive through stops in the order given, in seconds, from a matrix. */
function pathCost(matrix: readonly (readonly number[])[], order: readonly number[]): number {
  let total = 0;
  for (let index = 1; index < order.length; index += 1)
    total += matrix[order[index - 1]!]?.[order[index]!] ?? Number.POSITIVE_INFINITY;
  return total;
}

/** The estimated drive through stops in the order given, in minutes. */
function estimatedPathMinutes(stops: readonly PlannableStop[]): number {
  let total = 0;
  for (let index = 1; index < stops.length; index += 1) total += estimatedDriveMinutes(stops[index - 1]!, stops[index]!);
  return total;
}

/**
 * The same day driven the other way, when that starts nearer home.
 *
 * The drive from home is not counted, but it is driven. Between two orders
 * within a couple of minutes of each other, the one that starts at the end
 * nearer the technician's home is the one they would choose.
 */
function orientTowardHome(
  order: number[],
  matrix: readonly (readonly number[])[],
  stops: readonly GeoPoint[],
  home: GeoPoint | undefined,
  toleranceSeconds: number,
): number[] {
  if (!home || order.length < 2) return order;
  const reversed = [...order].reverse();
  const nearerHome = haversineMeters(home, stops[reversed[0]!]!) < haversineMeters(home, stops[order[0]!]!);
  return nearerHome && pathCost(matrix, reversed) <= pathCost(matrix, order) + toleranceSeconds ? reversed : order;
}

/** Stops ordered and measured from a matrix that holds them all. */
function inMatrixOrder(
  stops: readonly PlannableStop[],
  matrix: NonNullable<MeasuredCrew['matrix']>,
  home: GeoPoint | undefined,
): Pick<MeasuredCrew, 'stops' | 'legSeconds' | 'totalDriveSeconds' | 'totalDriveMeters'> {
  const indexes = stops.map((stop) => matrix.index.get(stop.stopId)!);
  const durations = indexes.map((from) => indexes.map((to) => matrix.durations[from]![to]!));
  const order = orientTowardHome(shortestOpenPathOrder(durations), durations, stops, home, HOME_END_TOLERANCE_SECONDS);
  const ordered = order.map((index) => stops[index]!);
  const legSeconds = order.map((index, position) => (position === 0 ? null : durations[order[position - 1]!]![index]!));
  const distances = matrix.distances;
  return {
    stops: ordered,
    legSeconds,
    totalDriveSeconds: pathCost(durations, order),
    totalDriveMeters: distances
      ? pathCost(
          indexes.map((from) => indexes.map((to) => distances[from]![to]!)),
          order,
        )
      : null,
  };
}

/**
 * A measured day cut back to the drive limit, and the stops it gave up.
 *
 * One stop at a time, the one whose leaving saves the most driving -- usually
 * the one out on its own -- until the day fits. Reordered and re-measured from
 * the matrix already fetched, so a trimmed day's numbers are real, not
 * estimated. A tie goes to the stop later in the rotation, so the earlier keeps
 * its day. A day nothing measured is left alone: there is nothing to trim by.
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
  while (current.stops.length > 1 && (current.totalDriveSeconds ?? 0) > limitSeconds) {
    const order = current.stops.map((stop) => matrix.index.get(stop.stopId)!);
    let worst = current.stops.length - 1;
    let worstSaved = Number.NEGATIVE_INFINITY;
    for (const [position, stop] of current.stops.entries()) {
      const rest = order.filter((_, index) => index !== position);
      const cost = pathCost(matrix.durations, rest);
      const saved = Number.isFinite(cost) ? (current.totalDriveSeconds ?? 0) - cost : Number.NEGATIVE_INFINITY;
      const later = stop.sequence > current.stops[worst]!.sequence;
      if (saved > worstSaved || (saved === worstSaved && later)) {
        worst = position;
        worstSaved = saved;
      }
    }
    dropped.push(current.stops[worst]!);
    const rest = current.stops.filter((_, index) => index !== worst);
    current = { ...current, ...inMatrixOrder(rest, matrix, home) };
  }
  return { crew: current, dropped };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    batches.push(items.slice(index, index + size));
  return batches;
}
