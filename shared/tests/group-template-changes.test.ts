import { describe, expect, it } from 'vitest';

import {
  insertionInto,
  insertionNeighbours,
  nearestGroups,
} from '../src/contracts/group-template-changes.js';
import { estimatedDriveMinutes } from '../src/contracts/quarter-assignment.js';

/**
 * Which group a property new to the benefit package would fit (the office,
 * 2026-10-15): "a suggestion where or what group we can let it grouped based on
 * the driving time".
 */

/** A point along one street: `x` minutes from its start. */
const at = (x: number) => ({ latitude: 0, longitude: x });
/** Minutes along that street, so every expectation can be worked out by hand. */
const along = (from: { longitude: number }, to: { longitude: number }) => Math.abs(from.longitude - to.longitude);

describe('where a property adds least to a group', () => {
  it('goes between two members it lies between, at no extra driving', () => {
    expect(insertionInto(at(5), [at(0), at(10), at(20)], along)).toEqual({ at: 1, addedMinutes: 0 });
  });

  it('goes at either end when that is cheapest: nobody drives back to the first', () => {
    expect(insertionInto(at(-4), [at(0), at(10)], along)).toEqual({ at: 0, addedMinutes: 4 });
    expect(insertionInto(at(13), [at(0), at(10)], along)).toEqual({ at: 2, addedMinutes: 3 });
  });

  it('adds nothing to an empty group', () => {
    expect(insertionInto(at(3), [], along)).toEqual({ at: 0, addedMinutes: 0 });
  });

  it('names the members either side of its place', () => {
    expect(insertionNeighbours(0, 3)).toEqual({ before: null, after: 0 });
    expect(insertionNeighbours(1, 3)).toEqual({ before: 0, after: 1 });
    expect(insertionNeighbours(3, 3)).toEqual({ before: 2, after: null });
  });
});

describe('the groups a newcomer would fit best', () => {
  const groups = [
    { id: 'far', points: [at(100), at(110)] },
    { id: 'through', points: [at(0), at(20)] },
    { id: 'beside', points: [at(14), at(16)] },
    { id: 'empty', points: [] },
  ];

  it('ranks them by the driving each would add, least first', () => {
    const ranked = nearestGroups(at(10), groups, { drive: along });
    expect(ranked.map((group) => group.groupId)).toEqual(['through', 'beside', 'far']);
    expect(ranked[0]).toMatchObject({ at: 1, addedMinutes: 0 });
    expect(ranked[1]).toMatchObject({ at: 0, addedMinutes: 4 });
  });

  it('names each group’s nearest member and the drive from it', () => {
    const [, beside] = nearestGroups(at(10), groups, { drive: along });
    expect(beside!.nearest).toEqual({ index: 0, minutes: 4 });
  });

  it('never offers an empty group: it has nowhere to measure from', () => {
    expect(nearestGroups(at(10), groups, { drive: along, limit: 10 }).map((group) => group.groupId)).not.toContain('empty');
  });

  it('offers as many as asked for, three when not told', () => {
    expect(nearestGroups(at(10), groups, { drive: along, limit: 1 })).toHaveLength(1);
    expect(nearestGroups(at(10), groups, { drive: along })).toHaveLength(3);
  });

  it('breaks a tie with the nearer member', () => {
    const tied = [
      { id: 'two-away', points: [at(12)] },
      { id: 'right-here', points: [at(10)] },
      { id: 'also-two', points: [at(8)] },
    ];
    // Both ends of a one-member group cost the same; the nearer member wins.
    expect(nearestGroups(at(10), tied, { drive: along })[0]!.groupId).toBe('right-here');
  });

  it('times with the planner’s own estimate when given no other', () => {
    const houston = { latitude: 29.7604, longitude: -95.3698 };
    const nearby = { latitude: 29.77, longitude: -95.37 };
    const [only] = nearestGroups(houston, [{ id: 'g', points: [nearby] }]);
    expect(only!.addedMinutes).toBeCloseTo(estimatedDriveMinutes(houston, nearby), 6);
  });
});
