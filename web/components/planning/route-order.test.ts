import { describe, expect, it } from 'vitest';

import { createAllowance } from '@/lib/daily-allowance';

import {
  createMatrixSource,
  fastestOrder,
  matrixUrl,
  parseMatrix,
  pathSeconds,
  stopsToTime,
  straightLineDurations,
} from './route-order';
import type { LngLat } from './road-routes';

/**
 * The fastest order through a group's stops, stop 1 first.
 *
 * Checked against every possible order, on drive-time tables where A to B is
 * not B to A -- one-way streets and freeway exits make them differ.
 */

/** A table of drive times from a fixed seed, so a failure can be run again. */
function randomTable(count: number, seed: number): number[][] {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  return Array.from({ length: count }, (_, from) =>
    Array.from({ length: count }, (_, to) => (from === to ? 0 : Math.round(60 + next() * 1800))),
  );
}

/** Every order of these stops, each once. */
function permutations(stops: number[]): number[][] {
  if (stops.length <= 1) return [stops];
  return stops.flatMap((stop, index) =>
    permutations([...stops.slice(0, index), ...stops.slice(index + 1)]).map((rest) => [stop, ...rest]),
  );
}

/** The least driving there is, by trying every order -- from stop 0, or from any stop. */
function bruteForce(table: number[][], fixedStart: boolean): number {
  const all = table.map((_, index) => index);
  const orders = fixedStart ? permutations(all.slice(1)).map((rest) => [0, ...rest]) : permutations(all);
  return Math.min(...orders.map((order) => pathSeconds(table, order)));
}

const isOrderOf = (order: number[], count: number) =>
  order.length === count && new Set(order).size === count && order.every((stop) => stop >= 0 && stop < count);

describe('the fastest order', () => {
  /** The office clicks in any order and does not know which stop should come first (2026-09-30). */
  it('finds the least driving there is, choosing the start, on one-way drive times', () => {
    for (let count = 2; count <= 7; count += 1)
      for (let seed = 1; seed <= 6; seed += 1) {
        const table = randomTable(count, seed * 97 + count);
        const order = fastestOrder(table);
        expect(isOrderOf(order, count)).toBe(true);
        expect(pathSeconds(table, order)).toBe(bruteForce(table, false));
      }
  });

  it('keeps stop 1 first when asked, and is still the least driving from there', () => {
    for (let count = 3; count <= 7; count += 1)
      for (let seed = 1; seed <= 4; seed += 1) {
        const table = randomTable(count, seed * 31 + count);
        const order = fastestOrder(table, { fixedStart: true });
        expect(order[0]).toBe(0);
        expect(pathSeconds(table, order)).toBe(bruteForce(table, true));
      }
  });

  /** The zigzag in the office's screenshot: south, north, south again. */
  it('undoes a zigzag, starting at one end', () => {
    // Stops along one road, clicked in the order 0, 3, 1, 2 of their places along it.
    const along = [0, 3, 1, 2];
    const table = along.map((from) => along.map((to) => Math.abs(from - to) * 300));
    const order = fastestOrder(table).map((index) => along[index]);
    expect([order, [...order].reverse()]).toContainEqual([0, 1, 2, 3]);
    expect(pathSeconds(table, fastestOrder(table))).toBe(900);
    expect(pathSeconds(table, [0, 1, 2, 3])).toBe(1800);
  });

  /** A to B is not B to A: with two stops, the quicker way round. */
  it('turns two stops round when the other way is quicker', () => {
    expect(fastestOrder([[0]])).toEqual([0]);
    expect(fastestOrder([
      [0, 5],
      [9, 0],
    ])).toEqual([0, 1]);
    expect(fastestOrder([
      [0, 9],
      [5, 0],
    ])).toEqual([1, 0]);
  });

  it('is exact for a full day of eleven stops, and quick', () => {
    const table = randomTable(11, 4242);
    const started = performance.now();
    const order = fastestOrder(table);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(isOrderOf(order, 11)).toBe(true);
    // No move of one stop to anywhere else -- the first and last included -- does better.
    const seconds = pathSeconds(table, order);
    for (let from = 0; from < 11; from += 1)
      for (let to = 0; to < 11; to += 1) {
        const moved = [...order];
        const [stop] = moved.splice(from, 1);
        moved.splice(to, 0, stop!);
        expect(pathSeconds(table, moved)).toBeGreaterThanOrEqual(seconds);
      }
  });

  it('beyond thirteen stops, still an order of every stop, and no worse than the nearest stop each time', () => {
    const table = randomTable(20, 7);
    const order = fastestOrder(table);
    expect(isOrderOf(order, 20)).toBe(true);
    const nearest = [0];
    const left = new Set(Array.from({ length: 19 }, (_, index) => index + 1));
    while (left.size) {
      const from = nearest[nearest.length - 1]!;
      const next = [...left].sort((a, b) => table[from]![a]! - table[from]![b]!)[0]!;
      nearest.push(next);
      left.delete(next);
    }
    expect(pathSeconds(table, order)).toBeLessThanOrEqual(pathSeconds(table, nearest));
  });
});

/** A fake Matrix API that answers the rows and columns asked for, and counts what it would bill. */
function fakeMatrix(urls: string[], billed: { elements: number } = { elements: 0 }) {
  return async (url: string) => {
    urls.push(url);
    const parsed = new URL(url);
    const count = parsed.pathname.split('/driving/')[1]!.split(';').length;
    const every = Array.from({ length: count }, (_, index) => index);
    const pick = (name: string) => parsed.searchParams.get(name)?.split(';').map(Number) ?? every;
    const sources = pick('sources');
    const destinations = pick('destinations');
    billed.elements += sources.length * destinations.length;
    const durations = sources.map((from) => destinations.map((to) => (from === to ? 0 : 100 + from * 10 + to)));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 'Ok', durations }) };
  };
}

