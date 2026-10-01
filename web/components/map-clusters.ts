/**
 * Which property markers a map draws, and where each one stands.
 *
 * This grouped pins that landed on top of each other into count badges. The
 * office chose the Group maker's markers instead (2026-10-01): every property
 * its own disc, at every zoom, and no badges. What is left here is the
 * arithmetic that keeps that affordable and readable -- draw only what is near
 * the screen, draw a geofence only once it is a size, and fan out properties
 * that share one spot so each can still be clicked.
 *
 * Provider-agnostic and pure, so it is argued with in a test rather than on a
 * map.
 */

/**
 * How many metres one screen pixel covers, here.
 *
 * The Web Mercator scale every slippy map shares: the world is 256px across at
 * zoom 0 and doubles each level. "Here" is the point of it: Mercator stretches
 * east-west with latitude, so a pixel is a different distance in Houston than
 * at the equator, and a ring drawn from a fixed pixel size would be the wrong
 * size on the ground. Earth's equatorial circumference over the world's width
 * in pixels.
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

/** The centre-to-centre gap, in pixels, between markers fanned out from one spot. A disc is 22px across. */
const FAN_GAP_PX = 24;

/**
 * Screen offsets for markers that share one spot, so each has a marker of its own.
 *
 * Three units at one address are three markers at identical coordinates, and
 * so are two properties placed only at their zip code's centre. Drawn where
 * they are, the last one covers the rest at every zoom and the others cannot be
 * clicked. Fanned out in pixels rather than moved in metres, because a move in
 * metres closes up again as the map zooms out.
 *
 * Keyed by `keyOf`. A marker alone at its spot has no entry.
 */
export function spotOffsets<T extends { latitude: number; longitude: number }, K>(
  items: readonly T[],
  keyOf: (item: T) => K,
): Map<K, [number, number]> {
  const bySpot = new Map<string, T[]>();
  for (const item of items) {
    // Five decimals is about a metre: the same spot, not merely a near one.
    const spot = `${item.latitude.toFixed(5)},${item.longitude.toFixed(5)}`;
    const here = bySpot.get(spot);
    if (here) here.push(item);
    else bySpot.set(spot, [item]);
  }

  const offsets = new Map<K, [number, number]>();
  for (const here of bySpot.values()) {
    if (here.length < 2) continue;
    // The radius at which neighbouring markers on the ring are FAN_GAP_PX apart.
    const radius = FAN_GAP_PX / (2 * Math.sin(Math.PI / here.length));
    here.forEach((item, index) => {
      // From twelve o'clock, clockwise.
      const angle = -Math.PI / 2 + (index / here.length) * 2 * Math.PI;
      offsets.set(keyOf(item), [Math.round(radius * Math.cos(angle)), Math.round(radius * Math.sin(angle))]);
    });
  }
  return offsets;
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
