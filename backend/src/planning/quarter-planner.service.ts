import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DriveTimeSource,
  InspectionStatus,
  InspectionType,
  PlanOriginKind,
  TbpPlanStatus,
  TbpStopStatus,
} from '@prisma/client';
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
  mainTechnicians,
  quarterEnd,
  quarterLabel,
  shortestOpenPathOrder,
  shortestRouteOrder,
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

/**
 * How much longer a day's drive may be so that it starts at the end nearer the
 * technician's home, when the day cannot be routed from the home itself.
 */
const HOME_END_TOLERANCE_SECONDS = 120;

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
  NO_QUALIFIED_TECHNICIAN:
    'No technician set up for planning is given this kind of inspection in Jobber, so there is nobody to send.',
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
  /** Between the day's properties only: what the drive limit counts. */
  totalDriveSeconds: number | null;
  totalDriveMeters: number | null;
  /** Whether the day was routed from the technician's home. */
  fromHome: boolean;
  /** Home to the first property, when measured. Never part of `totalDriveSeconds`. */
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
    const { days, homes, technicianRank } = await this.availability(
      organizationId,
      quarter,
      dates,
      [...new Set(stops.map((stop) => stop.inspectionType as InspectionType))],
    );

    const limits: DayLimits = { maxOnSiteMinutes: settings.maxOnSiteMinutes, maxDriveMinutes: settings.maxDriveMinutes };
    const rotation = { position: new Map(stops.map((stop, index) => [stop.stopId, index])), size: stops.length };

    const assignment = assignQuarter(stops, days, { limits, technicianRank });
    const unplaced: RoutingSummary['unplaced'] = [...assignment.unplaced];
    const limitSeconds = settings.maxDriveMinutes * 60;
    let measured = new Map<string, MeasuredCrew>();
    for (const crew of assignment.crews)
      measured.set(
        crewKey(crew.date, crew.technicianId),
        await this.measure(crew, homes.get(crew.technicianId), limitSeconds),
      );

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
        next.set(
          key,
          crew.changed || !previous ? await this.measure(crew, homes.get(crew.technicianId), limitSeconds) : previous,
        );
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
   * Three gates, and each matters. A planning profile marked plannable
   * is a coordinator saying "this person takes benefit-package days" -- and a
   * technician with no profile at all is not planned: accounts carrying the
   * technician role include office staff who test the app, and a plan books
   * real visits in Jobber under whoever it picks. Qualification is per date
   * and per kind of visit, because a certificate lapsing mid-quarter must take
   * away the later days and leave the earlier ones alone.
   *
   * And a kind of visit goes only to the technicians the office gives it to in
   * Jobber (`jobberAssignments`, `mainTechnicians`): the office's rule is that a
   * quarter is assigned the way Jobber already is, occupied inspections to one
   * technician and HVAC inspections to another. Whoever took a tenancy last
   * quarter is preferred only among those, so an occupied tenancy's HVAC
   * quarter goes to the HVAC technician rather than back to the occupied one.
   * A kind nobody has been given in Jobber is blocked with the reason, never
   * handed to whoever happens to be free.
   *
   * The home is where a day's route starts (the office, 2026-09-16), and the
   * drive from it is shown. It is never counted against the day: the office's
   * drive limit is the drive between the day's properties.
   */
  private async availability(
    organizationId: string,
    quarter: Quarter,
    dates: readonly string[],
    types: readonly InspectionType[],
  ) {
    const assigned = await this.jobberAssignments(organizationId, quarter);
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
        const candidates = (calendar.get(date) ?? [])
          .filter((candidate) => plannable.has(candidate.technicianId))
          // Most qualified first, so that between two technicians the office
          // gives a kind alike, the stronger is sent when a day needs one.
          .sort((left, right) => right.preferredHeld - left.preferredHeld);
        qualified[type] = mainTechnicians(
          new Map(
            candidates.map((candidate) => [candidate.technicianId, assigned.get(type)?.get(candidate.technicianId) ?? 0]),
          ),
        );
        for (const technicianId of qualified[type]) if (!available.includes(technicianId)) available.push(technicianId);
      }
      return { date, technicianIds: available, qualified };
    });

    // Between technicians who take the same kind, the one given it most is sent first.
    const technicianRank = (technicianId: string, inspectionType: string) =>
      -(assigned.get(inspectionType as InspectionType)?.get(technicianId) ?? 0);

    return { days, homes, technicianRank };
  }

  /**
   * How many inspections of each kind the office has assigned each technician
   * in Jobber, over the year to the end of the quarter being planned.
   *
   * Read from the inspections booked in Jobber, by who each is assigned to now:
   * the sync keeps that in step with Jobber, so a visit the office moved to
   * another technician counts for the one it moved to. A year, so an HVAC
   * quarter is always inside it; to the quarter's end, so visits the office has
   * already booked into the quarter count too. A cancelled visit was not
   * worked, and is not counted.
   */
  private async jobberAssignments(organizationId: string, quarter: Quarter) {
    const rows = await this.prisma.inspectionAssignment.findMany({
      where: {
        isCurrent: true,
        inspection: {
          organizationId,
          inspectionType: { in: [InspectionType.OCCUPIED, InspectionType.HVAC] },
          jobberVisitId: { not: null },
          status: { not: InspectionStatus.CANCELLED },
          // The quarter after this one a year ago: Q4 2026 reads from 1 January 2026.
          scheduledAt: { gte: new Date(Date.UTC(quarter.year - 1, quarter.quarter * 3, 1)), lt: quarterEnd(quarter) },
        },
      },
      select: { technicianId: true, inspection: { select: { inspectionType: true } } },
    });

    const assigned = new Map<InspectionType, Map<string, number>>();
    for (const row of rows) {
      const counts = assigned.get(row.inspection.inspectionType) ?? new Map<string, number>();
      counts.set(row.technicianId, (counts.get(row.technicianId) ?? 0) + 1);
      assigned.set(row.inspection.inspectionType, counts);
    }
    return assigned;
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
   * from home (the office, 2026-09-16), so the home leg is measured and kept;
   * the drive counted against the limit is still between the stops only.
   * Without a home on file the matrix is the stops alone and the day starts at
   * its first job, as before.
   */
  private async measure(
    crew: Pick<AssignedCrew, 'date' | 'technicianId' | 'stops'>,
    home: GeoPoint | undefined,
    limitSeconds: number,
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
        ...inMatrixOrder(stops, matrix, home, limitSeconds),
        durationSource: google ? DriveTimeSource.GOOGLE_TRAFFIC_AWARE : DriveTimeSource.OSRM_FREE_FLOW,
        matrix,
      };
    }

    // Straight-line: a real distance, and deliberately no seconds. We know how
    // far apart the stops are; we do not know how long the drive takes. With no
    // seconds there is no limit to keep, so a home-started order always stands.
    const metres = points.map((from) => points.map((to) => haversineMeters(from, to)));
    const between = stops.map((_, from) => stops.map((__, to) => metres[from + offset]![to + offset]!));
    const order = dayOrder(between, home ? stops.map((_, to) => metres[0]![to + offset]!) : null, stops, home, Infinity, 0);
    return {
      ...base,
      stops: order.map((index) => stops[index]!),
      legSeconds: order.map(() => null),
      totalDriveSeconds: null,
      totalDriveMeters: pathCost(between, order),
      homeDriveSeconds: null,
      homeDriveMeters: home && order.length ? metres[0]![order[0]! + offset]! : null,
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
              homeDriveSeconds: crew.homeDriveSeconds === null ? null : Math.round(crew.homeDriveSeconds),
              homeDriveMeters: crew.homeDriveMeters === null ? null : Math.round(crew.homeDriveMeters),
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
 * Used only when the day cannot be routed from the home itself (`dayOrder`).
 * Between two orders within a couple of minutes of each other, the one that
 * starts at the end nearer the technician's home is the one they would choose.
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

/**
 * The order to drive a day in: from the technician's home, when that keeps the
 * day inside the drive limit.
 *
 * The office's rule (2026-09-16): a day starts from home, and the ninety
 * minutes are the drives between its properties. So the route is the shortest
 * from home through every property -- which starts at or near the property
 * nearest home -- unless its drive between the properties would run over the
 * limit where the shortest path through them alone would not. Then the day
 * keeps that path, started at the end nearer home: starting from home must
 * never cost a day a property it could otherwise keep.
 *
 * `between` is the stops' own matrix; `fromHome` the drive from home to each.
 */
function dayOrder(
  between: readonly (readonly number[])[],
  fromHome: readonly number[] | null,
  stops: readonly GeoPoint[],
  home: GeoPoint | undefined,
  limit: number,
  toleranceSeconds = HOME_END_TOLERANCE_SECONDS,
): number[] {
  const free = orientTowardHome(shortestOpenPathOrder(between), between, stops, home, toleranceSeconds);
  if (!fromHome || stops.length === 0) return free;
  // The solver's origin is row zero; nothing ever drives back to it.
  const withHome = [[0, ...fromHome], ...between.map((row) => [0, ...row])];
  const solved = shortestRouteOrder(withHome).map((index) => index - 1);
  // Between two routes from home that drive the same, start at the property
  // nearer home: a tie in the numbers is not a tie on the road.
  const total = (order: readonly number[]) => (order.length ? fromHome[order[0]!]! : 0) + pathCost(between, order);
  const reversed = [...solved].reverse();
  const homeFirst =
    home && total(reversed) <= total(solved) && haversineMeters(home, stops[reversed[0]!]!) < haversineMeters(home, stops[solved[0]!]!)
      ? reversed
      : solved;
  const cost = pathCost(between, homeFirst);
  return cost <= limit || cost <= pathCost(between, free) ? homeFirst : free;
}

/** Stops ordered and measured from a matrix that holds them all, and the home when it has one. */
function inMatrixOrder(
  stops: readonly PlannableStop[],
  matrix: NonNullable<MeasuredCrew['matrix']>,
  home: GeoPoint | undefined,
  limitSeconds: number,
): Pick<
  MeasuredCrew,
  'stops' | 'legSeconds' | 'totalDriveSeconds' | 'totalDriveMeters' | 'homeDriveSeconds' | 'homeDriveMeters'
> {
  const indexes = stops.map((stop) => matrix.index.get(stop.stopId)!);
  const durations = indexes.map((from) => indexes.map((to) => matrix.durations[from]![to]!));
  const homeRow = matrix.homeIndex === null ? null : matrix.durations[matrix.homeIndex]!;
  const order = dayOrder(durations, homeRow ? indexes.map((to) => homeRow[to]!) : null, stops, home, limitSeconds);
  const ordered = order.map((index) => stops[index]!);
  const legSeconds = order.map((index, position) => (position === 0 ? null : durations[order[position - 1]!]![index]!));
  const distances = matrix.distances;
  const first = order.length ? indexes[order[0]!]! : null;
  const fromHome = (value: number | undefined) => (value === undefined || !Number.isFinite(value) ? null : value);
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
    homeDriveSeconds: homeRow && first !== null ? fromHome(homeRow[first]) : null,
    homeDriveMeters:
      distances && matrix.homeIndex !== null && first !== null ? fromHome(distances[matrix.homeIndex]![first]) : null,
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
  // Trimming reorders from the same matrix, home included, so a trimmed day is
  // still routed from home and its home leg is still real.
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
    current = { ...current, ...inMatrixOrder(rest, matrix, home, limitSeconds) };
  }
  return { crew: current, dropped };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    batches.push(items.slice(index, index + size));
  return batches;
}
