import { haversineMeters } from './route-plan.js';
import { ARRIVAL_RADIUS_M } from './technician-timeline.js';

/**
 * Where a technician actually went, as a line on the technician map (the
 * office, 2026-10-02: "add ... the trailing lines").
 *
 * The map drew where they were going -- the planned route -- and never where
 * they had been: the grey "history" line is the road between the stops they
 * finished, routed after the fact, not the drive they made. The handset has
 * reported its position all day for weeks (`TechnicianLocationPing`, kept 30
 * days), so the path is already stored; this turns a day of fixes into lines
 * worth drawing.
 *
 * Three things a raw trail gets wrong, each handled here rather than by the
 * map:
 * - **vague fixes**: a phone indoors reports a position a few hundred metres
 *   out; drawn, it zig-zags across the street. Dropped past
 *   `TRAIL_MAX_ACCURACY_METERS`.
 * - **teleports**: a single fix kilometres away and back. Anything implying
 *   more than `TRAIL_MAX_SPEED_MS` is dropped.
 * - **silence**: a phone that stops reporting mid-drive and resumes across
 *   town would be joined by a straight line through people's houses. A gap
 *   long in time *and* in distance ends one segment and starts another, so the
 *   map shows a break. A long gap in one place is somebody standing still and
 *   stays joined -- the distinction the day timeline already makes.
 */

export interface TrailFix {
  latitude: number;
  longitude: number;
  recordedAt: string;
  accuracyMeters?: number | null;
}

/** One unbroken stretch of the day, `[latitude, longitude]` like every path in the console. */
export interface TrailSegment {
  startedAt: string;
  endedAt: string;
  points: [number, number][];
}

export interface TechnicianTrail {
  technicianId: string;
  segments: TrailSegment[];
  /** How many fixes the day held, before any were dropped or simplified away. */
  fixes: number;
}

/** A fix claiming worse than this is not drawn. */
export const TRAIL_MAX_ACCURACY_METERS = 100;
/** Faster than this between two fixes (~250 km/h) is a bad fix, not a drive. */
export const TRAIL_MAX_SPEED_MS = 70;
/** Silence this long ... */
export const TRAIL_GAP_MS = 10 * 60_000;
/** ... across this much ground breaks the line. */
export const TRAIL_GAP_METERS = 500;
/** Points closer than this to the line through their neighbours are left out. */
export const TRAIL_SIMPLIFY_METERS = 5;

/**
 * Within this of where they have been standing is still standing there.
 *
 * The day timeline's own "here" (`ARRIVAL_RADIUS_M`), for its reason: a phone
 * indoors wanders tens of metres either way while its owner stands in a
 * kitchen. Drawn fix by fix, that wander was a scribble across the property and
 * the street in front of it (the office, 2026-10-02: "fix this extra drawing of
 * the lines it makes the map messy").
 */
export const TRAIL_STAY_RADIUS_METERS = ARRIVAL_RADIUS_M;

/**
 * This long inside that radius is a stay, drawn as one point.
 *
 * Two minutes: past a red light, short of any visit. A shorter wait keeps its
 * fixes, which outdoors on a road barely move anyway.
 */
export const TRAIL_STAY_MIN_MS = 2 * 60_000;

export function trailSegments(fixes: readonly TrailFix[]): TrailSegment[] {
  const usable = fixes
    .filter(
      (fix) =>
        Number.isFinite(fix.latitude) &&
        Number.isFinite(fix.longitude) &&
        !(fix.latitude === 0 && fix.longitude === 0) &&
        (fix.accuracyMeters === null || fix.accuracyMeters === undefined || fix.accuracyMeters <= TRAIL_MAX_ACCURACY_METERS) &&
        Number.isFinite(Date.parse(fix.recordedAt)),
    )
    .sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt));

  const runs: TrailFix[][] = [];
  let run: TrailFix[] = [];
  for (const fix of usable) {
    const last = run[run.length - 1];
    if (!last) {
      run.push(fix);
      continue;
    }
    const elapsedMs = Date.parse(fix.recordedAt) - Date.parse(last.recordedAt);
    if (elapsedMs <= 0) continue;
    const meters = haversineMeters(last, fix);
    if (meters / (elapsedMs / 1000) > TRAIL_MAX_SPEED_MS) continue;
    if (elapsedMs > TRAIL_GAP_MS && meters > TRAIL_GAP_METERS) {
      runs.push(run);
      run = [fix];
      continue;
    }
    run.push(fix);
  }
  if (run.length) runs.push(run);

  return runs
    .filter((stretch) => stretch.length > 1)
    .map((stretch) => ({
      // The times are the stretch's own, whatever it collapses to: a stay at
      // the end still ended when its last fix was taken.
      startedAt: stretch[0]!.recordedAt,
      endedAt: stretch[stretch.length - 1]!.recordedAt,
      points: simplifyPath(
        collapseStays(dropSpikes(stretch)).map((fix) => [fix.latitude, fix.longitude] as [number, number]),
        TRAIL_SIMPLIFY_METERS,
      ),
    }))
    // A stretch that was one long stay is one point, and a point is not a line.
    .filter((segment) => segment.points.length > 1);
}

