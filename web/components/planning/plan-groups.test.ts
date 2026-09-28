import { describe, expect, it } from 'vitest';

import { circlePolygon, metresBetween, planGroups, type GroupableStop } from './plan-groups';

/**
 * A quarter's days drawn as the office sketched them.
 *
 * One numbered circle per day, sized to reach that day's properties. What is
 * pinned here is the sizing: a single radius for every circle is the thing the
 * office is looking at the map to fix, not a way to draw it, because this
 * portfolio averages one neighbour within a kilometre and thirty in places.
 */

const stop = (id: string, latitude: number, longitude: number, scheduledOn: string | null): GroupableStop => ({
  id,
  latitude,
  longitude,
  scheduledOn,
});

/** Two Houston streets about 1.1km apart, and one out at Katy. */
const NEAR_A = { lat: 29.76, lon: -95.37 };
const NEAR_B = { lat: 29.77, lon: -95.37 };
const FAR = { lat: 29.786, lon: -95.824 };

describe('grouping a plan into days', () => {
  it('makes one circle per day', () => {
    const groups = planGroups([
      stop('a', NEAR_A.lat, NEAR_A.lon, '2026-10-01'),
      stop('b', NEAR_B.lat, NEAR_B.lon, '2026-10-01'),
      stop('c', FAR.lat, FAR.lon, '2026-10-02'),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.stops).toHaveLength(2);
  });

  /** The number is the day's place in the quarter, which is what is driven. */
  it('numbers them in the order the quarter is worked', () => {
    const groups = planGroups([
      stop('late', NEAR_A.lat, NEAR_A.lon, '2026-12-20'),
      stop('early', NEAR_B.lat, NEAR_B.lon, '2026-10-01'),
      stop('middle', FAR.lat, FAR.lon, '2026-11-05'),
    ]);

    expect(groups.map((group) => [group.number, group.date])).toEqual([
      [1, '2026-10-01'],
      [2, '2026-11-05'],
      [3, '2026-12-20'],
    ]);
  });

  /**
   * The point of the drawing. A day on one street draws small and a day spread
   * across the county draws wide, so the bad days are the big circles.
   */
  it('sizes each circle to reach its own properties', () => {
    const [tight] = planGroups([
      stop('a', NEAR_A.lat, NEAR_A.lon, '2026-10-01'),
      stop('b', NEAR_B.lat, NEAR_B.lon, '2026-10-01'),
    ]);
    const [spread] = planGroups([
      stop('a', NEAR_A.lat, NEAR_A.lon, '2026-10-01'),
      stop('c', FAR.lat, FAR.lon, '2026-10-01'),
    ]);

    expect(spread!.radiusMeters).toBeGreaterThan(tight!.radiusMeters * 5);
  });

  it('reaches every property in its day', () => {
    const [group] = planGroups([
      stop('a', NEAR_A.lat, NEAR_A.lon, '2026-10-01'),
      stop('b', NEAR_B.lat, NEAR_B.lon, '2026-10-01'),
      stop('c', FAR.lat, FAR.lon, '2026-10-01'),
    ]);

    for (const member of group!.stops)
      expect(metresBetween(group!, member)).toBeLessThanOrEqual(group!.radiusMeters);
  });

  /** Two tenancies at one address would otherwise draw as nothing at all. */
  it('draws a day at a single address big enough to see', () => {
    const [group] = planGroups([
      stop('a', NEAR_A.lat, NEAR_A.lon, '2026-10-01'),
      stop('b', NEAR_A.lat, NEAR_A.lon, '2026-10-01'),
    ]);

    expect(group!.radiusMeters).toBeGreaterThan(300);
  });

  /**
   * A visit with no day is not a day. Gathering them into a circle would put a
   * group on the map that nobody is going to drive.
   */
  it('leaves out the visits that have no day', () => {
    const groups = planGroups([
      stop('a', NEAR_A.lat, NEAR_A.lon, '2026-10-01'),
      stop('dayless', NEAR_B.lat, NEAR_B.lon, null),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.stops.map((s) => s.id)).toEqual(['a']);
  });

  it('ignores a property nobody has placed on the map', () => {
    const groups = planGroups([
      stop('a', NEAR_A.lat, NEAR_A.lon, '2026-10-01'),
      { id: 'nowhere', latitude: Number.NaN, longitude: Number.NaN, scheduledOn: '2026-10-01' },
    ]);

    expect(groups[0]!.stops).toHaveLength(1);
  });
});

describe('the circle it draws', () => {
  /**
   * A real circle on the ground, not a pixel one. Mapbox's own circle layer
   * takes a pixel radius, which shrinks a 5km group to a dot as somebody zooms
   * out — the opposite of what a map of distances is for.
   */
  it('comes out round rather than egg-shaped this far north', () => {
    const [group] = planGroups([
      stop('a', NEAR_A.lat, NEAR_A.lon, '2026-10-01'),
      stop('b', NEAR_B.lat, NEAR_B.lon, '2026-10-01'),
    ]);
    const ring = circlePolygon(group!);

    const distances = ring.map(([lon, lat]) => metresBetween(group!, { latitude: lat, longitude: lon }));
    const widest = Math.max(...distances);
    const narrowest = Math.min(...distances);

    // Within a couple of percent all the way round: without the latitude
    // correction it is about 15% narrower east-west at this latitude.
    expect(widest / narrowest).toBeLessThan(1.02);
  });

  it('closes', () => {
    const [group] = planGroups([stop('a', NEAR_A.lat, NEAR_A.lon, '2026-10-01')]);
    const ring = circlePolygon(group!);

    expect(ring[0]).toEqual(ring.at(-1));
  });
});

/**
 * The crew shown over the quarter they are working.
 *
 * One map rather than two was the ask, and it brings a privacy question with
 * it: where a named person was at a given minute is a fact about them, not
 * about the quarter. The plan page therefore asks for their positions with
 * `technicians:locate` — the technician map's key — and not with the planning
 * grant, which everybody who reads a schedule holds.
 *
 * Pinned by reading the page, because the alternative is standing the whole
 * planning screen up in jsdom to assert one permission string.
 */
describe('showing the crew on the plan', () => {
  it('asks for positions with the locate grant, not the planning one', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const page = readFileSync(
      join(__dirname, '..', '..', 'app', '(admin)', 'planning', 'page.tsx'),
      'utf8',
    );

    expect(page).toContain("useTechnicianLocations(has('technicians:locate'))");
    expect(page).not.toContain("useTechnicianLocations(has('planning:read'))");
    expect(page).not.toContain("useTechnicianLocations(has('technicians:read'))");
  });
});
