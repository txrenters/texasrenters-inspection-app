import { describe, expect, it } from 'vitest';

import { metresBetween } from './plan-groups';

describe('distance on the ground', () => {
  it('is about 1.1 km between two Houston streets a hundredth of a degree apart', () => {
    expect(metresBetween({ latitude: 29.76, longitude: -95.37 }, { latitude: 29.77, longitude: -95.37 })).toBeCloseTo(1112, -1);
  });

  it('is nothing between a point and itself', () => {
    expect(metresBetween({ latitude: 29.76, longitude: -95.37 }, { latitude: 29.76, longitude: -95.37 })).toBe(0);
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
  /**
   * The plan's maps draw the crew through the shared map now, which asks for
   * positions behind `technicians:locate` itself -- see `console-map.test.tsx`,
   * which renders it with the grant absent and present and was checked to fail
   * with the gate removed.
   *
   * What is left to guard here is the page growing its own request again. It
   * used to make one, and a copy made under the planning grant would hand live
   * staff positions to anybody who can read a schedule.
   */
  it('leaves the crew to the shared map, and asks for no positions of its own', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const page = readFileSync(
      join(__dirname, '..', '..', 'app', '(admin)', 'planning', 'page.tsx'),
      'utf8',
    );

    expect(page).not.toContain('useTechnicianLocations');
  });
});
