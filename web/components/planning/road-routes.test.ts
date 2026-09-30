import { describe, expect, it } from 'vitest';

import {
  createRouteStore,
  decodePolyline,
  directionsUrl,
  encodePolyline,
  formatDrive,
  formatKm,
  legGeometry,
  mergeRoutes,
  midpointOf,
  milesToMetres,
  parseDirections,
  ROUTE_CACHE_KEY,
  routeKey,
  waypointChunks,
  type LngLat,
} from './road-routes';

/**
 * Road routes from the Mapbox Directions API.
 *
 * Nothing here calls Mapbox: a fake answers the way it does, with each stop
 * snapped exactly onto a straight "road" and every leg ten minutes.
 */

const STOPS: LngLat[] = [
  [-95.37, 29.76],
  [-95.36, 29.77],
  [-95.35, 29.75],
];

/** The stops out of a request URL, as Mapbox reads them. */
const stopsOf = (url: string): LngLat[] =>
  new URL(url).pathname
    .split('/driving/')[1]!
    .split(';')
    .map((pair) => pair.split(',').map(Number) as LngLat);

/** What Mapbox answers for these stops: a line through them with a midpoint on each leg, ten minutes a leg. */
function answer(stops: readonly LngLat[]) {
  const coordinates: LngLat[] = [];
  stops.forEach((stop, index) => {
    if (index > 0) {
      const previous = stops[index - 1]!;
      coordinates.push([(previous[0] + stop[0]) / 2, (previous[1] + stop[1]) / 2]);
    }
    coordinates.push(stop);
  });
  const legs = stops.slice(1).map(() => ({ duration: 600, distance: 1609.344 }));
  return {
    code: 'Ok',
    routes: [{ duration: 600 * legs.length, distance: 1609.344 * legs.length, geometry: { coordinates }, legs }],
    waypoints: stops.map((location) => ({ location })),
  };
}

const ok = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });

/** A browser-storage stand-in. */
function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), items };
}