/**
 * A fix thrown out of place and straight back: far from the fixes either side
 * of it while they are close to each other. Indoors a phone does this every
 * few minutes; nobody walks across the street and back in fifteen seconds.
 * The ends of a stretch are kept -- with only one neighbour there is nothing
 * to say it came back.
 */
function dropSpikes(stretch: readonly TrailFix[]): TrailFix[] {
  return stretch.filter((fix, index) => {
    const before = stretch[index - 1];
    const after = stretch[index + 1];
    if (!before || !after) return true;
    return !(
      haversineMeters(before, fix) > TRAIL_STAY_RADIUS_METERS &&
      haversineMeters(fix, after) > TRAIL_STAY_RADIUS_METERS &&
      haversineMeters(before, after) <= TRAIL_STAY_RADIUS_METERS
    );
  });
}

/**
 * Every stay drawn as the one point it was.
 *
 * Fixes join a cluster while they stay within `TRAIL_STAY_RADIUS_METERS` of its
 * centre; one or two thrown further, and then back, are skipped rather than
 * ending it. A cluster that lasted `TRAIL_STAY_MIN_MS` becomes a single point
 * at its median -- the median, so the throws that did get in do not drag it --
 * and the line arrives at it and leaves from it. Anything shorter is kept fix
 * by fix: on the road, a cluster is one fix and nothing changes.
 */
function collapseStays(stretch: readonly TrailFix[]): TrailFix[] {
  const kept: TrailFix[] = [];
  let index = 0;
  while (index < stretch.length) {
    const cluster: TrailFix[] = [stretch[index]!];
    let centre = { latitude: stretch[index]!.latitude, longitude: stretch[index]!.longitude };
    let next = index + 1;
    while (next < stretch.length) {
      const fix = stretch[next]!;
      if (haversineMeters(centre, fix) <= TRAIL_STAY_RADIUS_METERS) {
        cluster.push(fix);
        centre = {
          latitude: centre.latitude + (fix.latitude - centre.latitude) / cluster.length,
          longitude: centre.longitude + (fix.longitude - centre.longitude) / cluster.length,
        };
        next += 1;
        continue;
      }
      // Out of the radius. Somebody already settled there who is back within
      // a fix or two never left: those were throws, not a walk.
      const returns =
        cluster.length >= 3
          ? [1, 2].find((ahead) => {
              const later = stretch[next + ahead];
              return later !== undefined && haversineMeters(centre, later) <= TRAIL_STAY_RADIUS_METERS;
            })
          : undefined;
      if (returns === undefined) break;
      next += returns;
    }

    const lastedMs =
      Date.parse(cluster[cluster.length - 1]!.recordedAt) - Date.parse(cluster[0]!.recordedAt);
    if (cluster.length > 1 && lastedMs >= TRAIL_STAY_MIN_MS) kept.push(stayPoint(cluster));
    else kept.push(...cluster);
    index = next;
  }
  return kept;
}

/** Where a stay was: the median of its fixes, timed at its start. */
function stayPoint(cluster: readonly TrailFix[]): TrailFix {
  const median = (values: number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  };
  return {
    latitude: median(cluster.map((fix) => fix.latitude)),
    longitude: median(cluster.map((fix) => fix.longitude)),
    recordedAt: cluster[0]!.recordedAt,
  };
}

