import {
  OsrmClient,
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

/**
 * The guard that stops OSRM inventing a starting point.
 *
 * Left to itself OSRM snaps any coordinate to the nearest road in its extract,
 * however distant, and answers `Ok`. Measured against our own container, a
 * point in the Philippines came back as a road in east Texas with a four-hour
 * drive to Houston attached. `radiuses` is the only thing that makes it say no.
 */
describe('the snapping radius', () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.OSRM_URL;

  const HOUSTON = { latitude: 29.958784, longitude: -95.574255 };
  const MARIPOSA = { latitude: 29.866277, longitude: -95.200871 };

  beforeEach(() => {
    process.env.OSRM_URL = 'http://osrm:5000';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.OSRM_URL;
    else process.env.OSRM_URL = originalUrl;
  });

  /** Records the URLs asked for, and answers each from `handler`. */
  function record(handler: (url: string) => { status?: number; body: unknown }) {
    const asked: string[] = [];
    global.fetch = (async (input: unknown) => {
      const url = String(input);
      asked.push(url);
      const { status = 200, body } = handler(url);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as Response;
    }) as unknown as typeof fetch;
    return asked;
  }

  it('gives the matrix one radius per coordinate', async () => {
    const asked = record(() => ({
      body: {
        code: 'Ok',
        durations: [
          [0, 600],
          [600, 0],
        ],
      },
    }));

    await new OsrmClient().durations([HOUSTON, MARIPOSA]);

    // Two coordinates, two radiuses. OSRM matches them positionally, so a
    // short list would silently apply the guard to only the first points.
    expect(asked[0]).toContain('radiuses=5000;5000');
  });

  it('gives the drive the same radius as the matrix', async () => {
    // Different limits between the two calls would let a point pass the
    // ordering step and then be substituted while drawing the line.
    const asked = record(() => ({
      body: {
        code: 'Ok',
        routes: [{ distance: 1, duration: 1, legs: [], geometry: { coordinates: [] } }],
      },
    }));

    await new OsrmClient().route([HOUSTON, MARIPOSA]);

    expect(asked[0]).toContain('radiuses=5000;5000');
  });

  it('reads a refusal as no matrix rather than as data', async () => {
    // OSRM answers a refused coordinate with HTTP 400 and a JSON body. The
    // body is now returned to the parser rather than swallowed, so this pins
    // that the parser still rejects it.
    record(() => ({
      status: 400,
      body: { code: 'NoSegment', message: 'Could not find a matching segment for coordinate 0' },
    }));

    expect(await new OsrmClient().durations([HOUSTON, MARIPOSA])).toBeNull();
  });

  it('says which points OSRM will not snap', async () => {
    const asked = record((url) =>
      url.includes('123.806345')
        ? { status: 400, body: { code: 'NoSegment', message: 'no segment' } }
        : { body: { code: 'Ok', waypoints: [{ location: [-95.574254, 29.958708] }] } },
    );

    const snappable = await new OsrmClient().snappable([
      { latitude: 8.48164, longitude: 123.806345 },
      HOUSTON,
    ]);

    expect(snappable).toEqual([false, true]);
    // One /nearest per point, and the radius applied to each.
    expect(asked).toHaveLength(2);
    expect(asked.every((url) => url.includes('radiuses=5000'))).toBe(true);
  });

  it('cannot tell anything when OSRM does not answer at all', async () => {
    // Null means "no diagnosis", not "everything is off the map". Reporting
    // every point as unroutable during an outage would put the blame on the
    // technician's position for a fault in our own container.
    global.fetch = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;

    expect(await new OsrmClient().snappable([HOUSTON, MARIPOSA])).toBeNull();
  });

  it('asks nothing when routing is not configured', async () => {
    delete process.env.OSRM_URL;
    const asked = record(() => ({ body: { code: 'Ok' } }));

    expect(await new OsrmClient().snappable([HOUSTON])).toBeNull();
    expect(asked).toHaveLength(0);
  });
});
