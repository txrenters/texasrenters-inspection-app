import { describe, expect, it } from 'vitest';

import {
  SEGMENT_DEFAULTS,
  computeDayLedger,
  geofenceRadiusProblem,
  secondsIn,
  withoutIntervals,
  type DayFence,
  type LedgerStretch,
  type SegmentFix,
} from '../src/contracts/time-segments';

/**
 * The rule that replaces Start job / End job.
 *
 * A technician is paid from these numbers, so the cases below are the
 * acceptance criteria the office gave on 2026-10-06, not a sample of them: the
 * clock starts inside a property's circle and stops outside it, everything
 * between two properties is general time, a phone that goes quiet indoors does
 * not stop the clock, and the day runs from the first arrival to the last
 * departure with no hole in it.
 */

const METRE = 1 / 111_320;
const START = Date.UTC(2026, 9, 6, 14, 0, 0);

/** A property in Houston, and another a given distance due north of it. */
const fence = (id: string, metresNorth = 0): DayFence => ({
  id,
  latitude: 29.76 + metresNorth * METRE,
  longitude: -95.37,
  enterRadiusMeters: SEGMENT_DEFAULTS.enterRadiusMeters,
  exitRadiusMeters: SEGMENT_DEFAULTS.exitRadiusMeters,
});

const HOME = fence('home');
/** Four kilometres up the road: a different visit, the same day. */
const SECOND = fence('second', 4_000);

const fix = (seconds: number, metresNorth: number, accuracy: number | null = 5): SegmentFix => ({
  latitude: 29.76 + metresNorth * METRE,
  longitude: -95.37,
  accuracyMeters: accuracy,
  at: START + seconds * 1000,
});

/** A stretch of fixes at one place, one every thirty seconds as the recorder makes them. */
const standing = (fromSeconds: number, forSeconds: number, metresNorth: number) =>
  Array.from({ length: Math.floor(forSeconds / 30) + 1 }, (_, index) =>
    fix(fromSeconds + index * 30, metresNorth),
  );

const shape = (stretches: readonly LedgerStretch[]) =>
  stretches.map((stretch) => `${stretch.category}:${stretch.fenceId ?? '-'}`);

describe('arriving and leaving', () => {
  it('starts the clock once the technician has been inside long enough', () => {
    const { stretches } = computeDayLedger([...standing(0, 300, 500), ...standing(330, 1_800, 5)], [HOME]);

    expect(shape(stretches)).toEqual(['ONSITE:home']);
    expect(stretches[0]!.durationSeconds).toBe(1_800);
  });

  /**
   * The dwell is a confirmation, not a charge. Backdating the stretch to the
   * fix that started the run is what stops three minutes vanishing from every
   * visit -- once on the way in and once on the way out.
   */
  it('backdates the arrival to when it happened, not when it was confirmed', () => {
    const arrivedAt = 330;
    const { stretches } = computeDayLedger(
      [...standing(0, 300, 500), ...standing(arrivedAt, 1_800, 5)],
      [HOME],
    );

    expect(stretches[0]!.startedAt).toBe(START + arrivedAt * 1000);
  });

  it('produces no false exit from an hour of standing still', () => {
    const { stretches } = computeDayLedger([...standing(0, 3_600, 3)], [HOME]);

    expect(shape(stretches)).toEqual(['ONSITE:home']);
  });

  it('does not count a drive past the door as a visit', () => {
    // Through the circle at 13 m/s: inside for well under the dwell.
    const past = Array.from({ length: 40 }, (_, index) => fix(index * 3, 500 - index * 39));

    expect(computeDayLedger(past, [HOME]).stretches).toEqual([]);
  });

  /** The office's rule in as many words: out of the circle, the clock stops. */
  it('stops the clock when they walk out of the circle and starts it again when they come back', () => {
    const { stretches } = computeDayLedger(
      [...standing(0, 600, 5), ...standing(630, 600, 80), ...standing(1_260, 600, 5)],
      [HOME],
    );

    expect(shape(stretches)).toEqual(['ONSITE:home', 'GENERAL:-', 'ONSITE:home']);
    expect(secondsIn(stretches, 'ONSITE')).toBe(630 + 600);
    expect(secondsIn(stretches, 'GENERAL')).toBe(630);
  });
});