/**
 * Douglas-Peucker, in metres.
 *
 * A day is several hundred fixes per technician, most of them along straight
 * roads; keeping only the bends draws the same line from a tenth of the points.
 * Measured on a local flat projection, which over the few kilometres between
 * two kept points is exact enough for a five-metre tolerance.
 */
export function simplifyPath(path: readonly [number, number][], toleranceMeters: number): [number, number][] {
  if (path.length <= 2) return [...path];
  const keep = new Array<boolean>(path.length).fill(false);
  keep[0] = true;
  keep[path.length - 1] = true;
  const stack: [number, number][] = [[0, path.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let farthest = -1;
    let farthestMeters = toleranceMeters;
    for (let index = first + 1; index < last; index += 1) {
      const meters = metersFromSegment(path[index]!, path[first]!, path[last]!);
      if (meters > farthestMeters) {
        farthest = index;
        farthestMeters = meters;
      }
    }
    if (farthest === -1) continue;
    keep[farthest] = true;
    stack.push([first, farthest], [farthest, last]);
  }
  return path.filter((_, index) => keep[index]);
}

/** Metres from `point` to the segment `from`-`to`, on a flat projection around `from`. */
function metersFromSegment(point: [number, number], from: [number, number], to: [number, number]): number {
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLng = 111_320 * Math.cos((from[0] * Math.PI) / 180);
  const x = (point[1] - from[1]) * metersPerDegreeLng;
  const y = (point[0] - from[0]) * metersPerDegreeLat;
  const dx = (to[1] - from[1]) * metersPerDegreeLng;
  const dy = (to[0] - from[0]) * metersPerDegreeLat;
  const lengthSquared = dx * dx + dy * dy;
  const along = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (x * dx + y * dy) / lengthSquared));
  return Math.hypot(x - along * dx, y - along * dy);
}

/**
 * The trail, carried on to where they are now.
 *
 * The trail is fetched every minute and the live position arrives over the
 * socket every few seconds, so without this the line stops short of the marker
 * by whatever was driven since. Joined by the same rules that build a trail: a
 * vague fix, an impossible jump, or a long silence a long way off joins
 * nothing, and the map shows the gap rather than a straight line across it.
 * Handed back unchanged, same array, whenever nothing is added.
 */
export function withLivePosition(
  segments: readonly TrailSegment[],
  position: Pick<TrailFix, 'latitude' | 'longitude' | 'recordedAt' | 'accuracyMeters'> | null | undefined,
): readonly TrailSegment[] {
  const last = segments[segments.length - 1];
  const end = last?.points[last.points.length - 1];
  if (!last || !end || !position) return segments;
  if (position.accuracyMeters != null && position.accuracyMeters > TRAIL_MAX_ACCURACY_METERS) return segments;
  const elapsedMs = Date.parse(position.recordedAt) - Date.parse(last.endedAt);
  if (!(elapsedMs > 0)) return segments;
  const meters = haversineMeters({ latitude: end[0], longitude: end[1] }, position);
  if (meters / (elapsedMs / 1000) > TRAIL_MAX_SPEED_MS) return segments;
  // Still where the line ends: a stay is one point, and drawing out to each
  // live fix inside it would be the scribble the stay was collapsed to avoid.
  if (meters <= TRAIL_STAY_RADIUS_METERS) return segments;
  if (elapsedMs > TRAIL_GAP_MS && meters > TRAIL_GAP_METERS) return segments;
  return [
    ...segments.slice(0, -1),
    {
      ...last,
      endedAt: position.recordedAt,
      points: [...last.points, [position.latitude, position.longitude]],
    },
  ];
}

/** Total length of a trail, in metres -- what the day was driven, once the map has it. */
export function trailMeters(segments: readonly TrailSegment[]): number {
  let total = 0;
  for (const segment of segments)
    for (let index = 1; index < segment.points.length; index += 1) {
      const [lat1, lng1] = segment.points[index - 1]!;
      const [lat2, lng2] = segment.points[index]!;
      total += haversineMeters({ latitude: lat1, longitude: lng1 }, { latitude: lat2, longitude: lng2 });
    }
  return total;
}
