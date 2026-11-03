import { Logger } from '@nestjs/common';

import {
  chunkForRequests,
  DailyAllowance,
  MapboxDirectionsClient,
  parseMatrixResponse,
  stitch,
  MAX_COORDINATES,
} from './mapbox-directions.client';
import type { OsrmRoute } from './osrm.client';

/**
 * A day drawn on real roads rather than as chords across Houston.
 *
 * Reported with a screenshot: the plan's day map drawing straight lines between
 * its stops, above the banner "No drive times could be measured for this day".
 * The planner asked Google for the road, Google's billing had lapsed, and the
 * day came back undrawn.
 */

const leg = (distance: number, duration: number) => ({
  distanceMeters: distance,
  durationSeconds: duration,
});

const part = (geometry: [number, number][], legs = [leg(100, 10)]): OsrmRoute => ({
  distanceMeters: legs.reduce((total, each) => total + each.distanceMeters, 0),
  durationSeconds: legs.reduce((total, each) => total + each.durationSeconds, 0),
  legs,
  geometry,
});

describe('splitting a long day into requests', () => {
  it('asks once when the whole day fits', () => {
    expect(chunkForRequests(10)).toEqual([[0, 10]]);
    expect(chunkForRequests(MAX_COORDINATES)).toEqual([[0, MAX_COORDINATES]]);
  });

  it('asks for nothing when there is no journey', () => {
    expect(chunkForRequests(0)).toEqual([]);
    expect(chunkForRequests(1)).toEqual([]);
  });

  /**
   * The overlap is the join. A leg has to start where the previous one ended,
   * so each chunk begins on the point the last one finished on -- without it
   * the drive across the boundary is missing and the line jumps.
   */
  it('overlaps each request with the last by one point', () => {
    const chunks = chunkForRequests(30, 25);

    expect(chunks).toEqual([
      [0, 25],
      [24, 30],
    ]);
  });

  it('covers every leg exactly once, however long the day', () => {
    for (const count of [26, 49, 50, 51, 99]) {
      const chunks = chunkForRequests(count, 25);
      // Each chunk of n points contributes n-1 legs; together they must equal
      // the legs of the whole journey.
      const legs = chunks.reduce((total, [start, end]) => total + (end - start - 1), 0);
      expect(legs).toBe(count - 1);
    }
  });

  it('never asks for more than the API accepts', () => {
    for (const chunk of chunkForRequests(120, 25)) expect(chunk[1] - chunk[0]).toBeLessThanOrEqual(25);
  });
});

describe('joining the parts back into one drive', () => {
  it('is the single route when there was only one request', () => {
    const only = part([
      [-95.5, 29.7],
      [-95.4, 29.8],
    ]);

    expect(stitch([only])).toEqual(only);
  });

  it('does not repeat the point two requests share', () => {
    const first = part([
      [-95.5, 29.7],
      [-95.45, 29.75],
      [-95.4, 29.8],
    ]);
    const second = part([
      [-95.4, 29.8],
      [-95.3, 29.9],
    ]);

    expect(stitch([first, second])?.geometry).toEqual([
      [-95.5, 29.7],
      [-95.45, 29.75],
      [-95.4, 29.8],
      [-95.3, 29.9],
    ]);
  });

  it('adds the distances, the times and every leg', () => {
    const joined = stitch([
      part([[-95.5, 29.7]], [leg(1_000, 60), leg(2_000, 120)]),
      part([[-95.5, 29.7]], [leg(500, 30)]),
    ]);

    expect(joined?.distanceMeters).toBe(3_500);
    expect(joined?.durationSeconds).toBe(210);
    expect(joined?.legs).toHaveLength(3);
  });

  it('is nothing at all when there is nothing to join', () => {
    expect(stitch([])).toBeNull();
  });
});

/**
 * The matrix the quarter planner orders a day with.
 *
 * Until this existed the planner had nothing to ask once Google's billing
 * lapsed, so every day was laid out and measured on a straight-line estimate
 * and recorded itself as HAVERSINE.
 */
