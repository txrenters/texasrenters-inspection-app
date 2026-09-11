import {
  decodePolyline,
  parseComputedRoute,
} from '../src/routing/google-routes.client';

/**
 * The line drawn on the map, and the axis trap underneath it.
 *
 * Google's polyline algorithm yields latitude first. OSRM returns GeoJSON,
 * which is `[lon, lat]`. `RouteService` hands whichever router answered to one
 * `toLatLngPath`, so the two must agree — and emitting Google's native order
 * would put every route in the Indian Ocean while both clients looked
 * individually correct. The same trap the Census geocoder set, where `x` is
 * the longitude.
 */

describe('decoding a Google polyline', () => {
  it('returns longitude first, matching what OSRM gives', () => {
    // Google's own documented example decodes to (38.5, -120.2), (40.7,
    // -120.95), (43.252, -126.453).
    const path = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');

    expect(path).toHaveLength(3);
    const [first] = path;
    // Longitude is the large negative one; latitude is the ~38. Asserting the
    // sign rather than the position is what makes this test catch a swap.
    expect(first[0]).toBeCloseTo(-120.2, 3);
    expect(first[1]).toBeCloseTo(38.5, 3);
  });

  it('decodes every point, not just the first', () => {
    const path = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(path[2][0]).toBeCloseTo(-126.453, 3);
    expect(path[2][1]).toBeCloseTo(43.252, 3);
  });

  it('survives anything that is not a polyline', () => {
    // A missing polyline is a field mask that did not ask for one, not a crash.
    expect(decodePolyline(undefined)).toEqual([]);
    expect(decodePolyline('')).toEqual([]);
    expect(decodePolyline(42)).toEqual([]);
  });
});

describe('reading a computed route', () => {
  const body = {
    routes: [
      {
        duration: '1800s',
        distanceMeters: 24000,
        polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' },
        legs: [
          { duration: '600s', distanceMeters: 8000 },
          { duration: '1200s', distanceMeters: 16000 },
        ],
      },
    ],
  };

  it('reads the whole drive and each leg', () => {
    const route = parseComputedRoute(body);

    expect(route?.durationSeconds).toBe(1800);
    expect(route?.distanceMeters).toBe(24000);
    expect(route?.legs).toEqual([
      { durationSeconds: 600, distanceMeters: 8000 },
      { durationSeconds: 1200, distanceMeters: 16000 },
    ]);
    expect(route?.geometry.length).toBeGreaterThan(0);
  });

  it('treats no route as a fact rather than a zero-length one', () => {
    /**
     * Google answers with an empty `routes` array when it cannot connect the
     * points. Returning a route of zero seconds would draw nothing on the map
     * and claim the drive takes no time, which the console would print.
     */
    expect(parseComputedRoute({ routes: [] })).toBeNull();
    expect(parseComputedRoute({})).toBeNull();
    expect(parseComputedRoute(null)).toBeNull();
  });

  it('refuses a route whose duration cannot be read', () => {
    // Protobuf durations are strings like "123s". Anything else means the
    // shape changed, and guessing a number from it would be inventing one.
    expect(parseComputedRoute({ routes: [{ duration: 'soon' }] })).toBeNull();
  });

  it('does not invent a distance it was not given', () => {
    const route = parseComputedRoute({ routes: [{ duration: '60s' }] });
    expect(route?.distanceMeters).toBe(0);
    expect(route?.geometry).toEqual([]);
  });
});
