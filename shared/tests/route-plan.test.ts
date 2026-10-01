import { describe, expect, it } from 'vitest';

import {
  MAX_EXACT_STOPS,
  routeDuration,
  shortestRouteOrder,
} from '../src/contracts/route-plan.js';

/**
 * Four stops in a line, the technician standing at one end:
 *
 *   origin --1-- A --1-- B --1-- C
 *
 * Walking out along the line is obviously best. Presented to the solver in the
 * worst possible order so that returning the input unchanged fails.
 */
const LINE = [
  //        origin  A   B   C
  /* origin */ [0, 1, 2, 3],
  /* A      */ [1, 0, 1, 2],
  /* B      */ [2, 1, 0, 1],
  /* C      */ [3, 2, 1, 0],
];

describe('shortestRouteOrder', () => {
  it('walks a line outward from the origin', () => {
    expect(shortestRouteOrder(LINE)).toEqual([1, 2, 3]);
  });

  it('returns nothing to visit when there are no stops', () => {
    expect(shortestRouteOrder([[0]])).toEqual([]);
  });

  it('handles a single stop without deciding anything', () => {
    expect(
      shortestRouteOrder([
        [0, 5],
        [5, 0],
      ]),
    ).toEqual([1]);
  });

  it('respects one-way costs rather than assuming symmetry', () => {
    // A→B is cheap, B→A is not. Collapsing the matrix to a triangle -- an easy
    // and invisible mistake -- would make these two orderings look identical.
    const oneWay = [
      [0, 10, 10],
      [10, 0, 1],
      [10, 90, 0],
    ];
    expect(shortestRouteOrder(oneWay)).toEqual([1, 2]);
  });

  it('finds the exact best order where nearest-neighbour loses badly', () => {
    // Stop 1 is nearest the origin and is a dead end: arriving is cheap, leaving
    // costs 99. Greedy takes it first and pays; the right move is to visit it
    // last. Asymmetric on purpose -- this is what a one-way system does.
    //
    //            origin  1    2    3
    const trap = [
      /* origin */ [0, 1, 5, 6],
      /* 1      */ [1, 0, 99, 99],
      /* 2      */ [5, 2, 0, 2],
      /* 3      */ [6, 2, 2, 0],
    ];

    // Greedy: origin->1 (1) then the cheapest onward hop (99) = 102.
    expect(routeDuration(trap, [1, 2, 3])).toBe(102);
    // Exact: leave the dead end until last = 9.
    expect(shortestRouteOrder(trap)).toEqual([2, 3, 1]);
    expect(routeDuration(trap, shortestRouteOrder(trap))).toBe(9);
  });

  it('still returns every stop exactly once past the exact-search limit', () => {
    // Beyond MAX_EXACT_STOPS the answer is heuristic, so correctness here means
    // a complete permutation rather than a specific one.
    const size = MAX_EXACT_STOPS + 3;
    const matrix = Array.from({ length: size + 1 }, (_, row) =>
      Array.from({ length: size + 1 }, (_, column) => (row === column ? 0 : Math.abs(row - column))),
    );

    const order = shortestRouteOrder(matrix);
    expect(order).toHaveLength(size);
    expect(new Set(order).size).toBe(size);
    expect(Math.min(...order)).toBe(1);
    expect(Math.max(...order)).toBe(size);
  });

  it('beats the unoptimised order on a scrambled line', () => {
    const size = MAX_EXACT_STOPS + 3;
    const matrix = Array.from({ length: size + 1 }, (_, row) =>
      Array.from({ length: size + 1 }, (_, column) => (row === column ? 0 : Math.abs(row - column))),
    );
    const scrambled = [5, 1, 9, 3, 7, 2, 8, 4, 6, 10].slice(0, size);

    expect(routeDuration(matrix, shortestRouteOrder(matrix))).toBeLessThanOrEqual(
      routeDuration(matrix, scrambled),
    );
  });
});

/**
 * Google leaves a pair it could not answer as Infinity. On 2026-09-16 a quarter
 * of full days came back with no drive from home answered, and a nine-stop day
 * got an empty order back -- which took the whole plan's routing down with it.
 */
describe('an order through stops no leg reaches', () => {
  it('still visits every stop past the exact-search limit, in the order given', () => {
    const size = MAX_EXACT_STOPS + 2;
    const matrix = Array.from({ length: size + 1 }, (_, from) =>
      Array.from({ length: size + 1 }, (_, to) => (from === to ? 0 : from === 0 ? Number.POSITIVE_INFINITY : 60)),
    );

    const order = shortestRouteOrder(matrix);

    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: size }, (_, index) => index + 1));
  });
});

