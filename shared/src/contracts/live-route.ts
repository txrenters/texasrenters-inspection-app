import { haversineMeters, type RouteOriginKind } from './route-plan.js';

/**
 * A route that follows the technician, the way a navigation app does.
 *
 * Two costs are pulled apart on purpose. **Drawing** a route means asking
 * Google, which is a billed request with traffic. **Timing** the rest of an
 * already-drawn route from where somebody now is costs nothing -- it is
 * arithmetic on the legs Google already returned.
 *
 * So the route is redrawn only on a *material* change, and the arrival times
 * are recomputed on every read. Before this, the console asked Google for a
 * fresh route every two minutes for as long as a technician was selected, even
 * when nothing about their day had changed at all.
 */

type LatLngPath = readonly (readonly [number, number])[];

/**
 * How far off the drawn line counts as having left it.
 *
 * A hundred and fifty metres. GPS in a street wanders twenty or thirty either
 * side of the road, and a car turning into a driveway or a car park is briefly
 * further still; a tighter threshold would redraw the route every time
 * somebody parked. Wider, and a genuine wrong turn onto the parallel street
 * would be followed for a block before anything noticed.
 */
export const OFF_ROUTE_M = 150;

/**
 * How old a live route may get before traffic is worth asking about again.
 *
 * Five minutes. Congestion builds and clears on that scale, and the ETA only
 * changes meaningfully when it does. Applied to live routes only: a route drawn
 * from somebody's house has no traffic of theirs to track until they set off.
 */
export const MAX_LIVE_ROUTE_AGE_MS = 5 * 60_000;

/**
 * Where a point sits relative to a path.
 *
 * `alongMeters` is how far down the path its nearest point lies, and
 * `offsetMeters` how far the point is from that nearest point. Null for a path
 * with fewer than two points, which has no length to be along.
 *
 * Distances inside a segment use a local flat projection, which is exact to
 * well under a metre over the tens-to-hundreds-of-metres a route segment spans;
 * the segment lengths themselves are great-circle.
 */
export function projectOntoPath(
  point: { latitude: number; longitude: number },
  path: LatLngPath,
): { alongMeters: number; offsetMeters: number; totalMeters: number } | null {
  if (path.length < 2) return null;

  let travelled = 0;
  let best: { alongMeters: number; offsetMeters: number } | null = null;

  for (let index = 1; index < path.length; index += 1) {
    const [aLat, aLng] = path[index - 1];
    const [bLat, bLng] = path[index];
    const length = haversineMeters(
      { latitude: aLat, longitude: aLng },
      { latitude: bLat, longitude: bLng },
    );

    // Metres per degree at this latitude, for a flat local frame around A.
    const kx = 111_320 * Math.cos((aLat * Math.PI) / 180);
    const ky = 110_540;
    const abx = (bLng - aLng) * kx;
    const aby = (bLat - aLat) * ky;
    const apx = (point.longitude - aLng) * kx;
    const apy = (point.latitude - aLat) * ky;

    const lengthSquared = abx * abx + aby * aby;
    const t =
      lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / lengthSquared));
    const dx = apx - t * abx;
    const dy = apy - t * aby;
    const offsetMeters = Math.hypot(dx, dy);

    if (!best || offsetMeters < best.offsetMeters)
      best = { alongMeters: travelled + t * length, offsetMeters };
    travelled += length;
  }

  return best ? { ...best, totalMeters: travelled } : null;
}

export type RerouteReason =
  | 'NO_ROUTE'
  | 'ORIGIN_CHANGED'
  | 'STOPS_CHANGED'
  | 'OFF_ROUTE'
  | 'STALE';

/** What is remembered about a route that has been drawn. */
export interface DrawnRoute {
  originKind: RouteOriginKind | null;
  stopIds: readonly string[];
  geometry: LatLngPath;
  computedAt: number;
}

/**
 * Whether the day has changed enough to be worth asking Google again.
 *
 * In order of how certain the answer is:
 *
 * - **No route yet** -- nothing to reuse.
 * - **The origin changed kind.** Somebody came online, or a route from home
 *   learned they had left it. The start of the route moved somewhere
 *   categorically different. Going *quiet* is the exception -- see below.
 * - **The remaining stops changed.** A visit finished, or the office moved an
 *   inspection onto or off their day. Compared as a set, because the order is
 *   what the redraw would decide.
 * - **They left the line** -- more than `OFF_ROUTE_M` from it while live.
 * - **Traffic has had time to change** -- a live route older than
 *   `MAX_LIVE_ROUTE_AGE_MS`.
 *
 * A home route is never redrawn for age or for position. Until somebody's
 * handset is reporting, there is no drive in progress to track, and the only
 * thing that should move the line is their day or their address changing.
 *
 * Nor is a live route redrawn because the handset stopped reporting. Routes are
 * recalculated while somebody is online and sending; once they go quiet, the
 * line last drawn from their live position is still the newest thing known
 * about where they are headed, and redrawing it from the last point it already
 * started near would be a billed request for the same line. When they come back
 * the route is older than `MAX_LIVE_ROUTE_AGE_MS`, and redraws from where they
 * are.
 */
