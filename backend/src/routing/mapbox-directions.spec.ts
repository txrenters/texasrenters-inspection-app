import {
  chunkForRequests,
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