describe('the day between properties', () => {
  /**
   * What the first version could not do. It read one job at a time, so the
   * drive from one property to the next belonged to neither, and a fortnight
   * of real work came to 36 hours on site and three minutes of anything else.
   */
  it('counts the time between two properties as general time', () => {
    const { stretches } = computeDayLedger(
      [...standing(0, 900, 5), ...standing(930, 600, 2_000), ...standing(1_560, 900, 4_003)],
      [HOME, SECOND],
    );

    expect(shape(stretches)).toEqual(['ONSITE:home', 'GENERAL:-', 'ONSITE:second']);
  });

  it('leaves no hole between the first arrival and the last departure', () => {
    const { stretches } = computeDayLedger(
      [...standing(0, 900, 5), ...standing(930, 600, 2_000), ...standing(1_560, 900, 4_003)],
      [HOME, SECOND],
    );

    for (const [index, stretch] of stretches.entries())
      if (index) expect(stretch.startedAt).toBe(stretches[index - 1]!.endedAt);
    expect(secondsIn(stretches, 'ONSITE') + secondsIn(stretches, 'GENERAL')).toBe(1_560 + 900);
  });

  /** Decided by the office: the day is first arrival to last departure. */
  it('leaves out the drive in and the drive home', () => {
    const { stretches } = computeDayLedger(
      [...standing(0, 1_200, 9_000), ...standing(1_230, 900, 5), ...standing(2_160, 1_200, 9_000)],
      [HOME],
    );

    expect(shape(stretches)).toEqual(['ONSITE:home']);
  });

  it('is empty on a day the technician reached no property at all', () => {
    expect(computeDayLedger(standing(0, 3_600, 9_000), [HOME]).stretches).toEqual([]);
  });

  it('is empty when the technician has no visit that day, wherever they stood', () => {
    expect(computeDayLedger(standing(0, 3_600, 5), []).stretches).toEqual([]);
  });

  /**
   * Two houses on one street. Without this the first visit would run on, inside
   * its own departure distance, for as long as the technician was next door.
   */
  it('ends one visit and starts the next when the technician walks to the house next door', () => {
    const NEXT_DOOR = fence('next-door', 25);
    const { stretches } = computeDayLedger(
      [...standing(0, 900, 0), ...standing(930, 900, 25)],
      [HOME, NEXT_DOOR],
    );

    expect(shape(stretches)).toEqual(['ONSITE:home', 'ONSITE:next-door']);
    expect(stretches[1]!.startedAt).toBe(START + 930 * 1000);
  });
});

describe('a phone that goes quiet', () => {
  /**
   * The commonest case by far: a phone inside a house loses the sky. Every one
   * of these used to end the visit and leave a row for the office to settle.
   */
  it('keeps the clock running when the technician is still at the property afterwards', () => {
    const { stretches } = computeDayLedger(
      // Forty minutes of nothing, then back where they were.
      [...standing(0, 600, 5), ...standing(3_000, 600, 5)],
      [HOME],
    );

    expect(shape(stretches)).toEqual(['ONSITE:home']);
    expect(stretches[0]!.durationSeconds).toBe(3_600);
    expect(stretches[0]!.quietSeconds).toBe(2_400);
  });

  /** Still inside the departure distance counts as still there. */
  it('reads the far side of the silence with the same benefit of the doubt as any other fix', () => {
    const { stretches } = computeDayLedger([...standing(0, 600, 5), ...standing(3_000, 600, 27)], [HOME]);

    expect(shape(stretches)).toEqual(['ONSITE:home']);
  });

  it('ends the visit at the last fix and calls the silence general time when they turn up elsewhere', () => {
    const { stretches } = computeDayLedger(
      [...standing(0, 600, 5), ...standing(3_000, 600, 4_003)],
      [HOME, SECOND],
    );

    expect(shape(stretches)).toEqual(['ONSITE:home', 'GENERAL:-', 'ONSITE:second']);
    expect(stretches[0]!.durationSeconds).toBe(600);
    expect(stretches[1]).toMatchObject({ durationSeconds: 2_400, quietSeconds: 2_400 });
  });

  it('throws away a fix too vague to place, and says how many', () => {
    const { discardedFixes, stretches } = computeDayLedger(
      // A tower fix half a kilometre wide, in the middle of a visit.
      [...standing(0, 600, 5), fix(630, 900, 400), ...standing(660, 600, 5)],
      [HOME],
    );

    expect(discardedFixes).toBe(1);
    expect(shape(stretches)).toEqual(['ONSITE:home']);
  });

  it('says nothing at all from a trail of one fix', () => {
    expect(computeDayLedger([fix(0, 5)], [HOME]).stretches).toEqual([]);
  });
});