/**
 * Exact up to MAX_EXACT_STOPS by dynamic programming (Held-Karp), where it used
 * to try every ordering up to seven. A benefit-package day is nine or ten
 * properties, which the old limit left to nearest-neighbour and 2-opt -- and a
 * day ordered that way kept a 32-minute leg it did not need (2026-10-02).
 */
describe('the exact order, by dynamic programming', () => {
  /** A seeded generator, so a failure names the matrix it failed on. */
  function seeded(seed: number) {
    let state = seed;
    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
  }
  /** Drive times from scattered points, one way longer than the other at random, as one-way streets make them. */
  function scattered(stops: number, seed: number) {
    const random = seeded(seed);
    const points = Array.from({ length: stops + 1 }, () => [random() * 40, random() * 40] as const);
    return points.map(([x1, y1], from) =>
      points.map(([x2, y2], to) => (from === to ? 0 : Math.round(Math.hypot(x2 - x1, y2 - y1) * 60 * (1 + random() * 0.3)))),
    );
  }
  /** Every ordering tried: the answer the search must equal. */
  function bruteForce(matrix: number[][]) {
    const stops = Array.from({ length: matrix.length - 1 }, (_, index) => index + 1);
    let best = Number.POSITIVE_INFINITY;
    const walk = (order: number[], left: number[]) => {
      if (!left.length) {
        best = Math.min(best, routeDuration(matrix, order));
        return;
      }
      for (const next of left) walk([...order, next], left.filter((stop) => stop !== next));
    };
    walk([], stops);
    return best;
  }

  it('finds the least driving every ordering would, on days of up to nine stops', () => {
    for (let stops = 2; stops <= 9; stops += 1)
      for (let seed = 1; seed <= 4; seed += 1) {
        const matrix = scattered(stops, stops * 100 + seed);
        expect({ stops, seed, seconds: routeDuration(matrix, shortestRouteOrder(matrix)) }).toEqual({
          stops,
          seed,
          seconds: bruteForce(matrix),
        });
      }
  });

  it('is never longer than nearest-neighbour and 2-opt on a ten-stop day', () => {
    // Past every-ordering's reach in a test, so judged against the heuristic it
    // replaced: a day the old code ordered no better than the exact one.
    const matrix = scattered(10, 4242);
    const stops = Array.from({ length: 10 }, (_, index) => index + 1);
    const exact = routeDuration(matrix, shortestRouteOrder(matrix));
    for (let first = 1; first <= 10; first += 1) {
      const greedy = [first, ...stops.filter((stop) => stop !== first)];
      expect(exact).toBeLessThanOrEqual(routeDuration(matrix, greedy));
    }
  });

  it('orders thirteen stops exactly, quickly, and visits each once', () => {
    const matrix = scattered(MAX_EXACT_STOPS, 13);
    const started = performance.now();
    const order = shortestRouteOrder(matrix);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: MAX_EXACT_STOPS }, (_, index) => index + 1));
  });

  it('drives round a pair nothing measured when another order manages, and still visits every stop', () => {
    // Google leaves a pair it could not answer as Infinity. Stop 1 cannot be
    // reached from stop 2, so the day must not go 2 then 1.
    const matrix = [
      [0, 10, 5, 20],
      [10, 0, 10, 10],
      [5, Number.POSITIVE_INFINITY, 0, 10],
      [20, 10, 10, 0],
    ];
    const order = shortestRouteOrder(matrix);
    expect([...order].sort()).toEqual([1, 2, 3]);
    expect(Number.isFinite(routeDuration(matrix, order))).toBe(true);
  });

  it('still visits every stop when nothing reaches any of them from the start', () => {
    const size = 9;
    const matrix = Array.from({ length: size + 1 }, (_, from) =>
      Array.from({ length: size + 1 }, (_, to) => (from === to ? 0 : from === 0 ? Number.POSITIVE_INFINITY : 60)),
    );
    expect([...shortestRouteOrder(matrix)].sort((a, b) => a - b)).toEqual(Array.from({ length: size }, (_, index) => index + 1));
  });
});

describe('routeDuration', () => {
  it('sums the origin leg and every hop, and does not return home', () => {
    // origin->A 1, A->B 1, B->C 1. A tour would add C->origin (3) and be wrong:
    // nothing knows where a technician goes after the last inspection.
    expect(routeDuration(LINE, [1, 2, 3])).toBe(3);
  });

  it('is zero when there is nowhere to go', () => {
    expect(routeDuration(LINE, [])).toBe(0);
  });
});
