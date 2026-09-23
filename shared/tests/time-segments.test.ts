import { describe, expect, it } from 'vitest';

import {
  SEGMENT_DEFAULTS,
  geofenceRadiusProblem,
  computeSegments,
  secondsIn,
  type SegmentFix,
  type SegmentGeofence,
} from '../src/contracts/time-segments';

/**
 * The rule that replaces Start job / End job.
 *
 * A technician is paid from these numbers and a homeowner is invoiced from
 * them, so the cases below are the acceptance criteria the office wrote, not a
 * sample of them: an hour standing still must not produce a false exit, a trip
 * to a supplier must come back as on-site, driving, general, driving, on-site,
 * and a gap must be reported rather than billed or silently closed over.
 */

/** A property in Houston, and a point a given distance due north of it. */
const PROPERTY: SegmentGeofence = {
  latitude: 29.76,
  longitude: -95.37,
  enterRadiusMeters: SEGMENT_DEFAULTS.enterRadiusMeters,
  exitRadiusMeters: SEGMENT_DEFAULTS.exitRadiusMeters,
};

const START = Date.UTC(2026, 8, 23, 14, 0, 0);
const METRE = 1 / 111_320;

const fix = (
  secondsIn_: number,
  metresNorth: number,
  speed: number | null = null,
  accuracy: number | null = 5,
): SegmentFix => ({
  latitude: PROPERTY.latitude + metresNorth * METRE,
  longitude: PROPERTY.longitude,
  accuracyMeters: accuracy,
  speedMetersPerSecond: speed,
  at: START + secondsIn_ * 1000,
});

/** A stretch of fixes at one place, one every thirty seconds as the recorder makes them. */
const standing = (fromSeconds: number, forSeconds: number, metresNorth: number, speed: number | null = 0) =>
  Array.from({ length: Math.floor(forSeconds / 30) + 1 }, (_, index) =>
    fix(fromSeconds + index * 30, metresNorth, speed),
  );

describe('arriving and leaving', () => {
  it('opens a segment once the technician has been inside long enough', () => {
    const { segments } = computeSegments(
      [...standing(0, 300, 500, 12), ...standing(330, 1_800, 5)],
      PROPERTY,
    );

    const onsite = segments.filter((segment) => segment.category === 'ONSITE');
    expect(onsite).toHaveLength(1);
    expect(onsite[0]!.durationSeconds).toBeGreaterThan(1_700);
  });

  /**
   * The dwell is a confirmation, not a charge. Backdating the segment to the
   * fix that started the run is what stops three minutes vanishing from every
   * visit -- once on the way in and once on the way out.
   */
  it('backdates the arrival to when it happened, not when it was confirmed', () => {
    const arrivedAt = 330;
    const { segments } = computeSegments(
      [...standing(0, 300, 500, 12), ...standing(arrivedAt, 1_800, 5)],
      PROPERTY,
    );

    const onsite = segments.find((segment) => segment.category === 'ONSITE')!;
    expect(onsite.startedAt).toBe(START + arrivedAt * 1000);
  });

  /** The office's criterion, in as many words. */
  it('produces no false exit from an hour of standing still', () => {
    const { segments } = computeSegments(
      [...standing(0, 120, 500, 12), ...standing(150, 3_600, 3)],
      PROPERTY,
    );

    expect(segments.filter((segment) => segment.category === 'ONSITE')).toHaveLength(1);
  });

  it('does not count a drive past the door as a visit', () => {
    // Through the geofence at 13 m/s: inside for well under the dwell.
    const past = Array.from({ length: 40 }, (_, index) => fix(index * 3, 500 - index * 39, 13));

    const { segments } = computeSegments(past, PROPERTY);

    expect(segments.filter((segment) => segment.category === 'ONSITE')).toHaveLength(0);
  });
});

describe('a trip to the supplier', () => {
  /**
   * The office's second criterion: property, store, property should read as
   * on-site, driving, general, driving, on-site.
   */
  it('reads as on-site, driving, general, driving, on-site', () => {
    const trail = [
      ...standing(0, 900, 5),                    // at the property
      ...standing(960, 600, 4_000, 15),          // driving away
      ...standing(1_620, 900, 8_000, 0),         // in the store
      ...standing(2_580, 600, 4_000, 15),        // driving back
      ...standing(3_240, 900, 5),                // back at the property
    ];

    const { segments } = computeSegments(trail, PROPERTY);

    expect(segments.map((segment) => segment.category)).toEqual([
      'ONSITE',
      'DRIVING',
      'GENERAL',
      'DRIVING',
      'ONSITE',
    ]);
  });

  it('adds both visits into one billable total', () => {
    const trail = [
      ...standing(0, 900, 5),
      ...standing(960, 600, 4_000, 15),
      ...standing(1_620, 900, 5),
    ];

    const { segments } = computeSegments(trail, PROPERTY);

    expect(secondsIn(segments, 'ONSITE')).toBeGreaterThan(1_700);
  });
});

