/**
 * Shapes on a map, in real coordinates.
 *
 * Google drew a circle from a centre and a radius in metres and got the
 * projection right itself. Mapbox's own circle layer takes a radius in
 * **pixels**, which is a different thing entirely: a 40-metre geofence and a
 * 5-kilometre group would draw the same size, and both would shrink to a dot
 * as somebody zoomed out. Every circle here is therefore a polygon in
 * longitude and latitude, so it stays the size of the ground it covers.
 */

const EARTH_RADIUS_M = 6_371_000;

/**
 * A circle as a ring of `[longitude, latitude]`, for GeoJSON.
 *
 * Longitude degrees are shorter the further from the equator, so the radius is
 * divided by the cosine of the latitude — without that a circle over Houston
 * draws about 15% narrow, as an egg lying on its side.
 *
 * Sixty-four points is smooth at every zoom the console offers and cheap
 * enough to build for several hundred properties on every frame of a pan.
 */
export function circleRing(
  latitude: number,
  longitude: number,
  radiusMeters: number,
  points = 64,
): [number, number][] {
  const latRadius = (radiusMeters / EARTH_RADIUS_M) * (180 / Math.PI);
  const lonRadius = latRadius / Math.cos((latitude * Math.PI) / 180);
  return Array.from({ length: points + 1 }, (_, index) => {
    const angle = (index / points) * 2 * Math.PI;
    return [longitude + lonRadius * Math.cos(angle), latitude + latRadius * Math.sin(angle)] as [
      number,
      number,
    ];
  });
}

/** One circle as a GeoJSON polygon feature, with whatever the layer paints from. */
export function circleFeature(
  latitude: number,
  longitude: number,
  radiusMeters: number,
  properties: Record<string, string | number | boolean> = {},
) {
  return {
    type: 'Feature' as const,
    properties,
    geometry: { type: 'Polygon' as const, coordinates: [circleRing(latitude, longitude, radiusMeters)] },
  };
}

/**
 * One point as a GeoJSON feature, at exactly the coordinates given.
 *
 * For the things that must be drawn where they actually are, however far out
 * the map is zoomed — which a marker cannot promise, because markers are real
 * elements and hundreds of them stutter, so they get grouped.
 */
export function pointFeature(
  latitude: number,
  longitude: number,
  properties: Record<string, string | number | boolean> = {},
) {
  return {
    type: 'Feature' as const,
    properties,
    geometry: { type: 'Point' as const, coordinates: [longitude, latitude] as [number, number] },
  };
}

/**
 * Every coordinate in a feature is a real number.
 *
 * A property with no latitude, or a radius that arrived as null, makes a ring
 * of `NaN`s -- and Mapbox rejects the *whole source*, so one unplaced row takes
 * out every circle on the map rather than just its own. JSON has no `NaN`
 * either, so the shape could not survive being serialised in any case.
 */
function drawable(feature: unknown): boolean {
  const coordinates = (feature as { geometry?: { coordinates?: unknown } } | null)?.geometry
    ?.coordinates;
  const finite = (value: unknown): boolean =>
    Array.isArray(value) ? value.every(finite) : typeof value === 'number' && Number.isFinite(value);
  return finite(coordinates);
}

/**
 * A collection, which is what a Mapbox source wants even for one shape.
 *
 * Anything undrawable is left out rather than passed on. A missing circle is a
 * missing circle; a rejected source is a blank map.
 */
export function featureCollection<T>(features: readonly T[]) {
  return { type: 'FeatureCollection' as const, features: features.filter(drawable) };
}

/**
 * A line as a GeoJSON feature, from the `[latitude, longitude]` pairs this
 * codebase passes routes around as.
 *
 * The order swaps here rather than at every call site: every route, track and
 * great-circle path in the console is `[lat, lng]`, and GeoJSON is the other
 * way round. One place to get it wrong is better than fifteen.
 */
export function lineFeature(
  path: readonly (readonly [number, number])[],
  properties: Record<string, string | number | boolean> = {},
) {
  return {
    type: 'Feature' as const,
    properties,
    geometry: {
      type: 'LineString' as const,
      coordinates: path.map(([latitude, longitude]) => [longitude, latitude] as [number, number]),
    },
  };
}