describe('drive times from Mapbox', () => {
  const STOPS: LngLat[] = [
    [-95.37, 29.76],
    [-95.36, 29.77],
    [-95.35, 29.75],
  ];

  it('asks the Matrix API for driving times between every pair', () => {
    const url = new URL(matrixUrl(STOPS, 'pk.test'));
    expect(url.pathname).toBe('/directions-matrix/v1/mapbox/driving/-95.370000,29.760000;-95.360000,29.770000;-95.350000,29.750000');
    expect(url.searchParams.get('annotations')).toBe('duration');
  });

  it('reads a pair with no road as never worth taking, and refuses a table of other stops', () => {
    const table = parseMatrix({ code: 'Ok', durations: [[0, 60, null], [70, 0, 80], [90, 100, 0]] }, 3);
    expect(table[0]![2]).toBeGreaterThan(1e6);
    expect(table[1]).toEqual([70, 0, 80]);
    expect(() => parseMatrix({ code: 'Ok', durations: [[0]] }, 3)).toThrow();
    expect(() => parseMatrix({ code: 'InvalidInput', message: 'Too many coordinates' }, 3)).toThrow('Too many coordinates');
  });

  it('asks once for stops it has timed already, in any order, and spaces its requests', async () => {
    const urls: string[] = [];
    const waits: number[] = [];
    let clock = 0;
    const source = createMatrixSource({
      token: 'pk.test',
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      fetch: fakeMatrix(urls),
    });
    const first = await source.durations(STOPS);
    const again = await source.durations([STOPS[2]!, STOPS[0]!, STOPS[1]!]);
    expect(urls).toHaveLength(1);
    // The same pairs, read from memory in the new order: stop 2 to stop 0 was 120.
    expect(again[0]![1]).toBe(first[2]![0]);

    // A stop added: only its row and its column are asked for, two requests.
    await source.durations([...STOPS, [-95.34, 29.74]]);
    await source.durations([...STOPS, [-95.33, 29.73]]);
    expect(urls).toHaveLength(5);
    expect(new URL(urls[1]!).searchParams.get('sources')).toBe('3');
    expect(new URL(urls[2]!).searchParams.get('destinations')).toBe('3');
    // Sixty a minute at most: the later requests waited their turn.
    expect(waits.filter((ms) => ms > 0).length).toBeGreaterThanOrEqual(1);
  });

  it('asks for one stop’s row and column, not the whole table again, with the sources and destinations named', () => {
    const url = new URL(matrixUrl(STOPS, 'pk.test', { sources: [2] }));
    expect(url.searchParams.get('sources')).toBe('2');
    expect(url.searchParams.get('destinations')).toBeNull();
    expect(parseMatrix({ code: 'Ok', durations: [[1, 2, 3]] }, 1, 3)).toEqual([[1, 2, 3]]);
  });

  it('picks the fewest stops whose rows and columns hold every pair not yet timed', () => {
    const known = (rows: number[][], unknown: [number, number][]) => {
      const table: (number | undefined)[][] = rows.map((row) => [...row]);
      for (const [from, to] of unknown) table[from]![to] = undefined;
      return table;
    };
    const square = [
      [0, 1, 1, 1],
      [1, 0, 1, 1],
      [1, 1, 0, 1],
      [1, 1, 1, 0],
    ];
    // The stop just added: nothing known about it.
    expect(stopsToTime(known(square, [[3, 0], [3, 1], [3, 2], [0, 3], [1, 3], [2, 3]]))).toEqual([3]);
    expect(stopsToTime(square)).toEqual([]);
  });

  /**
   * October's lesson: count the billed calls per action. Building a day by
   * clicking used to ask the whole table again at each click -- 2² + 3² + ...
   * + 13² = 818 elements for a 13-stop day. Now each click asks for the new
   * stop's row and column.
   */
  it('builds a 13-stop day, one click at a time, for about a fifth of the elements', async () => {
    const urls: string[] = [];
    const billed = { elements: 0 };
    const source = createMatrixSource({ token: 'pk.test', sleep: async () => undefined, fetch: fakeMatrix(urls, billed) });
    const day = Array.from({ length: 13 }, (_, index) => [-95.4 + index / 100, 29.7 + index / 200] as LngLat);

    for (let stops = 2; stops <= day.length; stops += 1) await source.durations(day.slice(0, stops));

    expect(billed.elements).toBe(180);
    expect(billed.elements).toBeLessThan(818 / 4);
  });

  it('stops asking Mapbox once the day’s allowance is spent, and orders by straight lines instead', async () => {
    const urls: string[] = [];
    let told = 0;
    const source = createMatrixSource({
      token: 'pk.test',
      sleep: async () => undefined,
      fetch: fakeMatrix(urls),
      allowance: createAllowance('test-matrix', 9, { storage: null }),
      onAllowanceReached: () => (told += 1),
    });

    await source.durations(STOPS); // 9 elements: the whole allowance.
    const estimated = await source.durations([...STOPS, [-95.34, 29.74]]);
    await source.durations([...STOPS, [-95.33, 29.73]]);

    expect(urls).toHaveLength(1);
    expect(estimated).toEqual(straightLineDurations([...STOPS, [-95.34, 29.74]]));
    // Said once, not after every click.
    expect(told).toBe(1);
  });

  it('refuses more than 25 stops without asking', async () => {
    const source = createMatrixSource({
      token: 'pk.test',
      fetch: async () => {
        throw new Error('should not be asked');
      },
    });
    const many = Array.from({ length: 26 }, (_, index) => [-95.4 + index / 100, 29.7] as LngLat);
    await expect(source.durations(many)).rejects.toThrow('at most 25');
  });
});
