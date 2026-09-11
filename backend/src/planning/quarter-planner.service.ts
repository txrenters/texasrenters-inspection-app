import { Inject, Injectable, Logger } from '@nestjs/common';
import { DriveTimeSource, InspectionType, PlanOriginKind, TbpStopStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import {
  DEFAULT_DAILY_STOP_CAP,
  type PlannableDay,
  type PlannableStop,
  type PlannableTechnician,
  type Quarter,
  assignQuarter,
  nearestNeighbourOrder,
  quarterLabel,
  shortestRouteOrder,
  workingDaysOfQuarter,
} from '@texasrenters/shared';

import { TechnicianSkillsService } from '../admin/technician-skills.service';
import { PrismaService } from '../common/prisma.service';
import { GoogleRoutesClient } from '../routing/google-routes.client';
import type { GeoPoint } from '../routing/osrm.client';
import { OsrmClient } from '../routing/osrm.client';

/**
 * The clock time the traffic model is asked about.
 *
 * A quarter is planned months ahead, so Google needs a *when* as well as a
 * where — a Tuesday morning and a Friday evening are different roads. Nine in
 * the morning, Central, is when these visits actually start.
 */
const ASSUMED_START_HOUR_UTC = 14;

/** A technician-day, once it has been placed but before it has been routed. */
interface Crew {
  technicianId: string;
  date: string;
  stops: PlannableStop[];
}

export interface RoutingSummary {
  planId: string;
  quarter: Quarter;
  placed: number;
  unplaced: { stopId: string; reason: string }[];
  capacity: { stops: number; slots: number };
  days: number;
  durationSource: DriveTimeSource | null;
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
   */
  async route(organizationId: string, planId: string, holidays: readonly string[] = []) {
    const plan = await this.prisma.tbpQuarterPlan.findFirstOrThrow({
      where: { id: planId, organizationId },
      select: { id: true, quarterYear: true, quarterNumber: true },
    });
    const quarter: Quarter = {
      year: plan.quarterYear,
      quarter: plan.quarterNumber as Quarter['quarter'],
    };

    const stops = await this.plannableStops(organizationId, planId);
    const dates = workingDaysOfQuarter(quarter, holidays);
    const { technicians, days } = await this.availability(organizationId, dates);

    const assignment = assignQuarter(stops, technicians, days, nearestNeighbourOrder);

    const crews = groupIntoCrews(assignment.placed, stops);
    const routed = await this.routeCrews(crews);

    await this.persist(organizationId, planId, routed);

    const summary: RoutingSummary = {
      planId,
      quarter,
      placed: assignment.placed.length,
      unplaced: assignment.unplaced,
      capacity: assignment.capacity,
      days: routed.length,
      durationSource: routed[0]?.durationSource ?? null,
    };

    if (assignment.capacity.stops > assignment.capacity.slots)
      // Loudly, and before publish. Silently truncating a quarter would leave
      // tenancies uninspected with nothing anywhere saying which.
      this.logger.warn({
        event: 'tbp_plan_capacity_shortfall',
        quarter: quarterLabel(quarter),
        planId,
        stops: assignment.capacity.stops,
        slots: assignment.capacity.slots,
        shortfall: assignment.capacity.stops - assignment.capacity.slots,
      });

    this.logger.log({
      event: 'tbp_plan_routed',
      organizationId,
      quarter: quarterLabel(quarter),
      planId,
      placed: summary.placed,
      unplaced: summary.unplaced.length,
      days: summary.days,
      durationSource: summary.durationSource,
    });

    return summary;
  }

  /**
   * The stops that can be placed at all.
   *
   * A stop whose building never geocoded has no coordinates, so no day can be
   * chosen for it on any sensible basis. It is marked rather than dropped —
   * `NO_COORDINATES` on the stop is what turns "this tenancy vanished" into
   * "this address needs geocoding", which is a thing somebody can act on.
   */
  private async plannableStops(organizationId: string, planId: string) {
    const rows = await this.prisma.tbpQuarterPlanStop.findMany({
      where: { planId, organizationId, status: TbpStopStatus.PLANNED },
      select: {
        id: true,
        sequence: true,
        propertywareBuilding: { select: { latitude: true, longitude: true } },
      },
      orderBy: { sequence: 'asc' },
    });

    const placeable: PlannableStop[] = [];
    const unplaceable: string[] = [];
    for (const row of rows) {
      const latitude = row.propertywareBuilding?.latitude;
      const longitude = row.propertywareBuilding?.longitude;
      if (latitude === null || latitude === undefined || longitude === null || longitude === undefined) {
        unplaceable.push(row.id);
        continue;
      }
      placeable.push({
        stopId: row.id,
        sequence: row.sequence,
        latitude: Number(latitude),
        longitude: Number(longitude),
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

    return placeable;
  }

  /**
   * Who can work each day of the quarter.
   *
   * Two independent gates, and both matter. `isPlannable` is a coordinator
   * saying "not this quarter" — long leave, a supervisor who only covers.
   * Qualification is per date, because a certificate lapsing mid-quarter must
   * take away the later days and leave the earlier ones alone.
   */
  private async availability(organizationId: string, dates: readonly string[]) {
    const profiles = await this.prisma.technicianPlanningProfile.findMany({
      where: { organizationId },
      select: { technicianId: true, dailyStopCap: true, isPlannable: true },
    });
    const capOf = new Map(profiles.map((row) => [row.technicianId, row.dailyStopCap]));
    // Absent means "no opinion recorded", which is plannable. Requiring a row
    // would mean a newly provisioned technician silently gets no work.
    const excluded = new Set(
      profiles.filter((row) => !row.isPlannable).map((row) => row.technicianId),
    );

    const calendar = await this.skills.qualificationCalendar(
      organizationId,
      InspectionType.OCCUPIED,
      dates.map((date) => new Date(`${date}T00:00:00.000Z`)),
    );

    const seen = new Set<string>();
    const days: PlannableDay[] = dates.map((date) => {
      const qualified = (calendar.get(date) ?? [])
        .filter((candidate) => !excluded.has(candidate.technicianId))
        // Most qualified first, so `splitAmongTechnicians` opens the strongest
        // crews when a day does not need everybody.
        .sort((left, right) => right.preferredHeld - left.preferredHeld);
      for (const candidate of qualified) seen.add(candidate.technicianId);
      return { date, technicianIds: qualified.map((candidate) => candidate.technicianId) };
    });

    const technicians: PlannableTechnician[] = [...seen].map((technicianId) => ({
      technicianId,
      dailyStopCap: capOf.get(technicianId) ?? DEFAULT_DAILY_STOP_CAP,
    }));

    return { technicians, days };
  }

  /**
   * Order each crew's day and price it.
   *
   * Google first, OSRM second, straight-line last. The fallbacks are ordered by
   * how much they can honestly claim: traffic-aware seconds, free-flow seconds,
   * and then a distance with no time attached at all — because a made-up
   * duration is worse than an absent one, and a plan that says "five hours"
   * when it means "we did not measure" is how somebody ends up late.
   */
  private async routeCrews(crews: readonly Crew[]) {
    const routed: (Crew & {
      ordered: PlannableStop[];
      durationSource: DriveTimeSource;
      totalDriveSeconds: number | null;
      totalDriveMeters: number | null;
      origin: GeoPoint;
      originKind: PlanOriginKind;
      departureAssumedAt: Date;
    })[] = [];

    for (const crew of crews) {
      // No origin exists for a future day — `RouteService.planDay` starts from a
      // live GPS ping and there is no such thing three months out. The centre of
      // the day's own stops is the honest stand-in: it orders the day correctly
      // and claims nothing about when the first door is knocked on.
      const origin = centroid(crew.stops);
      const departureAssumedAt = new Date(`${crew.date}T${String(ASSUMED_START_HOUR_UTC).padStart(2, '0')}:00:00.000Z`);
      const points: GeoPoint[] = [origin, ...crew.stops];

      const google = await this.google.matrix(points, departureAssumedAt);
      const durations = google?.durations ?? (await this.osrm.durations(points));

      if (durations) {
        const order = shortestRouteOrder(durations);
        const ordered = order.map((index) => crew.stops[index - 1]);
        routed.push({
          ...crew,
          ordered,
          durationSource: google
            ? DriveTimeSource.GOOGLE_TRAFFIC_AWARE
            : DriveTimeSource.OSRM_FREE_FLOW,
          totalDriveSeconds: Math.round(totalBetweenStops(durations, order)),
          totalDriveMeters: google ? Math.round(totalBetweenStops(google.distances, order)) : null,
          origin,
          originKind: PlanOriginKind.CLUSTER_CENTROID,
          departureAssumedAt,
        });
        continue;
      }

      // Straight-line: a real distance, and deliberately no seconds. We know how
      // far apart the stops are; we do not know how long the drive takes.
      const ordered = nearestNeighbourOrder(crew.stops);
      routed.push({
        ...crew,
        ordered,
        durationSource: DriveTimeSource.HAVERSINE,
        totalDriveSeconds: null,
        totalDriveMeters: Math.round(straightLineMeters(ordered)),
        origin,
        originKind: PlanOriginKind.CLUSTER_CENTROID,
        departureAssumedAt,
      });
    }

    return routed;
  }

  private async persist(
    organizationId: string,
    planId: string,
    routed: Awaited<ReturnType<QuarterPlannerService['routeCrews']>>,
  ) {
    // Cleared first, so a re-route never leaves a day from the previous run
    // sitting beside the new ones and doubling the forecast.
    await this.prisma.tbpQuarterPlanDay.deleteMany({ where: { planId } });

    for (const batch of chunk(routed, 20)) {
      await this.prisma.$transaction(async (tx) => {
        for (const crew of batch) {
          await tx.tbpQuarterPlanDay.create({
            data: {
              organizationId,
              planId,
              technicianId: crew.technicianId,
              date: new Date(`${crew.date}T00:00:00.000Z`),
              stopCount: crew.ordered.length,
              totalDriveSeconds: crew.totalDriveSeconds,
              totalDriveMeters: crew.totalDriveMeters,
              originLatitude: crew.origin.latitude,
              originLongitude: crew.origin.longitude,
              originKind: crew.originKind,
              durationSource: crew.durationSource,
              departureAssumedAt: crew.departureAssumedAt,
            },
          });

          for (const [index, stop] of crew.ordered.entries()) {
            await tx.tbpQuarterPlanStop.update({
              where: { id: stop.stopId },
              // A coordinator's own choice of day or technician is never
              // overwritten by a re-route; the two `*OverriddenAt` guards are
              // what make re-routing safe to run more than once.
              data: {
                ...(await this.respectOverrides(tx, stop.stopId, crew)),
                positionInDay: index + 1,
              },
            });
          }
        }
      });
    }
  }

  private async respectOverrides(
    tx: Prisma.TransactionClient,
    stopId: string,
    crew: { date: string; technicianId: string },
  ) {
    const existing = await tx.tbpQuarterPlanStop.findUnique({
      where: { id: stopId },
      select: { scheduleOverriddenAt: true, technicianOverriddenAt: true },
    });
    return {
      ...(existing?.scheduleOverriddenAt
        ? {}
        : { scheduledOn: new Date(`${crew.date}T00:00:00.000Z`) }),
      ...(existing?.technicianOverriddenAt ? {} : { assignedTechnicianId: crew.technicianId }),
    };
  }
}

function groupIntoCrews(
  placed: readonly { stopId: string; date: string; technicianId: string; position: number }[],
  stops: readonly PlannableStop[],
): Crew[] {
  const byStopId = new Map(stops.map((stop) => [stop.stopId, stop]));
  const crews = new Map<string, Crew>();
  for (const entry of [...placed].sort((left, right) => left.position - right.position)) {
    const key = `${entry.date}|${entry.technicianId}`;
    const crew = crews.get(key) ?? {
      technicianId: entry.technicianId,
      date: entry.date,
      stops: [],
    };
    const stop = byStopId.get(entry.stopId);
    if (stop) crew.stops.push(stop);
    crews.set(key, crew);
  }
  return [...crews.values()];
}

function centroid(stops: readonly PlannableStop[]): GeoPoint {
  return {
    latitude: stops.reduce((total, stop) => total + stop.latitude, 0) / stops.length,
    longitude: stops.reduce((total, stop) => total + stop.longitude, 0) / stops.length,
  };
}

/**
 * Sums the matrix between stops, **skipping the leg from the origin**.
 *
 * The origin here is the centre of the day's own stops, not a place anybody
 * starts from — `RouteService.planDay` gets a real one from a live GPS ping,
 * and there is no such thing for a day three months out. It anchors the
 * ordering and nothing else, so counting the drive *from* it would add a
 * journey nobody makes to every day in the quarter.
 *
 * A day of one stop therefore has no drive at all, which is the right answer:
 * there is nothing to drive between.
 */
function totalBetweenStops(
  matrix: readonly (readonly number[])[],
  order: readonly number[],
): number {
  let total = 0;
  for (let index = 1; index < order.length; index += 1) {
    const leg = matrix[order[index - 1]]?.[order[index]];
    if (Number.isFinite(leg)) total += leg as number;
  }
  return total;
}

/** Straight-line metres between consecutive stops, for the same reason. */
function straightLineMeters(ordered: readonly PlannableStop[]): number {
  let total = 0;
  for (let index = 1; index < ordered.length; index += 1)
    total += haversine(ordered[index - 1], ordered[index]);
  return total;
}

function haversine(from: GeoPoint, to: GeoPoint): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadius = 6_371_000;
  const deltaLat = radians(to.latitude - from.latitude);
  const deltaLon = radians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(deltaLon / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(a)));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    batches.push(items.slice(index, index + size));
  return batches;
}
