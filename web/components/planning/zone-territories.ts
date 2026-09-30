/**
 * The zones as areas on the map: each zone's territory, fenced.
 *
 * A zone is not a place anyone drew. It is a number on each tenancy in
 * Propertyware -- the week of the crew's rotation that tenancy falls in -- and
 * nothing in the system says where one ends and the next begins. So the fence
 * is drawn from the properties: every spot within `reachMeters` of a property
 * belongs to the zone of the property nearest it. The zones never overlap, a
 * fence runs midway between neighbouring properties of two zones, and where
 * the zones interleave -- they do, around central Houston -- the map shows it
 * as islands rather than pretending otherwise.
 *
 * A convex hull per zone was the obvious drawing and the wrong one: on the
 * office's file, zone 2's hull held 43 of zone 1's properties.
 *
 * Worked on a grid of `cellMeters` squares. The fill is the grid's own
 * squares, merged into runs; the fence is traced between them by marching
 * squares, so it runs at 45 degrees where it turns rather than in steps, and
 * every fence is a closed ring with its own zone on its right.
 */

import { zoneNumberOf } from '@texasrenters/shared';

export interface ZonePoint {
  latitude: number;
  longitude: number;
  /** As the file writes it: "1", "Zone 3", "Not Set". */
  zone: string | null;
}

export interface ZoneTerritory {
  /** The zone's number, "1". */
  zone: string;
  color: string;
  /** Properties in the zone. */
  count: number;
  /** The territory as rectangles, `[longitude, latitude]` rings. */
  fill: [number, number][][];
  /** The fence: closed rings, the zone always on the right of the direction they run. */
  fence: [number, number][][];
  /** Where "Zone N" stands: the zone's property nearest the middle of its properties. */
  labelAt: { latitude: number; longitude: number };
}

/**
 * One colour per zone, none of them the ungrouped green or the road
 * purple-blue, and all far from each other. Past five they go round again.
 */
const ZONE_COLORS: Record<string, string> = {
  '1': '#0284c7',
  '2': '#ea580c',
  '3': '#db2777',
  '4': '#a16207',
  '5': '#475569',
};
const MORE_COLORS = ['#0e7490', '#b91c1c', '#7c2d12', '#be185d', '#1e40af'];

export function zoneColor(zone: string): string {
  return ZONE_COLORS[zone] ?? MORE_COLORS[(Number(zone) || 0) % MORE_COLORS.length]!;
}

/** Most squares worked on at once. The office's portfolio at 250m is well inside it. */
const MAX_CELLS = 600_000;

const METRES_PER_DEGREE = 111_320;

export function zoneTerritories(
  points: readonly ZonePoint[],
  { cellMeters = 250, reachMeters = 3000 }: { cellMeters?: number; reachMeters?: number } = {},
): ZoneTerritory[] {
  const placed = points.flatMap((point) => {
    const zone = zoneNumberOf(point.zone);
    return zone && Number.isFinite(point.latitude) && Number.isFinite(point.longitude) ? [{ ...point, zone }] : [];
  });
  if (!placed.length) return [];

  const zones = [...new Set(placed.map((point) => point.zone))].sort((left, right) => Number(left) - Number(right));
  const indexOf = new Map(zones.map((zone, index) => [zone, index]));

  // Flat metres from the middle of the portfolio: at this size the earth's curve is nothing.
  const middleLatitude = placed.reduce((sum, point) => sum + point.latitude, 0) / placed.length;
  const perLongitude = METRES_PER_DEGREE * Math.cos((middleLatitude * Math.PI) / 180);
  const xs = placed.map((point) => point.longitude * perLongitude);
  const ys = placed.map((point) => point.latitude * METRES_PER_DEGREE);

  // The grid reaches a cell past the reach on every side, so no territory touches its edge.
  const margin = reachMeters + 2 * cellMeters;
  let cell = cellMeters;
  const west = Math.min(...xs) - margin;
  const south = Math.min(...ys) - margin;
  const width = Math.max(...xs) + margin - west;
  const height = Math.max(...ys) + margin - south;
  while ((width / cell) * (height / cell) > MAX_CELLS) cell *= 1.25;
  const columns = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);

  // Properties by bucket of the reach's size: the nearest one is in this bucket or the eight around it.
  // Numbers rather than strings for keys: this is looked up nine times for each of some 200,000 squares.
  const buckets = new Map<number, number[]>();
  const bucketKey = (bucketX: number, bucketY: number) => bucketX * 1_000_000 + bucketY;
  const bucketOf = (x: number, y: number) => bucketKey(Math.floor(x / reachMeters), Math.floor(y / reachMeters));
  placed.forEach((_, index) => {
    const key = bucketOf(xs[index]!, ys[index]!);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(index);
    else buckets.set(key, [index]);
  });

  /** Each square's zone, by index; -1 for no zone. */
  const label = new Int16Array(columns * rows).fill(-1);
  const reachSquared = reachMeters * reachMeters;
  for (let row = 0; row < rows; row += 1) {
    const y = south + (row + 0.5) * cell;
    const bucketY = Math.floor(y / reachMeters);
    for (let column = 0; column < columns; column += 1) {
      const x = west + (column + 0.5) * cell;
      const bucketX = Math.floor(x / reachMeters);
      let nearest = -1;
      let nearestSquared = reachSquared;
      for (let dx = -1; dx <= 1; dx += 1)
        for (let dy = -1; dy <= 1; dy += 1)
          for (const index of buckets.get(bucketKey(bucketX + dx, bucketY + dy)) ?? []) {
            const squared = (xs[index]! - x) ** 2 + (ys[index]! - y) ** 2;
            if (squared <= nearestSquared) {
              nearestSquared = squared;
              nearest = index;
            }
          }
      if (nearest >= 0) label[row * columns + column] = indexOf.get(placed[nearest]!.zone)!;
    }
  }

  /** A grid position -- fractions of a square allowed -- as `[longitude, latitude]`. */
  const toLngLat = (column: number, row: number): [number, number] => [
    (west + column * cell) / perLongitude,
    (south + row * cell) / METRES_PER_DEGREE,
  ];

  return zones.map((zone, zoneIndex) => {
    // The fill: each row's runs of this zone's squares, as rectangles.
    const fill: [number, number][][] = [];
    for (let row = 0; row < rows; row += 1) {
      let start = -1;
      for (let column = 0; column <= columns; column += 1) {
        const inZone = column < columns && label[row * columns + column] === zoneIndex;
        if (inZone && start < 0) start = column;
        if (!inZone && start >= 0) {
          fill.push([
            toLngLat(start, row),
            toLngLat(column, row),
            toLngLat(column, row + 1),
            toLngLat(start, row + 1),
            toLngLat(start, row),
          ]);
          start = -1;
        }
      }
    }

    const members = placed.filter((point) => point.zone === zone);
    const middle = {
      latitude: members.reduce((sum, point) => sum + point.latitude, 0) / members.length,
      longitude: members.reduce((sum, point) => sum + point.longitude, 0) / members.length,
    };
    const labelAt = members.reduce((best, point) =>
      (point.latitude - middle.latitude) ** 2 + (point.longitude - middle.longitude) ** 2 <
      (best.latitude - middle.latitude) ** 2 + (best.longitude - middle.longitude) ** 2
        ? point
        : best,
    );

    return {
      zone,
      color: zoneColor(zone),
      count: members.length,
      fill,
      fence: traceFence(label, columns, rows, zoneIndex).map((ring) =>
        // Square centres are at +0.5: the fence runs between them.
        ring.map(([column, row]) => toLngLat(column + 0.5, row + 0.5)),
      ),
      labelAt: { latitude: labelAt.latitude, longitude: labelAt.longitude },
    };
  });
}

