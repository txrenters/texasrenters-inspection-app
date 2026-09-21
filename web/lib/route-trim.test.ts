import { OFF_ROUTE_M, splitRouteAtPosition } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

/**
 * The road behind the technician, consumed as they drive it.
 *
 * A route is drawn once and reused for minutes, so between redraws its line
 * kept starting where they *were* — orange leading back to a road they had
 * already covered. The office (2026-09-22): "the trail should also be gone
 * with the arrow position like google map navigation".
 *
 * A straight line due east along the equator, where a degree of longitude is
 * about 111.3 km and the arithmetic is checkable by hand.
 */
const ROUTE: readonly (readonly [number, number])[] = [
  [0, 0],
  [0, 0.01],
  [0, 0.02],
];
const at = (longitude: number, latitude = 0) => ({ latitude, longitude });

describe('splitting a route where the technician has got to', () => {
  it('cuts it exactly at them, not at the next shape point', () => {
    const { travelled, ahead } = splitRouteAtPosition(ROUTE, at(0.005));

    expect(ahead[0]?.[1]).toBeCloseTo(0.005, 6);
    expect(travelled.at(-1)?.[1]).toBeCloseTo(0.005, 6);
    // Both halves are drawable lines, and together they are the whole route.
    expect(travelled.length).toBeGreaterThan(1);
    expect(ahead.at(-1)).toEqual([0, 0.02]);
  });

  it('keeps the shape points on the correct side of the cut', () => {
    const { travelled, ahead } = splitRouteAtPosition(ROUTE, at(0.015));

    expect(travelled.map((point) => point[1])).toEqual([0, 0.01, 0.015]);
    expect(ahead.map((point) => point[1])).toEqual([0.015, 0.02]);
  });

  /**
   * Past `OFF_ROUTE_M` the nearest point is not where they have got to, it is
   * a point of a road they are not on. Trimming to it would erase a route they
   * still have to drive every yard of; the redraw is what answers this.
   */
  it('trims nothing when they are off the line', () => {
    // Roughly 300 m north of a route running due east.
    const { travelled, ahead } = splitRouteAtPosition(ROUTE, at(0.01, 0.0027));

    expect(travelled).toEqual([]);
    expect(ahead).toEqual(ROUTE);
    expect(OFF_ROUTE_M).toBe(150);
  });

  /** GPS wanders twenty or thirty metres either side of a street; that is not off it. */
  it('still trims through ordinary GPS wander', () => {
    // About 55 m north of the line.
    const { travelled } = splitRouteAtPosition(ROUTE, at(0.01, 0.0005));

    expect(travelled.length).toBeGreaterThan(1);
  });

  it('gives the whole route back when there is no position yet', () => {
    expect(splitRouteAtPosition(ROUTE, null)).toEqual({ travelled: [], ahead: ROUTE });
  });

  it('has nothing to split when the route has no line', () => {
    expect(splitRouteAtPosition([], at(0.01))).toEqual({ travelled: [], ahead: [] });
    expect(splitRouteAtPosition([[0, 0]], at(0.01))).toEqual({ travelled: [], ahead: [[0, 0]] });
  });

  /** At the very start nothing is behind them, and the route is untouched ahead. */
  it('leaves a route not yet started whole', () => {
    const { travelled, ahead } = splitRouteAtPosition(ROUTE, at(0));

    expect(travelled.every((point) => point[1] === 0)).toBe(true);
    expect(ahead.at(-1)).toEqual([0, 0.02]);
  });
});
