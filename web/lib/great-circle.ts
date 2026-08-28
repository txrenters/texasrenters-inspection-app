/**
 * The shortest path over the Earth, drawn on a flat map.
 *
 * A `Polyline` between two distant points is a straight line in *projected*
 * space, which is not the shortest path over a sphere and is not the way anyone
 * would travel. Manila to Houston is the case that makes it obvious: the real
 * path crosses the Pacific, while a naive polyline runs west across Asia,
 * Europe and the Atlantic — longer, and pointing the wrong way out of the city.
 *
 * So the path is interpolated along the great circle and then cut where it
 * crosses the antimeridian, because the map is one world wide with `noWrap`,
 * and a segment running from +179° to −179° is drawn as a line straight back
 * across the entire map instead of off the edge.
 */

type Point = { latitude: number; longitude: number };

/** Enough to look like a curve at any zoom, cheap enough to recompute freely. */
const SEGMENTS = 128;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

/**
 * Points along the great circle between two coordinates.
 *
 * Spherical linear interpolation on the unit vectors. The degenerate case —
 * both points identical, so the angle between them is zero — falls back to the
 * endpoints rather than dividing by `sin(0)`.
 */
function interpolate(from: Point, to: Point, segments: number): Point[] {
  const lat1 = toRadians(from.latitude);
  const lon1 = toRadians(from.longitude);
  const lat2 = toRadians(to.latitude);
  const lon2 = toRadians(to.longitude);

  const delta =
    2 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin((lat2 - lat1) / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
        ),
      ),
    );

  if (!Number.isFinite(delta) || delta === 0) return [from, to];

  const points: Point[] = [];
  for (let step = 0; step <= segments; step += 1) {
    const fraction = step / segments;
    const a = Math.sin((1 - fraction) * delta) / Math.sin(delta);
    const b = Math.sin(fraction * delta) / Math.sin(delta);

    const x = a * Math.cos(lat1) * Math.cos(lon1) + b * Math.cos(lat2) * Math.cos(lon2);
    const y = a * Math.cos(lat1) * Math.sin(lon1) + b * Math.cos(lat2) * Math.sin(lon2);
    const z = a * Math.sin(lat1) + b * Math.sin(lat2);

    points.push({
      latitude: toDegrees(Math.atan2(z, Math.sqrt(x * x + y * y))),
      longitude: toDegrees(Math.atan2(y, x)),
    });
  }

  return points;
}

/**
 * The great circle as one or more `[lat, lng]` runs a map can draw.
 *
 * More than one only when the path crosses the antimeridian: each side is
 * returned separately so neither is drawn racing back across the map. Callers
 * render every run with the same style; together they read as one line.
 */
export function greatCirclePath(
  from: Point,
  to: Point,
  segments: number = SEGMENTS,
): [number, number][][] {
  const points = interpolate(from, to, segments);

  const runs: [number, number][][] = [];
  let current: [number, number][] = [];

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index] as Point;
    const previous = points[index - 1];

    // A jump of more than half the world between adjacent samples can only be
    // the seam: real steps are a fraction of a degree at this resolution.
    if (previous && Math.abs(point.longitude - previous.longitude) > 180) {
      runs.push(current);
      current = [];
    }

    current.push([point.latitude, point.longitude]);
  }

  if (current.length) runs.push(current);
  return runs.filter((run) => run.length > 1);
}

/**
 * Where to put a marker on the path.
 *
 * The middle of the longest run rather than the true midpoint of the journey:
 * when the line is split at the seam the true midpoint can land in the gap, and
 * a marker in open ocean at the edge of the map explains nothing.
 */
export function pathMidpoint(runs: [number, number][][]): [number, number] | null {
  const longest = runs.reduce<[number, number][] | null>(
    (best, run) => (!best || run.length > best.length ? run : best),
    null,
  );
  if (!longest?.length) return null;
  return longest[Math.floor(longest.length / 2)] ?? null;
}
