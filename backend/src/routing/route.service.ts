import { Inject, Injectable } from '@nestjs/common';
import { InspectionStatus } from '@prisma/client';
import {
  chooseRouteOrigin,
  type DrawnRoute,
  haversineMeters,
  needsReroute,
  type RouteLeg,
  type RouteStop,
  type RouteTimingSource,
  shortestRouteOrder,
  type TechnicianAssignments,
  type TechnicianRoute,
} from '@texasrenters/shared';

import { PrismaService } from '../common/prisma.service';
import { businessDayBounds } from '../common/business-day';
import { GoogleRoutesClient, type GoogleRoute } from './google-routes.client';
import type { GeoPoint, OsrmRoute } from './osrm.client';
import { OsrmClient } from './osrm.client';

/**
 * A technician's day, in the order it should be driven.
 *
 * Two things this deliberately does not do. It does not store the order — there
 * is no `sequence` column, and adding one would assert that the technician is
 * expected to follow this, which is a dispatch policy nobody has set. And it
 * does not promise arrival times: `Inspection.scheduledAt` is a date with no
 * time of day, so no appointment exists to be early or late for. The estimates
 * of when each stop is reached belong to the day's timeline, which knows how
 * long somebody has already been at the stop they are on -- see
 * `projectRemainder`.
 */

/**
 * How many drawn routes are kept before the oldest is forgotten.
 *
 * One per technician per day anybody looked at. Unbounded, the cache only ever
 * grew: every date opened on the map stayed in memory, geometry and all, until
 * a deploy happened to restart the process. A hundred covers every technician's
 * yesterday, today and tomorrow several times over.
 */
export const MAX_DRAWN_ROUTES = 100;

/**
 * Work that is finished or abandoned is not somewhere to drive to.
 *
 * `TECHNICIAN_SUBMITTED` and everything after it means the technician has left
 * the property; routing them back to it would pad the day with a journey that
 * has no reason to happen.
 */
const VISITABLE: InspectionStatus[] = [
  InspectionStatus.SCHEDULED,
  InspectionStatus.IN_PROGRESS,
  InspectionStatus.FOLLOW_UP_REQUIRED,
];

/**
 * Work already done that day, read alongside what is left.
 *
 * Not routed to -- see `VISITABLE` -- but no longer dropped either: the map
 * lists it greyed out as the day's history, and draws the drive through it.
 * Cancelled work is neither, and stays out.
 */
const FINISHED: InspectionStatus[] = [
  InspectionStatus.TECHNICIAN_SUBMITTED,
  InspectionStatus.PROCESSING,
  InspectionStatus.REVIEW_REQUIRED,
  InspectionStatus.UNDER_REVIEW,
  InspectionStatus.TBD,
  InspectionStatus.COMPLETED,
];

/**
 * Whether a stop is finished work. Tolerates a missing status, which reads as
 * work still to do -- the conservative answer for a route.
 */
function isFinished(status: InspectionStatus | null | undefined) {
  return Boolean(status && FINISHED.includes(status));
}

/** When a finished inspection was handed in, as epoch ms, or null. */
function finishedAtOf(inspection: { submittedAt?: Date | null; completedAt?: Date | null }) {
  const at = inspection.submittedAt ?? inspection.completedAt ?? null;
  return at ? at.getTime() : null;
}

/**
 * OSRM's `[lon, lat]` path as `[lat, lng]`, which is what draws a map.
 *
 * Exported for its test. This is the third place in this codebase where the
 * two orders meet -- the Census geocoder puts longitude in `x`, OSRM takes
 * `lon,lat`, and Leaflet wants `lat,lng` -- and each time the failure is
 * silent: the line simply appears somewhere else on Earth.
 */
export function toLatLngPath(
  path: readonly [number, number][],
): [number, number][] {
  return path.map(([longitude, latitude]) => [latitude, longitude]);
}

/**
 * The closest stop as the crow flies, and how far that is.
 *
 * Only used when no road route exists, which is the one case where "nearest"
 * cannot be answered by driving time. Null for an empty day, so the console has
 * nothing to draw rather than a line to nowhere.
 */
