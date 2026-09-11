/**
 * Grouping property pins that land on top of each other.
 *
 * Nine properties drew as six marks because three of them sit within 250m in
 * the same Houston postcode — at metropolitan zoom that is a single pixel, so
 * the map quietly under-reported the work while the legend said nine.
 *
 * Written here rather than pulled in: `react-leaflet-cluster` targets
 * react-leaflet v4 and this console is on v5 with React 19. Clustering a
 * handful of points is a grid and a count, and that is cheaper than a
 * dependency whose compatibility nobody can promise.
 *
 * Provider-agnostic. This took a Leaflet map and called `map.project`, which
 * is plain Web Mercator — the test always stubbed it with four lines of
 * arithmetic, which is the tell. Doing the projection here rather than
 * borrowing it means the grouping rule does not change when the map underneath
 * it does.
 */

/**
 * Where a coordinate lands in the world pixel plane at a given zoom.
 *
 * The Web Mercator projection every slippy map shares: the world is 256px at
 * zoom 0 and doubles each level, longitude is linear, and latitude goes through
 * the Gudermannian so that a rhumb line stays straight.
 *
 * Latitude is clamped to the Mercator limit. Beyond ±85.0511° the projection
 * runs to infinity, and a point at either pole would otherwise produce a cell
 * index no other point could share — one pin per cluster, silently.
 */
export function projectToPixels(latitude: number, longitude: number, zoom: number) {
  const scale = 256 * 2 ** zoom;
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const radians = (clamped * Math.PI) / 180;
  return {
    x: ((longitude + 180) / 360) * scale,
    y: ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * scale,
  };
}

/**
 * How close two pins must be, in screen pixels, before they merge.
 *
 * Sized to the marker rather than the map: a property pin is 24px wide, so
 * anything nearer than roughly two markers is overlapping enough to be
 * unreadable. Larger values start hiding genuinely separate streets.
 */
export const CLUSTER_GRID_PX = 56;

/**
 * Past this zoom, nothing is grouped.
 *
 * Grouping exists so that pins at city scale do not pile into an unreadable
 * smear. Once somebody has zoomed to a single street it has stopped helping and
 * started hiding: a cul-de-sac of houses within thirty metres of each other
 * grouped into a badge reading "3" that no amount of zooming would open,
 * because the grid is a fixed number of *pixels* and those houses are closer
 * than the grid however far in you go.
 *
 * Above this, every property is its own marker. Two pins may overlap slightly.
 * That is a far smaller problem than a property you cannot reach at all.
 */
export const CLUSTER_MAX_ZOOM = 19;

export interface Clusterable {
  id: string;
  latitude: number;
  longitude: number;
}

export interface Cluster<T extends Clusterable> {
  /** Stable across renders at a given zoom, so React does not rebuild markers. */
  key: string;
  latitude: number;
  longitude: number;
  members: T[];
}

/**
 * Bucket points into a fixed pixel grid at the given zoom.
 *
 * Deliberately keyed on projected position and NOT on the viewport, so panning
 * cannot change which points are grouped. A viewport-dependent clustering
 * reshuffles its badges as you drag, which looks like the data changing.
 *
 * The centre of a cluster is the mean of its members, so the badge sits among
 * the pins it represents rather than in the corner of an arbitrary grid cell.
 */
/**
 * The closest zoom-out at which a point still stands on its own.
 *
 * Selecting a property from the list used to fly to a fixed zoom and stop
 * there. Two houses on the same street stayed folded into a badge reading "2",
 * so the thing that had just been chosen was not on the map -- and the only way
 * to see it was to zoom in by hand, which is the work the list was supposed to
 * save.
 *
 * The clustering is asked directly rather than derived from a distance. Grid
 * membership is not a function of separation alone: two points a pixel apart
 * land in different cells when they straddle a boundary, and two points nearly
 * a full cell apart share one when they do not. Only the real grouping knows.
 *
 * Returns `max` when no zoom separates them, which happens when two records
 * carry the same coordinates -- two units at one address, say. That is not a
 * zoom problem and no amount of zooming solves it, so the caller shows the
 * group instead.
 */
export function zoomToIsolate<T extends Clusterable>(
  items: readonly T[],
  id: string,
  from: number,
  max: number,
  gridPx: number = CLUSTER_GRID_PX,
): number {
  for (let zoom = Math.min(from, max); zoom <= max; zoom += 1) {
    const own = clusterByGrid(items, zoom, gridPx).find((cluster) =>
      cluster.members.some((member) => member.id === id),
    );
    if (own && own.members.length === 1) return zoom;
  }

  return max;
}

export function clusterByGrid<T extends Clusterable>(
  points: readonly T[],
  zoom: number,
  gridPx: number = CLUSTER_GRID_PX,
): Cluster<T>[] {
  // Above the ceiling every point stands alone, so a property is always
  // reachable by zooming. Below it, the pixel grid does the grouping.
  if (zoom > CLUSTER_MAX_ZOOM)
    return points.map((point) => ({
      key: point.id,
      latitude: point.latitude,
      longitude: point.longitude,
      members: [point],
    }));

  const cells = new Map<string, T[]>();

  for (const point of points) {
    const projected = projectToPixels(point.latitude, point.longitude, zoom);
    const cell = `${Math.floor(projected.x / gridPx)}:${Math.floor(projected.y / gridPx)}`;
    const existing = cells.get(cell);
    if (existing) existing.push(point);
    else cells.set(cell, [point]);
  }

  return [...cells.entries()].map(([cell, members]) => {
    const latitude = members.reduce((sum, member) => sum + member.latitude, 0) / members.length;
    const longitude = members.reduce((sum, member) => sum + member.longitude, 0) / members.length;
    return {
      // The cell, plus the members, so a cluster that gains or loses a point is
      // a different React element rather than a mutated one.
      key: `${cell}:${members.map((member) => member.id).join(',')}`,
      latitude,
      longitude,
      members,
    };
  });
}