/**
 * The fence around one zone's squares, by marching squares over their centres.
 *
 * Each square of four centres crossing the fence gives one or two short
 * segments between the midpoints of its sides, oriented so the zone is on the
 * right. Every midpoint then has exactly one segment in and one out, so they
 * chain into closed rings. Where two diagonal corners are the zone and the
 * other two are not, the corners are kept apart rather than joined.
 *
 * Positions come back in square-centre units: `[0, 0]` is the first square's centre.
 */
export function traceFence(label: Int16Array, columns: number, rows: number, zone: number): [number, number][][] {
  const inside = (column: number, row: number) =>
    column >= 0 && row >= 0 && column < columns && row < rows && label[row * columns + column] === zone;

  // Midpoints of a square whose lower-left centre is (c, r).
  type Point = [number, number];
  const bottom = (c: number, r: number): Point => [c + 0.5, r];
  const right = (c: number, r: number): Point => [c + 1, r + 0.5];
  const top = (c: number, r: number): Point => [c + 0.5, r + 1];
  const left = (c: number, r: number): Point => [c, r + 0.5];

  const next = new Map<string, Point>();
  const key = ([x, y]: Point) => `${x},${y}`;
  const link = (from: Point, to: Point) => next.set(key(from), to);

  // From one square before the grid to one after, so a zone at the edge still closes.
  for (let r = -1; r < rows; r += 1)
    for (let c = -1; c < columns; c += 1) {
      const code =
        (inside(c, r) ? 1 : 0) | (inside(c + 1, r) ? 2 : 0) | (inside(c + 1, r + 1) ? 4 : 0) | (inside(c, r + 1) ? 8 : 0);
      const [B, R, T, L] = [bottom(c, r), right(c, r), top(c, r), left(c, r)];
      switch (code) {
        case 1: link(L, B); break;
        case 2: link(B, R); break;
        case 3: link(L, R); break;
        case 4: link(R, T); break;
        case 5: link(L, B); link(R, T); break;
        case 6: link(B, T); break;
        case 7: link(L, T); break;
        case 8: link(T, L); break;
        case 9: link(T, B); break;
        case 10: link(B, R); link(T, L); break;
        case 11: link(T, R); break;
        case 12: link(R, L); break;
        case 13: link(R, B); break;
        case 14: link(B, L); break;
        default: break;
      }
    }

  const rings: Point[][] = [];
  const seen = new Set<string>();
  for (const [startKey] of next) {
    if (seen.has(startKey)) continue;
    const [sx, sy] = startKey.split(',').map(Number) as Point;
    const ring: Point[] = [[sx, sy]];
    seen.add(startKey);
    let at = next.get(startKey);
    while (at && !seen.has(key(at))) {
      ring.push(at);
      seen.add(key(at));
      at = next.get(key(at));
    }
    ring.push([sx, sy]);
    rings.push(ring);
  }
  return rings;
}
