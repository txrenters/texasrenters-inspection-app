import { describe, expect, it } from 'vitest';

import { circleFeature, circleRing, featureCollection, lineFeature } from './map-geometry';

/**
 * Shapes drawn in real coordinates rather than pixels.
 *
 * Mapbox's own circle layer takes a radius in pixels, which would draw a
 * 40-metre geofence and a 5-kilometre group the same size and shrink both to a
 * dot when somebody zooms out. Everything here exists so a circle stays the
 * size of the ground it covers, which on a map about distances is the point.
 */

const HOUSTON = { latitude: 29.76, longitude: -95.37 };
const EARTH_RADIUS_M = 6_371_000;

/** The same haversine the rest of the console measures with. */
function metres(a: [number, number], centre: { latitude: number; longitude: number }) {
  const [longitude, latitude] = a;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(latitude - centre.latitude);
  const dLon = toRad(longitude - centre.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(centre.latitude)) * Math.cos(toRad(latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

describe('a circle on the ground', () => {
  it('is the radius it was asked for, all the way round', () => {
    const ring = circleRing(HOUSTON.latitude, HOUSTON.longitude, 500);
    const distances = ring.map((point) => metres(point, HOUSTON));

    for (const distance of distances) expect(distance).toBeGreaterThan(495);
    for (const distance of distances) expect(distance).toBeLessThan(505);
  });

  /**
   * Without the latitude correction this draws about 15% narrow east-west at
   * Houston's latitude — an egg on its side, and wrong about distance in the
   * direction most of this portfolio is spread.
   */
  it('is round rather than an egg this far north', () => {
    const ring = circleRing(HOUSTON.latitude, HOUSTON.longitude, 5_000);
    const distances = ring.map((point) => metres(point, HOUSTON));

    expect(Math.max(...distances) / Math.min(...distances)).toBeLessThan(1.02);
  });

  it('closes, so the polygon is valid', () => {
    const ring = circleRing(HOUSTON.latitude, HOUSTON.longitude, 40);

    expect(ring[0]).toEqual(ring.at(-1));
  });

  it('keeps whatever the layer paints from', () => {
    const feature = circleFeature(HOUSTON.latitude, HOUSTON.longitude, 40, { kind: 'enter' });

    expect(feature.properties).toEqual({ kind: 'enter' });
    expect(feature.geometry.type).toBe('Polygon');
  });
});

describe('a line', () => {
  /**
   * Every route, track and great-circle path in this console is
   * `[latitude, longitude]`; GeoJSON is the other way round. Swapping here
   * rather than at each call site leaves one place to get it wrong.
   */
  it('turns the console’s lat,lng into GeoJSON’s lng,lat', () => {
    const feature = lineFeature([
      [29.76, -95.37],
      [29.78, -95.41],
    ]);

    expect(feature.geometry.coordinates).toEqual([
      [-95.37, 29.76],
      [-95.41, 29.78],
    ]);
  });

  it('carries its own properties, so one source can paint several lines', () => {
    expect(lineFeature([[29.76, -95.37]], { leg: 'done' }).properties).toEqual({ leg: 'done' });
  });
});

describe('a collection', () => {
  it('is what a source wants even for one shape', () => {
    const collection = featureCollection([circleFeature(HOUSTON.latitude, HOUSTON.longitude, 40)]);

    expect(collection.type).toBe('FeatureCollection');
    expect(collection.features).toHaveLength(1);
  });

  it('is happy empty, because a map with nothing on it still draws', () => {
    expect(featureCollection([]).features).toEqual([]);
  });
});