export function needsReroute(
  drawn: DrawnRoute | null,
  current: {
    originKind: RouteOriginKind | null;
    stopIds: readonly string[];
    position: { latitude: number; longitude: number } | null;
  },
  now: number = Date.now(),
): { reroute: boolean; reason: RerouteReason | null } {
  if (!drawn) return { reroute: true, reason: 'NO_ROUTE' };
  const wentQuiet = drawn.originKind === 'LIVE' && current.originKind === 'LAST_KNOWN';
  if (drawn.originKind !== current.originKind && !wentQuiet)
    return { reroute: true, reason: 'ORIGIN_CHANGED' };

  const before = new Set(drawn.stopIds);
  const sameStops =
    before.size === current.stopIds.length && current.stopIds.every((id) => before.has(id));
  if (!sameStops) return { reroute: true, reason: 'STOPS_CHANGED' };

  if (current.originKind === 'LIVE') {
    if (current.position && drawn.geometry.length >= 2) {
      const projected = projectOntoPath(current.position, drawn.geometry);
      if (projected && projected.offsetMeters > OFF_ROUTE_M)
        return { reroute: true, reason: 'OFF_ROUTE' };
    }
    if (now - drawn.computedAt > MAX_LIVE_ROUTE_AGE_MS) return { reroute: true, reason: 'STALE' };
  }

  return { reroute: false, reason: null };
}

/** A stop's expected arrival, and whether it is still ahead. */
export interface StopArrival {
  inspectionId: string;
  /** ISO 8601. */
  arriveAt: string;
  /** Seconds of driving still between the technician and this stop. */
  driveSeconds: number;
}

/**
 * When each stop still ahead will be reached.
 *
 * Driving time comes from the legs Google returned, pro-rated along the leg the
 * technician is part-way down -- so a leg of twenty minutes that is three
 * quarters driven has five left. Each stop reached before this one adds the
 * time spent inside it, because an arrival that ignores the work in between is
 * an arrival that never happens.
 *
 * Stops already behind the technician are left out rather than given an
 * arrival in the past, which a panel would print as though it were a forecast.
 *
 * `progressFraction` is how far down the drawn line they are, 0 to 1. Taken as
 * a fraction rather than in metres because Google's polyline and its reported
 * leg distances are measured differently and never quite agree; a fraction of
 * one applies cleanly to the other.
 */
export function estimateArrivals(
  route: {
    stops: readonly { inspectionId: string }[];
    legs: readonly { durationSeconds: number; distanceMeters: number }[];
  },
  progressFraction: number | null,
  onSiteSeconds: number,
  now: number = Date.now(),
): StopArrival[] {
  const legs = route.legs.slice(0, route.stops.length);
  if (!legs.length) return [];

  const totalDistance = legs.reduce((sum, leg) => sum + leg.distanceMeters, 0);
  const along =
    progressFraction === null || !Number.isFinite(progressFraction)
      ? 0
      : Math.max(0, Math.min(1, progressFraction)) * totalDistance;

  const arrivals: StopArrival[] = [];
  let legStart = 0;
  let drivingAhead = 0;
  let stopsReachedFirst = 0;

  legs.forEach((leg, index) => {
    const legEnd = legStart + leg.distanceMeters;

    if (legEnd <= along) {
      // Entirely behind them: this stop has been passed.
      legStart = legEnd;
      return;
    }

    // The part of this leg still to drive. A leg with no distance -- two stops
    // at one address -- has none, and must not divide by zero into NaN.
    const remainingFraction =
      leg.distanceMeters > 0 ? (legEnd - Math.max(along, legStart)) / leg.distanceMeters : 0;
    drivingAhead += leg.durationSeconds * remainingFraction;

    const seconds = drivingAhead + stopsReachedFirst * onSiteSeconds;
    arrivals.push({
      inspectionId: route.stops[index].inspectionId,
      arriveAt: new Date(now + seconds * 1000).toISOString(),
      driveSeconds: Math.round(drivingAhead),
    });

    stopsReachedFirst += 1;
    legStart = legEnd;
  });

  return arrivals;
}
