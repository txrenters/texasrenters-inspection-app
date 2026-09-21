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
 * are recomputed on every read -- by the day's timeline, which also knows how
 * long somebody has been at the stop they are on (`projectRemainder`). Before
 * this, the console asked Google for a fresh route every two minutes for as
 * long as a technician was selected, even when nothing about their day had
 * changed at all.
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

/**
 * The route split where the technician has got to: behind them, and ahead.
 *
 * A route is drawn once and reused for minutes, so its line keeps starting
 * where the technician *was*. Google Maps does not do this -- the road you have
 * driven disappears behind you -- and the office asked for the same
 * (2026-09-22: "the trail should also be gone with the arrow position like
 * google map navigation"). Between redraws the orange was a line to somewhere
 * they had already been.
 *
 * `travelled` is given back rather than thrown away so the map can draw it as
 * the day's history, in the same grey the finished stops use, instead of the
 * road simply vanishing.
 *
 * Two cases deliberately return the whole route as `ahead`:
 *
 * - **Off the line.** Past `OFF_ROUTE_M` the nearest point is not where they
 *   have got to, it is the point of a road they are not on -- trimming to it
 *   would erase a route they still have to drive every yard of. The redraw is
 *   what answers that, and until it lands the untrimmed line is the honest
 *   picture.
 * - **A route not started.** One drawn from home has no progress along it.
 *
 * The cut point is inserted exactly, so the remaining line begins at the
 * technician rather than at whichever shape point comes next -- which on a
 * motorway can be hundreds of metres ahead.
 */
export function splitRouteAtPosition(
  geometry: LatLngPath,
  position: { latitude: number; longitude: number } | null | undefined,
): { travelled: LatLngPath; ahead: LatLngPath } {
  if (!position || geometry.length < 2) return { travelled: [], ahead: geometry };
  const projected = projectOntoPath(position, geometry);
  if (!projected || projected.offsetMeters > OFF_ROUTE_M)
    return { travelled: [], ahead: geometry };

  let travelledSoFar = 0;
  for (let index = 1; index < geometry.length; index += 1) {
    const a = geometry[index - 1];
    const b = geometry[index];
    const length = haversineMeters(
      { latitude: a[0], longitude: a[1] },
      { latitude: b[0], longitude: b[1] },
    );
    const end = travelledSoFar + length;
    if (projected.alongMeters <= end || index === geometry.length - 1) {
      const t = length === 0 ? 0 : Math.max(0, Math.min(1, (projected.alongMeters - travelledSoFar) / length));
      const cut: readonly [number, number] = [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
      ];
      return {
        travelled: [...geometry.slice(0, index), cut],
        ahead: [cut, ...geometry.slice(index)],
      };
    }
    travelledSoFar = end;
  }
  return { travelled: [], ahead: geometry };
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

/**
 * How far down its drawn line a route's origin is, 0 to 1.
 *
 * A route is drawn once and reused for minutes, so its line starts where the
 * technician *was*. Projecting where they are now onto it is what lets the rest
 * of the day be timed from where they have since got to. A route from home has
 * not been started. A position nowhere near the line counts as not started
 * either, rather than as whichever point of the line happens to be closest.
 *
 * A fraction rather than metres because Google's polyline and its reported leg
 * distances are measured differently and never quite agree; a fraction of one
 * applies cleanly to the other.
 */
export function routeProgress(route: {
  originKind: RouteOriginKind | null;
  origin: { latitude: number; longitude: number } | null;
  geometry: LatLngPath;
}): number {
  if (route.originKind === 'HOME' || !route.origin || route.geometry.length < 2) return 0;
  const projected = projectOntoPath(route.origin, route.geometry);
  if (!projected || projected.totalMeters <= 0 || projected.offsetMeters > OFF_ROUTE_M) return 0;
  return projected.alongMeters / projected.totalMeters;
}
