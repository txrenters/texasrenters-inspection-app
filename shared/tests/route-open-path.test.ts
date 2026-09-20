import { describe, expect, it } from 'vitest';

import { routeDuration, shortestOpenPathOrder } from '../src/contracts/route-plan.js';

/** Minutes along a line: each stop is one minute from the next. */
const line = (size: number) =>
  Array.from({ length: size }, (_, from) => Array.from({ length: size }, (_, to) => Math.abs(from - to)));

/** The drive through a matrix of stops alone, in the order given. */
const between = (matrix: number[][], order: number[]) => {
  let total = 0;
  for (let index = 1; index < order.length; index += 1) total += matrix[order[index - 1]!]![order[index]!]!;
  return total;
};

describe('shortestOpenPathOrder', () => {
  /**
   * A day with no home to start from starts at its first job, so the best order walks the line
   * from one end. Listed from the middle out, so keeping the input order fails.
   */
  it('starts the day at an end of the line rather than where the list starts', () => {
    const shuffled = [
      [0, 1, 1, 2],
      [1, 0, 2, 1],
      [1, 2, 0, 3],
      [2, 1, 3, 0],
    ];
    // Stops as listed: B, C, A, D on a line A-B-C-D.
    const order = shortestOpenPathOrder(shuffled);

    expect(between(shuffled, order)).toBe(3);
    expect([order[0], order[3]].sort()).toEqual([2, 3]);
  });

  it('finds the shortest path past the exact solver’s size too', () => {
    const size = 11;
    const positions = [5, 0, 9, 2, 7, 10, 1, 8, 3, 6, 4];
    const matrix = positions.map((from) => positions.map((to) => Math.abs(from - to)));

    const order = shortestOpenPathOrder(matrix);

    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: size }, (_, index) => index));
    expect(between(matrix, order)).toBe(10);
  });

  it('has nothing to decide for one stop or none', () => {
    expect(shortestOpenPathOrder([[0]])).toEqual([0]);
    expect(shortestOpenPathOrder([])).toEqual([]);
  });

  it('agrees with routeDuration once the free start is added back', () => {
    const matrix = line(3);
    const order = shortestOpenPathOrder(matrix);
    const freeStart = [[0, 0, 0, 0], ...matrix.map((row) => [0, ...row])];

    expect(routeDuration(freeStart, order.map((index) => index + 1))).toBe(between(matrix, order));
  });
});
