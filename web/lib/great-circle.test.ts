import { haversineMeters } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import { greatCirclePath, pathMidpoint } from './great-circle';

/**
 * Drawing the path somebody would actually travel.
 *
 * The Manila-to-Houston case is why this exists. A plain polyline between them
 * is a straight line in projected space, which runs west across Asia and Europe
 * — longer than the real route, and pointing out of the city in the wrong
 * direction. The real great circle crosses the Pacific.
 */

const MANILA = { latitude: 14.5995, longitude: 120.9842 };
const HOUSTON = { latitude: 29.7604, longitude: -95.3698 };
const DALLAS = { latitude: 32.7767, longitude: -96.797 };

describe('haversineMeters', () => {
  it('measures a known long distance', () => {
    // Manila to Houston is about 13,500 km. Ten percent is plenty to catch a
    // radians/degrees slip or a swapped axis, which are the failures that
    // actually happen here.
    const km = haversineMeters(MANILA, HOUSTON) / 1000;
    expect(km).toBeGreaterThan(13_000);
    expect(km).toBeLessThan(14_000);
  });

  it('measures a short one', () => {
    // Houston to Dallas, roughly 360 km straight line.
    const km = haversineMeters(HOUSTON, DALLAS) / 1000;
    expect(km).toBeGreaterThan(320);
    expect(km).toBeLessThan(400);
  });

  it('is zero for a point and itself, and symmetric', () => {
    expect(haversineMeters(HOUSTON, HOUSTON)).toBe(0);
    expect(haversineMeters(MANILA, HOUSTON)).toBeCloseTo(haversineMeters(HOUSTON, MANILA), 6);
  });
});

describe('greatCirclePath', () => {
  it('splits at the antimeridian instead of racing back across the map', () => {
    // The whole point. One continuous run would contain a step from about
    // +179 to -179, which Leaflet draws as a line straight across the world.
    const runs = greatCirclePath(MANILA, HOUSTON);
    expect(runs.length).toBe(2);

    for (const run of runs)
      for (let index = 1; index < run.length; index += 1) {
        const previous = run[index - 1]?.[1] ?? 0;
        const current = run[index]?.[1] ?? 0;
        expect(Math.abs(current - previous)).toBeLessThan(180);
      }
  });

  it('keeps a path that never crosses the seam in one piece', () => {
    expect(greatCirclePath(HOUSTON, DALLAS).length).toBe(1);
  });

  it('starts and ends where it was asked to', () => {
    const runs = greatCirclePath(HOUSTON, DALLAS);
    const first = runs[0]?.[0];
    const last = runs[0]?.[runs[0].length - 1];

    expect(first?.[0]).toBeCloseTo(HOUSTON.latitude, 4);
    expect(first?.[1]).toBeCloseTo(HOUSTON.longitude, 4);
    expect(last?.[0]).toBeCloseTo(DALLAS.latitude, 4);
    expect(last?.[1]).toBeCloseTo(DALLAS.longitude, 4);
  });

  it('bends north of the straight line on a long eastward path', () => {
    // A great circle from Manila to Houston passes far north of both. A
    // projected straight line would stay between their latitudes, so this is
    // what distinguishes a real curve from a lazy interpolation.
    const runs = greatCirclePath(MANILA, HOUSTON);
    const peak = Math.max(...runs.flat().map(([latitude]) => latitude));
    expect(peak).toBeGreaterThan(Math.max(MANILA.latitude, HOUSTON.latitude) + 5);
  });

  it('survives two identical points', () => {
    // sin(0) in the denominator. Returns something drawable or nothing, never
    // NaN coordinates, which Leaflet turns into a thrown error mid-render.
    for (const run of greatCirclePath(HOUSTON, HOUSTON))
      for (const [latitude, longitude] of run) {
        expect(Number.isFinite(latitude)).toBe(true);
        expect(Number.isFinite(longitude)).toBe(true);
      }
  });
});

describe('pathMidpoint', () => {
  it('lands on the longest run, not in the gap between runs', () => {
    const runs = greatCirclePath(MANILA, HOUSTON);
    const middle = pathMidpoint(runs);
    expect(middle).not.toBeNull();

    const longest = runs.reduce((best, run) => (run.length > best.length ? run : best), runs[0]!);
    expect(longest).toContainEqual(middle);
  });

  it('has nowhere to sit on an empty path', () => {
    expect(pathMidpoint([])).toBeNull();
  });
});