describe('what it refuses to guess', () => {
  /**
   * A phone that died, was left in a van, or was killed by a power manager
   * leaves real work unrecorded. Answering that with zero takes money from
   * somebody who earned it, so the hole is reported for a person to settle.
   */
  it('reports a gap rather than billing through it', () => {
    const trail = [
      ...standing(0, 600, 5),
      // Forty minutes of nothing, then back where they were.
      ...standing(3_000, 600, 5),
    ];

    const { segments, gaps } = computeSegments(trail, PROPERTY);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.durationSeconds).toBeGreaterThan(2_000);
    // The two visits are counted; the hole between them is not.
    expect(secondsIn(segments, 'ONSITE')).toBeLessThan(1_400);
  });

  it('throws away a fix too vague to place, and says how many', () => {
    const trail = [
      ...standing(0, 600, 5),
      // A tower fix half a kilometre wide, in the middle of a visit.
      fix(630, 5, 0, 400),
      ...standing(660, 600, 5),
    ];

    const { discardedFixes, segments } = computeSegments(trail, PROPERTY);

    expect(discardedFixes).toBe(1);
    // And the visit is still one visit, not two.
    expect(segments.filter((segment) => segment.category === 'ONSITE')).toHaveLength(1);
  });

  it('says nothing at all from a trail of one fix', () => {
    expect(computeSegments([fix(0, 5)], PROPERTY).segments).toEqual([]);
  });
});

describe('the boundary itself', () => {
  /**
   * Hysteresis. A technician working in a garage 50 m from the rooftop pin sits
   * between the two radii; without the band, noise alone would flip them in and
   * out all afternoon and bill a dozen fragments.
   */
  it('does not flip state for a technician sitting between the two radii', () => {
    const trail = [
      ...standing(0, 300, 5),      // firmly inside
      ...standing(330, 1_800, 50), // in the band, for half an hour
    ];

    const { segments } = computeSegments(trail, PROPERTY);

    expect(segments.filter((segment) => segment.category === 'ONSITE')).toHaveLength(1);
  });

  it('still lets them leave properly once they are past the exit radius', () => {
    const trail = [
      ...standing(0, 600, 5),
      ...standing(630, 600, 200, 12),
    ];

    const { segments } = computeSegments(trail, PROPERTY);

    expect(segments.map((segment) => segment.category)).toEqual(['ONSITE', 'DRIVING']);
  });
});

describe('the settings are the measured ones', () => {
  /**
   * Pinned because they were measured against a month of real jobs rather than
   * chosen, and because the office's brief asked for 6 m -- which no consumer
   * GPS can answer, and which the replay showed would not have helped anyway.
   */
  it('enters at 40 m and leaves at 60 m', () => {
    expect(SEGMENT_DEFAULTS.enterRadiusMeters).toBe(40);
    expect(SEGMENT_DEFAULTS.exitRadiusMeters).toBe(60);
  });

  it('ignores fixes vaguer than 25 m, far tighter than the map allows', () => {
    expect(SEGMENT_DEFAULTS.maxAccuracyMeters).toBe(25);
  });
});

/**
 * What the office may set a property's radius to.
 *
 * The rule lives in shared because three places ask it — the console before it
 * sends, the server before it writes, and the phone when it reads a geofence
 * back. Three copies of "is this sensible" is how they come to disagree.
 */
describe('a geofence the office proposes', () => {
  const ok = (enter: number, exit: number) => geofenceRadiusProblem(enter, exit);

  it('accepts the defaults', () => {
    expect(ok(SEGMENT_DEFAULTS.enterRadiusMeters, SEGMENT_DEFAULTS.exitRadiusMeters)).toBeNull();
  });

  it('accepts a wide one, for a property on a large lot', () => {
    expect(ok(150, 200)).toBeNull();
  });

  /**
   * The gap is the whole point of having two numbers. Equal radii flap a
   * technician in and out on noise, and each flap ends one segment and starts
   * another — an hour on site becomes a column of one-minute rows.
   */
  it('refuses a departure distance that is not larger than the arrival one', () => {
    expect(ok(40, 40)).toMatch(/larger than the arrival distance/);
    expect(ok(60, 40)).toMatch(/larger than the arrival distance/);
  });

  /**
   * The office asked for 6 m. A radius tighter than the error it is measured
   * with does not record a shorter visit, it records no visit — 20 m lost 15 of
   * 37 jobs outright in the replay.
   */
  it('refuses a radius tighter than the handsets can measure', () => {
    expect(ok(6, 30)).toMatch(/between 10 and 500/);
  });

  it('refuses one so wide it would bill the neighbours', () => {
    expect(ok(40, 900)).toMatch(/between 10 and 500/);
  });

  it('refuses a fraction of a metre', () => {
    expect(ok(40.5, 60)).toMatch(/whole metres/);
  });

  /** Says which of the two is wrong, because the office has to fix one of them. */
  it('names the distance it is complaining about', () => {
    expect(ok(5, 60)).toContain('arrival');
    expect(ok(40, 5_000)).toContain('departure');
  });
});
