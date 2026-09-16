import {
  MAX_MATRIX_ELEMENTS,
  matrixWaitMs,
  parseDuration,
  parseRouteMatrix,
} from '../src/routing/google-routes.client';

/** The shape Routes API returns: a flat list, in no guaranteed order. */
const entry = (
  originIndex: number,
  destinationIndex: number,
  duration: string,
  distanceMeters: number,
) => ({ originIndex, destinationIndex, duration, distanceMeters, condition: 'ROUTE_EXISTS' });

describe('reading a Google duration', () => {
  it('reads the protobuf duration format', () => {
    expect(parseDuration('123s')).toBe(123);
  });

  /**
   * Fractional seconds are legal in that format. Truncating would lose a little
   * on every leg of every route, which compounds across a day.
   */
  it('keeps fractional seconds', () => {
    expect(parseDuration('1.5s')).toBe(1.5);
  });

  it('refuses anything that is not a duration', () => {
    expect(parseDuration('123')).toBeNull();
    expect(parseDuration(null)).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
    expect(parseDuration('abcs')).toBeNull();
    expect(parseDuration(Number.NaN)).toBeNull();
  });
});

describe('reading a route matrix', () => {
  /**
   * The response is a flat list in no guaranteed order, so the matrix is filled
   * by index. Reading it positionally is the mistake that produces a plausible
   * route to the wrong houses — hence the shuffled fixture.
   */
  it('fills by index, not by the order the rows arrived in', () => {
    const matrix = parseRouteMatrix(
      [
        entry(1, 0, '600s', 9000),
        entry(0, 0, '0s', 0),
        entry(1, 1, '0s', 0),
        entry(0, 1, '300s', 5000),
      ],
      2,
    );

    expect(matrix?.durations).toEqual([
      [0, 300],
      [600, 0],
    ]);
    expect(matrix?.distances).toEqual([
      [0, 5000],
      [9000, 0],
    ]);
  });

  /**
   * Infinity, never zero. A pair Google cannot connect must look like the worst
   * possible stop to a solver; a zero would make it look like the best.
   */
  it('leaves a pair Google could not connect as unreachable', () => {
    const matrix = parseRouteMatrix(
      [
        entry(0, 0, '0s', 0),
        { originIndex: 0, destinationIndex: 1, condition: 'ROUTE_NOT_FOUND' },
        entry(1, 0, '600s', 9000),
        entry(1, 1, '0s', 0),
      ],
      2,
    );

    expect(matrix?.durations[0][1]).toBe(Number.POSITIVE_INFINITY);
    expect(matrix?.durations[1][0]).toBe(600);
  });

  it('ignores an index outside the matrix rather than growing it', () => {
    const matrix = parseRouteMatrix(
      [entry(0, 0, '0s', 0), entry(0, 1, '60s', 1000), entry(1, 0, '60s', 1000), entry(1, 1, '0s', 0), entry(0, 9, '60s', 1000)],
      2,
    );

    expect(matrix?.durations).toEqual([
      [0, 60],
      [60, 0],
    ]);
  });

  /**
   * A response that filled nothing is not a matrix of unreachable pairs, it is
   * one we failed to understand. Saying so is what lets the planner fall back
   * to OSRM or to straight-line ordering instead of believing every stop is
   * unreachable.
   */
  it('returns null for a response it could not read at all', () => {
    expect(parseRouteMatrix([], 2)).toBeNull();
    expect(parseRouteMatrix(null, 2)).toBeNull();
    expect(parseRouteMatrix({ error: 'nope' }, 2)).toBeNull();
    expect(parseRouteMatrix([{ originIndex: 'a', destinationIndex: 0 }], 2)).toBeNull();
  });

  it('refuses a zero-sized matrix', () => {
    expect(parseRouteMatrix([entry(0, 0, '0s', 0)], 0)).toBeNull();
  });
});

/**
 * 2026-09-16: a Rebuild of full days got matrices back with only each point to
 * itself answered, and an empty route took the quarter's routing down.
 */
describe('a matrix answered only on its diagonal', () => {
  it('is no answer at all, so the caller falls back', () => {
    const diagonalOnly = [0, 1, 2].map((index) => entry(index, index, '0s', 0));

    expect(parseRouteMatrix(diagonalOnly, 3)).toBeNull();
  });
});

describe('pacing route matrices under the per-minute quota', () => {
  const at = (seconds: number, elements: number) => ({ at: seconds * 1000, elements });

  it('asks straight away while the minute has room', () => {
    expect(matrixWaitMs([at(0, 1000)], 900, 2000, 30_000)).toBe(0);
  });

  it('waits until enough of the minute’s earlier matrices fall out of it', () => {
    // 1,900 asked for in the last minute; 169 more waits for the first 1,000 to age out at 60 s.
    expect(matrixWaitMs([at(0, 1000), at(20, 900)], 169, 2000, 30_000)).toBe(30_000);
  });

  it('forgets matrices older than a minute', () => {
    expect(matrixWaitMs([at(0, 2000)], 169, 2000, 61_000)).toBe(0);
  });

  it('never makes a matrix wait on an empty minute, however large', () => {
    expect(matrixWaitMs([], 5000, 2000, 0)).toBe(0);
  });
});

describe('the billing guard', () => {
  /**
   * Google bills per origin-destination pair. A day of ten stops plus an origin
   * is 121 elements; one matrix over four hundred stops would be a hundred and
   * sixty thousand, per solve. The cap exists so a caller that has forgotten
   * that gets a refusal rather than a bill.
   */
  it('is sized for a technician-day, not a quarter', () => {
    const dayOfTenStopsPlusOrigin = 11 * 11;
    expect(dayOfTenStopsPlusOrigin).toBeLessThanOrEqual(MAX_MATRIX_ELEMENTS);

    const wholeQuarter = 400 * 400;
    expect(wholeQuarter).toBeGreaterThan(MAX_MATRIX_ELEMENTS);
  });
});
