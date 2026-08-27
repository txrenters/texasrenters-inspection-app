import {
  parseRouteResponse,
  parseTableResponse,
  toOsrmCoordinates,
} from '../src/routing/osrm.client';
import { toLatLngPath } from '../src/routing/route.service';

describe('OSRM coordinate order', () => {
  it('writes longitude first', () => {
    // The whole reason this function exists. Every other coordinate in this
    // system is lat,lon; OSRM is lon,lat. Swapped, a Houston property becomes a
    // point in Antarctica and OSRM reports no route -- so routing looks broken
    // rather than wrong, and nobody thinks to check the axis.
    expect(toOsrmCoordinates([{ latitude: 29.7264, longitude: -95.4169 }])).toBe('-95.4169,29.7264');
  });

  it('joins several points with semicolons', () => {
    expect(
      toOsrmCoordinates([
        { latitude: 29.7264, longitude: -95.4169 },
        { latitude: 29.8665, longitude: -95.204 },
      ]),
    ).toBe('-95.4169,29.7264;-95.204,29.8665');
  });

  it('keeps a Texas longitude negative', () => {
    // Dropping the sign puts the point in China, which routes to nothing.
    expect(toOsrmCoordinates([{ latitude: 30.2672, longitude: -97.7431 }])).toContain('-97.7431');
  });
});

describe('parseTableResponse', () => {
  it('reads the duration matrix', () => {
    expect(
      parseTableResponse({
        code: 'Ok',
        durations: [
          [0, 120],
          [130, 0],
        ],
      }),
    ).toEqual([
      [0, 120],
      [130, 0],
    ]);
  });

  it('turns an unreachable pair into Infinity, never zero', () => {
    // OSRM returns null for a pair it cannot connect. Zero would read as "no
    // travel time at all" and the solver would visit it first, every time.
    const matrix = parseTableResponse({ code: 'Ok', durations: [[0, null]] });
    expect(matrix?.[0]?.[1]).toBe(Number.POSITIVE_INFINITY);
  });

  it('refuses a response that is not Ok', () => {
    expect(parseTableResponse({ code: 'NoRoute', durations: [[0]] })).toBeNull();
  });

  it('survives a body shaped like nothing in particular', () => {
    for (const body of [null, undefined, {}, 'nope', { code: 'Ok' }, { code: 'Ok', durations: 4 }])
      expect(parseTableResponse(body)).toBeNull();
  });
});

describe('parseRouteResponse', () => {
  const reply = {
    code: 'Ok',
    routes: [
      {
        distance: 18234.5,
        duration: 1320.4,
        legs: [
          { distance: 9000, duration: 700 },
          { distance: 9234.5, duration: 620.4 },
        ],
        geometry: { coordinates: [[-95.4169, 29.7264], [-95.204, 29.8665]] },
      },
    ],
  };

  it('reads distance, duration and legs', () => {
    const route = parseRouteResponse(reply);
    expect(route?.distanceMeters).toBeCloseTo(18234.5);
    expect(route?.durationSeconds).toBeCloseTo(1320.4);
    expect(route?.legs).toHaveLength(2);
  });

  it('keeps the geometry in OSRM lon,lat order for the caller to flip', () => {
    // Left as OSRM gives it, and named so. Silently flipping here would hide
    // the axis question in a place nobody looks.
    expect(parseRouteResponse(reply)?.geometry[0]).toEqual([-95.4169, 29.7264]);
  });

  it('refuses a route with no distance', () => {
    expect(parseRouteResponse({ code: 'Ok', routes: [{ duration: 10 }] })).toBeNull();
  });

  it('refuses an empty route list', () => {
    expect(parseRouteResponse({ code: 'Ok', routes: [] })).toBeNull();
  });

  it('survives a malformed body', () => {
    for (const body of [null, undefined, {}, { code: 'Ok' }, { routes: [{}] }])
      expect(parseRouteResponse(body)).toBeNull();
  });
});

describe('toLatLngPath', () => {
  it('flips OSRM lon,lat into the lat,lng a map draws', () => {
    // The third place these two orders meet in this codebase, and the failure
    // is always silent: the line simply appears somewhere else on Earth.
    expect(toLatLngPath([[-95.4169, 29.7264]])).toEqual([[29.7264, -95.4169]]);
  });

  it('keeps the path in order', () => {
    expect(
      toLatLngPath([
        [-95.4169, 29.7264],
        [-95.204, 29.8665],
      ]),
    ).toEqual([
      [29.7264, -95.4169],
      [29.8665, -95.204],
    ]);
  });

  it('has nothing to draw for an empty path', () => {
    expect(toLatLngPath([])).toEqual([]);
  });
});