describe('reading a duration matrix', () => {
  const ok = {
    code: 'Ok',
    durations: [
      [0, 420],
      [400, 0],
    ],
    distances: [
      [0, 6000],
      [5800, 0],
    ],
  };

  it('reads the seconds and the metres between every pair', () => {
    expect(parseMatrixResponse(ok)).toEqual({
      durations: [
        [0, 420],
        [400, 0],
      ],
      distances: [
        [0, 6000],
        [5800, 0],
      ],
    });
  });

  /**
   * A pair Mapbox cannot connect -- an island, a gated estate, a coordinate off
   * the road network -- comes back null. Infinity keeps it comparable while
   * making it never chosen, which is what "unreachable" should mean to a
   * solver. A zero would make it look like the best stop of all.
   */
  it('makes an unreachable pair unreachable rather than free', () => {
    const parsed = parseMatrixResponse({
      code: 'Ok',
      durations: [
        [0, null],
        [null, 0],
      ],
    });

    expect(parsed?.durations[0]?.[1]).toBe(Number.POSITIVE_INFINITY);
  });

  /**
   * Distances are the softer half: the planner uses them to report how far a
   * day drives, and a matrix without them is still one it can order a day
   * with. Refusing the whole answer would trade a measured day for an
   * estimated one.
   */
  it('still answers when only the distances are missing', () => {
    const parsed = parseMatrixResponse({ code: 'Ok', durations: [[0, 420], [400, 0]] });

    expect(parsed?.durations[0]?.[1]).toBe(420);
    expect(parsed?.distances).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it('refuses anything that is not a matrix', () => {
    expect(parseMatrixResponse(null)).toBeNull();
    expect(parseMatrixResponse({ code: 'NoRoute' })).toBeNull();
    expect(parseMatrixResponse({ code: 'Ok' })).toBeNull();
    expect(parseMatrixResponse({ code: 'Ok', durations: [] })).toBeNull();
    expect(parseMatrixResponse({ code: 'Ok', durations: ['nope'] })).toBeNull();
  });
});

/**
 * The ceiling on what one day may ask Mapbox for.
 *
 * The invoice that asked for it: $764 for October 2026, nearly all of it
 * 384,009 matrix elements on 15 October, from the Group maker's suggestions.
 * Every other day of the month fitted in the free allowance.
 */
describe('a day of Mapbox, counted', () => {
  it('spends up to the ceiling and refuses past it', () => {
    const today = new DailyAllowance('matrix', 250, () => new Date('2026-10-15T12:00:00Z'));

    expect(today.fits(121)).toBe(true);
    today.spend(121);
    expect(today.fits(121)).toBe(true);
    today.spend(121);
    // 242 spent: a third matrix of 121 would be 363.
    expect(today.fits(121)).toBe(false);
    expect(today.fits(8)).toBe(true);
  });

  /** UTC, the day Mapbox's own statistics page counts in, not Texas's. */
  it('starts again at midnight UTC', () => {
    let now = new Date('2026-10-15T23:59:00Z');
    const today = new DailyAllowance('matrix', 100, () => now);
    today.spend(100);
    expect(today.fits(1)).toBe(false);

    now = new Date('2026-10-16T00:00:00Z');
    expect(today.fits(100)).toBe(true);
  });

  it('says only the first refusal of a day is the first', () => {
    let now = new Date('2026-10-15T09:00:00Z');
    const today = new DailyAllowance('matrix', 0, () => now);

    expect(today.refuse()).toBe(true);
    expect(today.refuse()).toBe(false);
    now = new Date('2026-10-16T09:00:00Z');
    expect(today.refuse()).toBe(true);
  });
});

describe('asking Mapbox within the day', () => {
  const saved = { ...process.env };
  const realFetch = global.fetch;
  const square = (count: number) => ({
    code: 'Ok',
    durations: Array.from({ length: count }, () => Array.from({ length: count }, () => 60)),
  });
  const points = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ latitude: 29.8, longitude: -95.4 + index / 1000 }));
  let fetchMock: jest.Mock;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    process.env.MAPBOX_TOKEN = 'pk.test';
    fetchMock = jest.fn().mockImplementation((url: string) => {
      const count = (url.split('/driving/')[1] ?? '').split('?')[0]!.split(';').length;
      const body = url.includes('/directions-matrix/')
        ? square(count)
        : {
            code: 'Ok',
            routes: [{ distance: 100, duration: 60, legs: [{ distance: 100, duration: 60 }], geometry: { coordinates: [] } }],
          };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...saved };
    global.fetch = realFetch;
    warn.mockRestore();
  });

  it('stops asking for matrices once the day’s elements are spent, and says so once', async () => {
    process.env.MAPBOX_DAILY_MATRIX_ELEMENTS = '250';
    const mapbox = new MapboxDirectionsClient();

    // Eleven points are 121 elements: two fit in 250, a third does not.
    expect(await mapbox.matrix(points(11))).not.toBeNull();
    expect(await mapbox.matrix(points(11))).not.toBeNull();
    expect(await mapbox.matrix(points(11))).toBeNull();
    expect(await mapbox.matrix(points(11))).toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'mapbox_daily_allowance_reached', allowance: 'matrix', ceiling: 250 }),
    );
  });

  /**
   * A suggestion has its estimate already; a plan has nothing else. Once the
   * suggestions have had their share, the plans still get theirs.
   */
  it('stops a suggestion at its own ceiling while a plan still gets its matrix', async () => {
    process.env.MAPBOX_DAILY_OPTIONAL_MATRIX_ELEMENTS = '100';
    const mapbox = new MapboxDirectionsClient();

    expect(await mapbox.matrix(points(10), { optional: true })).not.toBeNull();
    expect(await mapbox.matrix(points(10), { optional: true })).toBeNull();
    expect(await mapbox.matrix(points(10))).not.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ allowance: 'optional-matrix', ceiling: 100 }));
  });

  it('counts a refused suggestion against nothing', async () => {
    process.env.MAPBOX_DAILY_MATRIX_ELEMENTS = '100';
    process.env.MAPBOX_DAILY_OPTIONAL_MATRIX_ELEMENTS = '0';
    const mapbox = new MapboxDirectionsClient();

    expect(await mapbox.matrix(points(10), { optional: true })).toBeNull();
    // All hundred still there for the plan.
    expect(await mapbox.matrix(points(10))).not.toBeNull();
  });

  it('asks for a whole route or none of it', async () => {
    process.env.MAPBOX_DAILY_DIRECTIONS_REQUESTS = '1';
    const mapbox = new MapboxDirectionsClient();

    // Thirty points are two requests; one is allowed, so neither is made.
    expect(await mapbox.route(points(30))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await mapbox.route(points(10))).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /** An empty line in the env file is not a ceiling of zero, which would switch Mapbox off. */
  it('reads an empty or unreadable setting as the default', async () => {
    process.env.MAPBOX_DAILY_MATRIX_ELEMENTS = '';
    process.env.MAPBOX_DAILY_OPTIONAL_MATRIX_ELEMENTS = 'lots';
    const mapbox = new MapboxDirectionsClient();

    expect(await mapbox.matrix(points(25), { optional: true })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