function nearestByAir(
  origin: { latitude: number; longitude: number },
  stops: readonly RouteStop[],
): TechnicianRoute['airTravel'] {
  let best: TechnicianRoute['airTravel'] = null;

  for (const stop of stops) {
    const distanceMeters = Math.round(haversineMeters(origin, stop));
    if (!best || distanceMeters < best.distanceMeters)
      best = { inspectionId: stop.inspectionId, distanceMeters };
  }

  return best;
}

@Injectable()
export class RouteService {
  /**
   * Routes already drawn, per technician per day.
   *
   * In memory, because there is one backend process and a restart costs one
   * redraw per technician. Held with what it was drawn *from* -- the origin kind
   * and the stops -- which is what `needsReroute` compares against.
   */
  private readonly drawn = new Map<string, { route: TechnicianRoute; drawn: DrawnRoute }>();

  /**
   * Draws already under way, so two callers asking at once share one.
   *
   * The route panel and the day summary both read a technician's route, on
   * their own timers. When those land together on a day that needs redrawing,
   * each would otherwise start its own draw -- two billed Google requests for
   * one answer, on exactly the occasions a redraw happens.
   */
  private readonly inFlight = new Map<string, Promise<TechnicianRoute>>();

  /**
   * Drives already drawn through a day's finished stops, keyed by exactly what
   * they join.
   *
   * A day's history only changes when another stop is finished -- a handful of
   * times a day -- so the map can poll every thirty seconds without asking
   * Google again each time.
   */
  private readonly histories = new Map<string, [number, number][]>();
  private readonly historiesInFlight = new Map<string, Promise<[number, number][]>>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OsrmClient) private readonly osrm: OsrmClient,
    @Inject(GoogleRoutesClient) private readonly google: GoogleRoutesClient,
  ) {}

  /**
   * Travel times between every pair, from whichever router is configured.
   *
   * Google first. Not a preference for the paid service for its own sake --
   * OSRM has never been configured on this deployment, so `planDay` returned
   * its empty shape for every technician on every day: no line on the map, no
   * distance, no leg times, and no error to explain any of it. Google also
   * answers with traffic, which OSRM cannot.
   */
  private async durationsFor(points: readonly GeoPoint[]): Promise<number[][] | null> {
    if (this.google.configured) {
      const matrix = await this.google.matrix(points, new Date());
      if (matrix) return matrix.durations;
      // Falling through rather than failing: a quota or an outage should drop
      // to the free router, not to no route.
    }
    return this.osrm.durations(points);
  }

  /**
   * The drawn line and its legs, and which router drew them.
   *
   * The source travels with the route because the two answer different
   * questions: Google's times include traffic, and OSRM's are an empty road at
   * the speed limit. The console used to describe every route as the second,
   * whichever had answered.
   */
  private async driveFor(
    points: readonly GeoPoint[],
  ): Promise<{ drive: GoogleRoute | OsrmRoute; source: RouteTimingSource } | null> {
    if (this.google.configured) {
      const drive = await this.google.route(points);
      if (drive) return { drive, source: 'GOOGLE_TRAFFIC' };
    }
    const drive = await this.osrm.route(points);
    return drive ? { drive, source: 'OSRM_FREE_FLOW' } : null;
  }

  /**
   * Everyone with work today, and which properties it is at.
   *
   * One query for the whole roster rather than a route each: the console panel
   * needs to list people and highlight their properties, which is a grouping
   * problem, not a routing one. Planning a route per technician to answer it
   * would call OSRM once per person to draw a list.
   *
   * Technicians with nothing scheduled are absent rather than listed empty --
   * a dispatcher scanning the panel wants the people who are working, and a
   * row saying "no stops" for everyone off that day is noise.
   */
  async assignmentsByTechnician(
    organizationId: string,
    date: Date,
  ): Promise<TechnicianAssignments[]> {
    // The same Texas day `planDay` reads. The list of who is on the day and
    // the route drawn for each of them must never disagree about which stops
    // that is -- the map now hides anybody this list has no stops for.
    const { start: dayStart, end: dayEnd } = businessDayBounds(date);

    const assignments = await this.prisma.inspectionAssignment.findMany({
      where: {
        isCurrent: true,
        inspection: {
          organizationId,
          status: { in: [...VISITABLE, ...FINISHED] },
          scheduledAt: { gte: dayStart, lt: dayEnd },
        },
      },
      select: {
        technicianId: true,
        technician: { select: { displayName: true } },
        inspection: {
          select: {
            id: true,
            propertywareBuildingId: true,
            inspectionType: true,
            status: true,
            // The visit's actual start and end, as the app recorded them.
            startedAt: true,
            submittedAt: true,
            completedAt: true,
            // Both, for the same reason the route planner reads both: a real
            // inspection names a synced building, and `Property` exists only
            // where the inspection workflow happened to create one.
            propertywareBuilding: { select: { name: true } },
            property: { select: { name: true } },
          },
        },
      },
    });

    const byTechnician = new Map<string, TechnicianAssignments>();
    for (const assignment of assignments) {
      const existing = byTechnician.get(assignment.technicianId) ?? {
        technicianId: assignment.technicianId,
        displayName: assignment.technician?.displayName ?? 'Unknown technician',
        stops: [],
      };

      const inspection = assignment.inspection;
      existing.stops.push({
        inspectionId: inspection.id,
        // Null is carried rather than filtered. The technician still has to go
        // there; it simply cannot be pointed at on a map.
        buildingId: inspection.propertywareBuildingId,
        propertyName:
          inspection.propertywareBuilding?.name ??
          inspection.property?.name ??
          'Unknown property',
        inspectionType: inspection.inspectionType,
        status: inspection.status,
        finishedAt: isFinished(inspection.status)
          ? (() => {
              const at = finishedAtOf(inspection);
              return at === null ? null : new Date(at).toISOString();
            })()
          : null,
        startedAt: inspection.startedAt?.toISOString() ?? null,
        submittedAt: inspection.submittedAt?.toISOString() ?? null,
      });

      byTechnician.set(assignment.technicianId, existing);
    }

    for (const entry of byTechnician.values())
      // By property, because the day has no order of its own: `scheduledAt` is
      // a date with no clock value, so any sequence beyond alphabetical would
      // be invented. The suggested driving order lives on the route endpoint,
      // where it is computed rather than implied.
      entry.stops.sort((left, right) => left.propertyName.localeCompare(right.propertyName));

    return [...byTechnician.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }

  /**
   * Plan one technician's day.
   *
   * `date` is a plain calendar day because that is the only granularity the
   * schema has. Everything scheduled for it and still worth visiting is a stop.
   */
  async planDay(
    organizationId: string,
    technicianId: string,
    date: Date,
  ): Promise<TechnicianRoute> {
    /**
     * The day in Texas, not in UTC.
     *
     * UTC midnight is 6 or 7pm Texas the previous evening, so from dinner time
     * onward a UTC-bounded "today" held tomorrow's stops -- the same bug the
     * technician dashboard had and lost in #196. It also decides which
     * positions count as today's, which is now what picks the route's origin.
     */
    const { start: dayStart, end: dayEnd } = businessDayBounds(date);

    const assignments = await this.prisma.inspectionAssignment.findMany({
      where: {
        technicianId,
        isCurrent: true,
        inspection: {
          organizationId,
          status: { in: [...VISITABLE, ...FINISHED] },
          scheduledAt: { gte: dayStart, lt: dayEnd },
        },
      },
      select: {
        inspection: {
          select: {
            id: true,
            status: true,
            submittedAt: true,
            completedAt: true,
            // Both, and the building first.
            //
            // A real inspection carries `propertywareBuildingId` and leaves
            // `propertyId` null -- `Property` rows only exist where the
            // inspection workflow happened to create one. Reading only the
            // `property` relation therefore found nothing on real data and
            // reported every stop as unplaceable, while passing a test built
            // on fabricated rows that had `propertyId` set.
            //
            // The building is also what the map draws, so a route and a pin
            // now refer to the same record rather than two views of a
            // property that may not agree.
            propertywareBuilding: {
              select: {
                id: true,
                name: true,
                addressLine1: true,
                city: true,
                latitude: true,
                longitude: true,
              },
            },
            property: {
              select: {
                id: true,
                name: true,
                addressLine1: true,
                city: true,
                latitude: true,
                longitude: true,
              },
            },
          },
        },
      },
    });

    const routable: RouteStop[] = [];
    const unroutable: TechnicianRoute['unroutable'] = [];
    const finished: { stop: RouteStop; finishedAt: number | null }[] = [];

    for (const { inspection } of assignments) {
      const done = isFinished(inspection.status);
      // The synced building is the truth for where a property is; the
      // `Property` row is a fallback for the handful of inspections created
      // through the floor-plan or technician paths.
      const property = inspection.propertywareBuilding ?? inspection.property;
      // Carried, not dropped. A property that never geocoded cannot be routed
      // to, and quietly omitting it turns "you have five inspections" into a
      // route of four with nothing to explain the difference.
      if (!property?.latitude || !property.longitude) {
        // A finished stop with no coordinate is simply not drawn. It is not
        // somewhere left to go, so it is no concern of `unroutable`.
        if (done) continue;
        unroutable.push({
          inspectionId: inspection.id,
          propertyName: property?.name ?? 'Unknown property',
          reason: 'NO_COORDINATES',
        });
        continue;
      }
      const stop: RouteStop = {
        inspectionId: inspection.id,
        propertyId: property.id,
        propertyName: property.name,
        // Nullable on a synced record and not on the contract. An empty string
        // rather than dropping the stop: a thin label is still a place to
        // drive to, a missing stop is a property nobody is told about.
        addressLine1: property.addressLine1 ?? '',
        city: property.city ?? '',
        latitude: property.latitude.toNumber(),
        longitude: property.longitude.toNumber(),
      };
      if (done) finished.push({ stop, finishedAt: finishedAtOf(inspection) });
      else routable.push(stop);
    }

    // In the order they were handed in. One with no time sorts last rather
    // than being guessed into the middle of the day.
    const finishedStops = finished
      .sort(
        (left, right) =>
          (left.finishedAt ?? Number.POSITIVE_INFINITY) - (right.finishedAt ?? Number.POSITIVE_INFINITY),
      )
      .map((entry) => entry.stop);

    const now = Date.now();
    const [position, profile] = await Promise.all([
      this.prisma.technicianLocationPing.findFirst({
        // That day's newest position, not the newest there is. Opening last
        // Tuesday must not start its route from wherever somebody is today.
        where: { organizationId, technicianId, recordedAt: { gte: dayStart, lt: dayEnd } },
        orderBy: { recordedAt: 'desc' },
        select: { latitude: true, longitude: true, recordedAt: true },
      }),
      // Scoped to the organization like the position above. The admin route
      // endpoint takes any technician id, and an empty day for somebody in
      // another organization still returns its origin -- their home.
      this.prisma.technicianPlanningProfile.findFirst({
        where: { organizationId, technicianId },
        select: { homeLatitude: true, homeLongitude: true },
      }),
    ]);

    /**
     * Where the day starts -- see `chooseRouteOrigin`.
     *
     * This was "the newest position, however old", which started Monday's route
     * from wherever a phone happened to be at four in the morning on Saturday.
     */
    const chosen = chooseRouteOrigin(
      position
        ? {
            latitude: position.latitude.toNumber(),
            longitude: position.longitude.toNumber(),
            recordedAt: position.recordedAt.toISOString(),
          }
        : null,
      profile?.homeLatitude && profile.homeLongitude
        ? {
            latitude: profile.homeLatitude.toNumber(),
            longitude: profile.homeLongitude.toNumber(),
          }
        : null,
      dayStart,
      now,
    );
    const origin = chosen?.point ?? null;
    const originKind = chosen?.kind ?? null;

    const key = `${organizationId}:${technicianId}:${dayStart.toISOString()}`;
    const history = await this.historyFor(
      key,
      profile?.homeLatitude && profile.homeLongitude
        ? { latitude: profile.homeLatitude.toNumber(), longitude: profile.homeLongitude.toNumber() }
        : null,
      finishedStops,
    );

    const empty: TechnicianRoute = {
      technicianId,
      origin,
      originKind,
      stops: routable,
      legs: [],
      totalDistanceMeters: 0,
      totalDurationSeconds: 0,
      unroutable,
      geometry: [],
      history,
      originOutsideServiceArea: false,
      airTravel: null,
      // Nothing drawn, so nothing was timed.
      source: null,
    };

    // Without a position there is no starting point, and without at least one
    // stop there is nothing to order. Both return the stops unordered rather
    // than an error: the day is still known, it simply has no route yet.
    if (!origin || !routable.length) return empty;

    /**
     * Reuse the drawn route unless the day has changed enough to redraw it.
     *
     * Asking Google is a billed request, and the console used to make two of
     * them every two minutes for as long as a technician was selected --
     * whether or not anything about their day had moved. `needsReroute`
     * decides. The origin is refreshed on every call regardless, so a reused
     * line can still be timed from where somebody now stands -- which costs
     * nothing, and is the timeline's job.
     */
    const stopIds = routable.map((stop) => stop.inspectionId);
    const cached = this.drawn.get(key);
    const decision = needsReroute(
      cached?.drawn ?? null,
      { originKind, stopIds, position: originKind === 'LIVE' ? origin : null },
      now,
    );
    if (!decision.reroute && cached)
      // The history is the fresh one: it is read every call and cached on its own.
      return { ...cached.route, origin, originKind, history };

    /**
     * Callers share a draw only when they are asking for the same one.
     *
     * Keyed by the day alone, a caller whose stop had just been finished could
     * join a draw still under way for the old stops, get that route back, and
     * remember it as drawn for the new ones -- after which nothing noticed the
     * finished stop was still on it. A home route never redraws for age, so
     * that lasted the rest of the day.
     */
    const flightKey = `${key}:${originKind}:${[...stopIds].sort().join(',')}`;
    const pending =
      this.inFlight.get(flightKey) ??
      this.drawRoute(technicianId, origin, originKind, routable, unroutable, empty).finally(() =>
        this.inFlight.delete(flightKey),
      );
    this.inFlight.set(flightKey, pending);
    const route = await pending;

    /**
     * Only a route that actually drew is remembered.
     *
     * A draw that failed -- an outage, a quota, a position off the network --
     * comes back with no legs. Caching that would pin an empty route in place
     * for five minutes after the router recovered, which reads on the map
     * exactly like routing being broken.
     */
    this.drawn.delete(key);
    if (route.legs.length) {
      // Deleted and re-added rather than overwritten, so the map stays in
      // drawn order and the bound below forgets the longest-untouched day.
      this.drawn.set(key, {
        route,
        drawn: { originKind, stopIds, geometry: route.geometry, computedAt: Date.now() },
      });
      for (const oldest of this.drawn.keys()) {
        if (this.drawn.size <= MAX_DRAWN_ROUTES) break;
        this.drawn.delete(oldest);
      }
    }

    return route;
  }

  /**
   * The drive through a day's finished stops, from home when it is known.
   *
   * Drawn in the order the stops were handed in, which is the order they were
   * driven -- close enough for a line that says "this part of the day is done".
   * Nothing to join (fewer than two points) or nothing drawn leaves the line
   * empty and the stops still marked; a failed draw is not remembered, for the
   * same reason as the route's.
   */
  private async historyFor(
    dayKey: string,
    home: GeoPoint | null,
    stops: RouteStop[],
  ): Promise<TechnicianRoute['history']> {
    const points: GeoPoint[] = [...(home ? [home] : []), ...stops];
    if (points.length < 2) return { stops, geometry: [] };

    const cacheKey = [
      dayKey,
      home ? `${home.latitude},${home.longitude}` : 'no-home',
      ...stops.map((stop) => stop.inspectionId),
    ].join('|');
    const cached = this.histories.get(cacheKey);
    if (cached) return { stops, geometry: cached };

    const pending =
      this.historiesInFlight.get(cacheKey) ??
      this.driveFor(points)
        .then((timed) => (timed?.drive.legs.length ? toLatLngPath(timed.drive.geometry) : []))
        .catch(() => [] as [number, number][])
        .finally(() => this.historiesInFlight.delete(cacheKey));
    this.historiesInFlight.set(cacheKey, pending);
    const geometry = await pending;

    if (geometry.length) {
      this.histories.set(cacheKey, geometry);
      for (const oldest of this.histories.keys()) {
        if (this.histories.size <= MAX_DRAWN_ROUTES) break;
        this.histories.delete(oldest);
      }
    }
    return { stops, geometry };
  }

  /** Orders and draws the route through Google or OSRM. The expensive part. */
  private async drawRoute(
    technicianId: string,
    origin: NonNullable<TechnicianRoute['origin']>,
    originKind: TechnicianRoute['originKind'],
    routable: RouteStop[],
    unroutable: TechnicianRoute['unroutable'],
    empty: TechnicianRoute,
  ): Promise<TechnicianRoute> {
    let stops = routable;
    let matrix = await this.durationsFor([origin, ...stops]);

    if (!matrix) {
      // The matrix refuses the whole request when any one point is off the
      // road network, and does not say which. Ask per point.
      //
      // This is the branch that used to not exist, and its absence is what
      // drew a four-hour drive from a technician who was on another continent:
      // OSRM answered `Ok` for a point it had quietly relocated, so there was
      // never a failure to handle.
      const reachable = await this.osrm.snappable([origin, ...stops]);

      // Null means OSRM could not be asked, which is an outage rather than a
      // fact about any of these points. Blaming the technician's position for
      // it would be a confident wrong answer of exactly the kind this whole
      // change is about.
      if (!reachable) return empty;

      // The origin first, because a route without a starting point is not a
      // shorter route -- it is a different question. Starting from the first
      // stop instead would silently answer that different question.
      if (!reachable[0])
        return {
          ...empty,
          originOutsideServiceArea: true,
          // The nearest stop, so the console can draw one line and give one
          // number rather than a fan of them. Nearest by great-circle because
          // there is no road distance to sort by -- that is the whole problem.
          airTravel: nearestByAir(origin, stops),
        };

      const kept: RouteStop[] = [];
      stops.forEach((stop, index) => {
        if (reachable[index + 1]) kept.push(stop);
        else
          // Moved rather than dropped, so the panel still lists the property
          // and can say why it is not in the drive. A geocode that landed in
          // open water is a data fault worth seeing, not one worth hiding.
          unroutable.push({
            inspectionId: stop.inspectionId,
            propertyName: stop.propertyName,
            reason: 'OUTSIDE_SERVICE_AREA',
          });
      });

      if (!kept.length) return { ...empty, stops: [], unroutable };

      stops = kept;
      matrix = await this.durationsFor([origin, ...stops]);
      if (!matrix) return { ...empty, stops, unroutable };
    }

    const order = shortestRouteOrder(matrix);
    const ordered = order.map((index) => stops[index - 1]).filter(Boolean) as RouteStop[];

    const timed = await this.driveFor([origin, ...ordered]);
    if (!timed) return { ...empty, stops: ordered, unroutable };
    const { drive, source } = timed;

    // OSRM returns one leg per consecutive pair, so leg `i` arrives at stop
    // `i`. The first has no `fromStopId` because it starts at the technician.
    const legs: RouteLeg[] = drive.legs.map((leg, index) => ({
      fromStopId: index === 0 ? null : (ordered[index - 1]?.inspectionId ?? null),
      toStopId: ordered[index]?.inspectionId ?? '',
      distanceMeters: Math.round(leg.distanceMeters),
      durationSeconds: Math.round(leg.durationSeconds),
    }));

    return {
      technicianId,
      origin,
      originKind,
      stops: ordered,
      legs,
      totalDistanceMeters: Math.round(drive.distanceMeters),
      totalDurationSeconds: Math.round(drive.durationSeconds),
      unroutable,
      geometry: toLatLngPath(drive.geometry),
      history: empty.history,
      // False by construction: getting here means the origin snapped to a road.
      originOutsideServiceArea: false,
      airTravel: null,
      source,
    };
  }
}
