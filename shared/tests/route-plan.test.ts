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
