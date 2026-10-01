import { describe, expect, it } from 'vitest';

import {
  simplifyPath,
  trailMeters,
  trailSegments,
  TRAIL_GAP_MS,
  withLivePosition,
  type TrailFix,
} from '../src/contracts/technician-trail.js';

/** About 111m of latitude per 0.001 degree, near Houston. */
const START = { latitude: 29.76, longitude: -95.37 };
const MINUTE = 60_000;
const T0 = Date.parse('2026-10-02T14:00:00.000Z');

const fix = (
  minutes: number,
  northDegrees: number,
  extra: Partial<TrailFix> = {},
): TrailFix => ({
  latitude: START.latitude + northDegrees,
  longitude: START.longitude,
  recordedAt: new Date(T0 + minutes * MINUTE).toISOString(),
  ...extra,
});

describe('trailSegments', () => {
  it('draws a day of fixes as one line', () => {
    const segments = trailSegments([fix(0, 0), fix(1, 0.005), fix(2, 0.01)]);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.startedAt).toBe(fix(0, 0).recordedAt);
    expect(segments[0]!.endedAt).toBe(fix(2, 0).recordedAt);
    // A straight drive keeps only its ends.
    expect(segments[0]!.points).toEqual([
      [START.latitude, START.longitude],
      [START.latitude + 0.01, START.longitude],
    ]);
  });

  it('orders fixes that arrived out of order', () => {
    const segments = trailSegments([fix(2, 0.01), fix(0, 0), fix(1, 0.005, { longitude: START.longitude + 0.003 })]);
    expect(segments[0]!.points[0]).toEqual([START.latitude, START.longitude]);
    expect(segments[0]!.points.at(-1)).toEqual([START.latitude + 0.01, START.longitude]);
  });

  it('leaves out a vague fix rather than zig-zagging across the street', () => {
    const segments = trailSegments([
      fix(0, 0),
      fix(1, 0.002, { longitude: START.longitude + 0.004, accuracyMeters: 450 }),
      fix(2, 0.004, { accuracyMeters: 12 }),
    ]);
    expect(segments[0]!.points).toEqual([
      [START.latitude, START.longitude],
      [START.latitude + 0.004, START.longitude],
    ]);
  });

  it('leaves out a fix no car could have reached', () => {
    // 0.5 degrees north and back inside two minutes: about 55km a minute.
    const segments = trailSegments([fix(0, 0), fix(1, 0.5), fix(2, 0.002)]);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.points.every(([latitude]) => latitude < START.latitude + 0.01)).toBe(true);
  });

  it('breaks the line where the phone went quiet and came back across town', () => {
    const quiet = TRAIL_GAP_MS / MINUTE + 5;
    const segments = trailSegments([fix(0, 0), fix(1, 0.002), fix(1 + quiet, 0.05), fix(2 + quiet, 0.052)]);
    expect(segments).toHaveLength(2);
    expect(segments[1]!.points[0]).toEqual([START.latitude + 0.05, START.longitude]);
  });

  it('keeps the line joined through a long stay in one place', () => {
    // An hour inside a property, then on: a visit, not a gap.
    const segments = trailSegments([fix(0, 0), fix(1, 0.002), fix(61, 0.0021), fix(62, 0.004)]);
    expect(segments).toHaveLength(1);
  });

  it('draws nothing for a stretch of a single fix', () => {
    const quiet = TRAIL_GAP_MS / MINUTE + 5;
    expect(trailSegments([fix(0, 0), fix(quiet, 0.05)])).toEqual([]);
    expect(trailSegments([])).toEqual([]);
  });

  it('ignores a fix at null island and one with no time', () => {
    const segments = trailSegments([
      fix(0, 0),
      { latitude: 0, longitude: 0, recordedAt: fix(1, 0).recordedAt },
      { ...fix(2, 0.003), recordedAt: 'not a time' },
      fix(3, 0.004),
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.points).toHaveLength(2);
  });
});

describe('simplifyPath', () => {
  it('keeps a bend and drops the points along a straight road', () => {
    const path: [number, number][] = [
      [29.76, -95.37],
      [29.761, -95.37],
      [29.762, -95.37],
      [29.762, -95.369],
      [29.762, -95.368],
    ];
    expect(simplifyPath(path, 5)).toEqual([
      [29.76, -95.37],
      [29.762, -95.37],
      [29.762, -95.368],
    ]);
  });

  it('hands back a path too short to simplify', () => {
    expect(simplifyPath([[29.76, -95.37]], 5)).toEqual([[29.76, -95.37]]);
  });
});

describe('withLivePosition', () => {
  const segments = trailSegments([fix(0, 0), fix(1, 0.002)]);

  it('carries the line on to where they are now', () => {
    const now = fix(2, 0.004);
    const joined = withLivePosition(segments, now);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.points.at(-1)).toEqual([now.latitude, now.longitude]);
    expect(joined[0]!.endedAt).toBe(now.recordedAt);
  });

  it('leaves the trail alone for a position it already holds, an older one, or none', () => {
    expect(withLivePosition(segments, fix(1, 0.002))).toBe(segments);
    expect(withLivePosition(segments, fix(0, 0.001))).toBe(segments);
    expect(withLivePosition(segments, null)).toBe(segments);
    expect(withLivePosition([], fix(5, 0.01))).toEqual([]);
  });

  it('does not join a vague position or one across a long silence far away', () => {
    expect(withLivePosition(segments, fix(2, 0.004, { accuracyMeters: 300 }))).toBe(segments);
    const quiet = TRAIL_GAP_MS / MINUTE + 5;
    expect(withLivePosition(segments, fix(1 + quiet, 0.05))).toBe(segments);
  });
});

describe('trailMeters', () => {
  it('adds up every segment', () => {
    const quiet = TRAIL_GAP_MS / MINUTE + 5;
    const segments = trailSegments([fix(0, 0), fix(1, 0.001), fix(1 + quiet, 0.05), fix(2 + quiet, 0.051)]);
    // Two stretches of about 111m each.
    expect(trailMeters(segments)).toBeGreaterThan(215);
    expect(trailMeters(segments)).toBeLessThan(230);
  });
});
