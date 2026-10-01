import { haversineMeters } from './route-plan.js';

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
      startedAt: stretch[0]!.recordedAt,
      endedAt: stretch[stretch.length - 1]!.recordedAt,
      points: simplifyPath(stretch.map((fix) => [fix.latitude, fix.longitude] as [number, number]), TRAIL_SIMPLIFY_METERS),
    }));
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