describe('asking Mapbox', () => {
  it('asks for a driving route through the stops in order, the whole line as GeoJSON', () => {
    const url = new URL(directionsUrl(STOPS, 'pk.test'));
    expect(url.origin + url.pathname).toBe(
      'https://api.mapbox.com/directions/v5/mapbox/driving/-95.370000,29.760000;-95.360000,29.770000;-95.350000,29.750000',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({ geometries: 'geojson', overview: 'full', access_token: 'pk.test' });
  });

  /** Mapbox takes 25 stops at most: a longer group is asked for in runs that join up. */
  it('splits more than 25 stops into runs that share their ends', () => {
    const fifty = Array.from({ length: 50 }, (_, index) => index);
    expect(waypointChunks(fifty.slice(0, 25))).toHaveLength(1);
    const runs = waypointChunks(fifty);
    expect(runs.map((run) => [run[0], run[run.length - 1], run.length])).toEqual([
      [0, 24, 25],
      [24, 48, 25],
      [48, 49, 2],
    ]);
  });

  it('reads the route, and where each stop falls on its line', () => {
    const route = parseDirections(answer(STOPS), STOPS);
    expect(route.legs).toHaveLength(2);
    expect(route.splits).toEqual([0, 2, 4]);
    const middle: LngLat = [(STOPS[1]![0] + STOPS[2]![0]) / 2, (STOPS[1]![1] + STOPS[2]![1]) / 2];
    expect(legGeometry(route, 1)).toEqual([STOPS[1], middle, STOPS[2]]);
  });

  it('refuses an answer that is not a route, or is a route of other stops', () => {
    expect(() => parseDirections({ code: 'NoRoute', message: 'No route found' }, STOPS)).toThrow('No route found');
    expect(() => parseDirections(answer(STOPS.slice(0, 2)), STOPS)).toThrow();
    expect(() => parseDirections('nonsense', STOPS)).toThrow();
  });

  it('joins runs into one route, legs and all', () => {
    const joined = mergeRoutes([parseDirections(answer(STOPS), STOPS), parseDirections(answer([STOPS[2]!, STOPS[0]!]), [STOPS[2]!, STOPS[0]!])]);
    expect(joined.legs).toHaveLength(3);
    expect(joined.durationS).toBe(1800);
    expect(joined.splits).toEqual([0, 2, 4, 6]);
    expect(legGeometry(joined, 2)[0]).toEqual(STOPS[2]);
  });

  it('keeps a line in the browser compactly, to about a metre', () => {
    const line: LngLat[] = [
      [-95.369838, 29.760422],
      [-95.354964, 29.75826],
      [-95.0, 30.0],
    ];
    for (const [index, point] of decodePolyline(encodePolyline(line)).entries()) {
      expect(point[0]).toBeCloseTo(line[index]![0], 5);
      expect(point[1]).toBeCloseTo(line[index]![1], 5);
    }
  });

  it('says a drive the way a person would', () => {
    expect(formatDrive(480)).toBe('8 min');
    expect(formatDrive(72 * 60)).toBe('1 h 12 min');
    expect(formatDrive(3600)).toBe('1 h');
  });

  /** The office works in kilometres (2026-09-30); its files keep miles and are converted for show. */
  it('says a distance in kilometres, the file’s miles included', () => {
    expect(formatKm(61_800)).toBe('61.8 km');
    expect(formatKm(milesToMetres(30.5))).toBe('49.1 km');
  });

  /** A leg's drive time is written halfway along the road, not halfway between its ends. */
  it('finds the point halfway along a leg by distance', () => {
    // An L: 3 units east, then 1 north. Halfway along 4 is 2 units east.
    const [longitude, latitude] = midpointOf([
      [0, 0],
      [3, 0],
      [3, 1],
    ]);
    expect(longitude).toBeCloseTo(2, 6);
    expect(latitude).toBeCloseTo(0, 6);
    expect(midpointOf([[5, 6]])).toEqual([5, 6]);
  });
});

describe('the route cache', () => {
  const store = (overrides: Partial<Parameters<typeof createRouteStore>[0]> = {}) => {
    const calls: string[] = [];
    const created = createRouteStore({
      token: 'pk.test',
      storage: memoryStorage(),
      sleep: async () => undefined,
      fetch: async (url) => {
        calls.push(url);
        return ok(answer(stopsOf(url)));
      },
      ...overrides,
    });
    return { created, calls };
  };

  it('asks once for the same stops in the same order, and answers from memory after', async () => {
    const { created, calls } = store();
    const key = routeKey(STOPS);
    await created.ensure(key, STOPS);
    await created.ensure(key, STOPS);
    expect(calls).toHaveLength(1);
    expect(created.view(key)).toMatchObject({ status: 'ok' });
    // The same stops in another order are another route.
    const reversed = [...STOPS].reverse();
    await created.ensure(routeKey(reversed), reversed);
    expect(calls).toHaveLength(2);
  });

  /** Kept beside the autosave, so a reload asks for nothing it already has. */
  it('answers after a reload from the browser, without asking Mapbox again', async () => {
    const storage = memoryStorage();
    const first = store({ storage });
    await first.created.ensure(routeKey(STOPS), STOPS);
    expect(storage.items.has(ROUTE_CACHE_KEY)).toBe(true);
    // Fingerprinted: the stops themselves are not spelled out in the key.
    expect(storage.items.get(ROUTE_CACHE_KEY)).not.toContain('-95.37');

    const reloaded = store({ storage });
    const route = await reloaded.created.ensure(routeKey(STOPS), STOPS);
    expect(reloaded.calls).toHaveLength(0);
    expect(route.legs.map((leg) => leg.durationS)).toEqual([600, 600]);
  });

  it('sends two at a time, a gap apart, when a whole file asks at once', async () => {
    let inFlight = 0;
    let most = 0;
    const waits: number[] = [];
    let clock = 0;
    let asked = 0;
    const { created } = store({
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      fetch: async (url) => {
        asked += 1;
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return ok(answer(stopsOf(url)));
      },
    });
    const groups = Array.from({ length: 6 }, (_, index) => STOPS.map(([lng, lat]) => [lng + index / 100, lat] as LngLat));
    await Promise.all(groups.map((stops) => created.ensure(routeKey(stops), stops)));
    expect(asked).toBe(6);
    expect(most).toBeLessThanOrEqual(2);
    // Four a second at most: every request after the first waited its turn.
    expect(waits.filter((ms) => ms > 0).length).toBeGreaterThanOrEqual(4);
  });

  it('waits and tries again when Mapbox says too many', async () => {
    const waits: number[] = [];
    let first = true;
    const { created } = store({
      sleep: async (ms) => void waits.push(ms),
      fetch: async (url) => {
        if (first) {
          first = false;
          return { ok: false, status: 429, headers: { get: (name: string) => (name === 'retry-after' ? '3' : null) }, json: async () => ({}) };
        }
        return ok(answer(stopsOf(url)));
      },
    });
    await expect(created.ensure(routeKey(STOPS), STOPS)).resolves.toMatchObject({ durationS: 1200 });
    expect(waits).toContain(3000);
  });

  it('marks a group Mapbox cannot route, and keeps nothing of it', async () => {
    const storage = memoryStorage();
    const { created } = store({
      storage,
      fetch: async () => ({ ok: false, status: 422, headers: { get: () => null }, json: async () => ({ message: 'Too many coordinates' }) }),
    });
    await expect(created.ensure(routeKey(STOPS), STOPS)).rejects.toThrow('Too many coordinates');
    expect(created.view(routeKey(STOPS))).toEqual({ status: 'error', message: 'Too many coordinates' });
    expect(storage.items.has(ROUTE_CACHE_KEY)).toBe(false);
  });

  it('routes a group of more than 25 stops in joined runs', async () => {
    const { created, calls } = store();
    const thirty = Array.from({ length: 30 }, (_, index) => [-95.4 + index / 1000, 29.7] as LngLat);
    const route = await created.ensure(routeKey(thirty), thirty);
    expect(calls).toHaveLength(2);
    expect(route.legs).toHaveLength(29);
  });
});
