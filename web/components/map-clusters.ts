import type { Map as LeafletMap } from 'leaflet';

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
 */

/**
 * How close two pins must be, in screen pixels, before they merge.
 *
 * Sized to the marker rather than the map: a property pin is 24px wide, so
 * anything nearer than roughly two markers is overlapping enough to be
 * unreadable. Larger values start hiding genuinely separate streets.
 */
export const CLUSTER_GRID_PX = 56;

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
export function clusterByGrid<T extends Clusterable>(
  map: Pick<LeafletMap, 'project'>,
  points: readonly T[],
  zoom: number,
  gridPx: number = CLUSTER_GRID_PX,
): Cluster<T>[] {
  const cells = new Map<string, T[]>();

  for (const point of points) {
    const projected = map.project([point.latitude, point.longitude], zoom);
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
