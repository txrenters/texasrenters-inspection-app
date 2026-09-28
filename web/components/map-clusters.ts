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
 * How many metres one screen pixel covers, here.
 *
 * The same Web Mercator scale `projectToPixels` uses, read the other way
 * round. "Here" is the point of it: Mercator stretches east-west with
 * latitude, so a pixel is a different distance in Houston than at the equator,
 * and a ring drawn from a fixed pixel size would be the wrong size on the
 * ground. Earth's equatorial circumference over the world's width in pixels.
 */
export function metersPerPixel(latitude: number, zoom: number) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  return (40_075_016.686 * Math.cos((clamped * Math.PI) / 180)) / (256 * 2 ** zoom);
}

/**
 * Below this many pixels across, a geofence ring is not worth drawing.
 *
 * A 40m circle at metropolitan zoom is under a pixel wide, so hundreds of them
 * would cost a real overlay each and say nothing — the pin is already there
 * and already says where the property is. Roughly a marker's width, which is
 * about where a circle stops being a smudge and starts being a size somebody
 * can compare against the building under it.
 */
export const RING_MIN_DIAMETER_PX = 24;

/**
 * Whether this radius is large enough on screen to mean anything.
 *
 * Asked about the radius rather than the zoom so that a 6m geofence and a 100m
 * one each appear at the zoom where they become legible, instead of both
 * turning on at one number picked for the default.
 */
export function ringIsLegible(radiusMeters: number, latitude: number, zoom: number) {
  return (radiusMeters * 2) / metersPerPixel(latitude, zoom) >= RING_MIN_DIAMETER_PX;
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
    /**
     * A badge stands on one of its own properties, not in the middle of them.
     *
     * It used to be the mean of the members' coordinates, and the office
     * reported the consequence exactly: "every time I zoom in and zoom out the
     * markers reposition, it doesn't stay on the exact address". Both halves
     * were true. The grid is in screen pixels, so zooming regroups the members;
     * a different set of members is a different average; and the average of
     * several addresses is in general **no address at all** -- a spot in a
     * field, a junction, the middle of a bayou.
     *
     * On satellite imagery, where the office reads rooftops, that is plainly
     * wrong. So the badge takes the coordinates of whichever member sits
     * nearest that average: it lands where the group is, but it lands *on a
     * building*, and a marker never claims a place nothing stands.
     *
     * Longitude is scaled by the cosine of the latitude before comparing, so
     * "nearest" means nearest on the ground. Without it a degree of longitude
     * would count for as much as a degree of latitude, which at Houston it is
     * not -- it is about 0.87 of one -- and a group spread east-west would pick
     * the wrong member to stand on.
     */
    const meanLatitude = members.reduce((sum, member) => sum + member.latitude, 0) / members.length;
    const meanLongitude =
      members.reduce((sum, member) => sum + member.longitude, 0) / members.length;
    const eastWest = Math.cos((meanLatitude * Math.PI) / 180);
    const fromMean = (member: T) =>
      (member.latitude - meanLatitude) ** 2 +
      ((member.longitude - meanLongitude) * eastWest) ** 2;
    const anchor = members.reduce(
      (nearest, member) => (fromMean(member) < fromMean(nearest) ? member : nearest),
      members[0]!,
    );
    const { latitude, longitude } = anchor;
    const only = members.length === 1 ? members[0] : undefined;
    return {
      // A property on its own is keyed by itself, so it keeps its marker from
      // one zoom level to the next. Keyed by its grid cell -- which changes
      // with every zoom -- every lone property was thrown away and drawn again
      // each time the map settled, hundreds of markers at street level, and
      // that was the stutter when zooming in and out.
      //
      // A group is keyed by its cell and its members, so one that gains or
      // loses a property is a different React element rather than a mutated
      // one still showing the old count.
      key: only ? only.id : `${cell}:${members.map((member) => member.id).join(',')}`,
      latitude,
      longitude,
      members,
    };
  });
}

/** A lat/lng rectangle: the part of the world a map is showing. */
export interface Box {
  north: number;
  south: number;
  east: number;
  west: number;
}

/**
 * The box grown by a share of its own size on every side, and clamped to the
 * world.
 *
 * Markers just outside the edge are drawn too, so a small pan does not reveal
 * an empty strip that fills in only once the map settles.
 */
export function padBox(box: Box, share: number): Box {
  const latPad = (box.north - box.south) * share;
  const crossesDateLine = box.west > box.east;
  const width = crossesDateLine ? 360 - (box.west - box.east) : box.east - box.west;
  const lngPad = width * share;
  if (crossesDateLine || width + 2 * lngPad >= 360)
    return {
      north: Math.min(90, box.north + latPad),
      south: Math.max(-90, box.south - latPad),
      east: 180,
      west: -180,
    };
  return {
    north: Math.min(90, box.north + latPad),
    south: Math.max(-90, box.south - latPad),
    east: Math.min(180, box.east + lngPad),
    west: Math.max(-180, box.west - lngPad),
  };
}

/** Whether a point is inside the box, including one that spans the date line. */
export function inBox(point: { latitude: number; longitude: number }, box: Box) {
  if (point.latitude > box.north || point.latitude < box.south) return false;
  return box.west <= box.east
    ? point.longitude >= box.west && point.longitude <= box.east
    : point.longitude >= box.west || point.longitude <= box.east;
}