describe('the boundary itself', () => {
  /**
   * Hysteresis. A technician at the kerb sits between the two radii; without
   * the band, noise alone would flip them in and out all afternoon.
   */
  it('does not flip state for a technician standing between the two radii', () => {
    const { stretches } = computeDayLedger([...standing(0, 300, 5), ...standing(330, 1_800, 25)], [HOME]);

    expect(shape(stretches)).toEqual(['ONSITE:home']);
  });

  it('does not start the clock for somebody who only ever stood between them', () => {
    expect(computeDayLedger(standing(0, 1_800, 25), [HOME]).stretches).toEqual([]);
  });
});

describe('the settings', () => {
  /** The office's number, asked for on 2026-10-06. It was 40 and 60. */
  it('arrives at 20 m and leaves at 30 m', () => {
    expect(SEGMENT_DEFAULTS.enterRadiusMeters).toBe(20);
    expect(SEGMENT_DEFAULTS.exitRadiusMeters).toBe(30);
  });

  it('ignores fixes vaguer than 25 m, far tighter than the map allows', () => {
    expect(SEGMENT_DEFAULTS.maxAccuracyMeters).toBe(25);
  });
});

/**
 * Hours a person has decided are cut out of what the trail says, so reading the
 * day again cannot put the same hour on the timesheet twice.
 */
describe('time somebody has already decided', () => {
  const stretch = (from: number, to: number, quietSeconds = 0): LedgerStretch => ({
    category: 'ONSITE',
    fenceId: 'home',
    startedAt: from * 1000,
    endedAt: to * 1000,
    durationSeconds: to - from,
    quietSeconds,
  });
  const kept = (from: number, to: number) => ({ startedAt: from * 1000, endedAt: to * 1000 });
  const spans = (stretches: LedgerStretch[]) =>
    stretches.map((piece) => [piece.startedAt / 1000, piece.endedAt / 1000]);

  it('leaves a stretch alone when nothing overlaps it', () => {
    expect(withoutIntervals([stretch(0, 600)], [kept(900, 1_200)])).toEqual([stretch(0, 600)]);
  });

  it('drops a stretch that a correction covers completely', () => {
    expect(withoutIntervals([stretch(100, 500)], [kept(0, 600)])).toEqual([]);
  });

  it('keeps the pieces either side of a correction in the middle', () => {
    expect(spans(withoutIntervals([stretch(0, 1_000)], [kept(400, 600)]))).toEqual([
      [0, 400],
      [600, 1_000],
    ]);
  });

  it('cuts around several, in whatever order they are given', () => {
    expect(
      spans(withoutIntervals([stretch(0, 1_000)], [kept(700, 800), kept(-50, 100), kept(300, 400)])),
    ).toEqual([
      [100, 300],
      [400, 700],
      [800, 1_000],
    ]);
  });

  it('never calls a piece quiet for longer than it lasted', () => {
    const [piece] = withoutIntervals([stretch(0, 1_000, 1_000)], [kept(100, 1_000)]);

    expect(piece).toMatchObject({ durationSeconds: 100, quietSeconds: 100 });
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
   * The office once asked for 6 m. A radius tighter than the error it is
   * measured with does not record a shorter visit, it records no visit.
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
