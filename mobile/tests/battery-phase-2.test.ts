import { cachedBatteryPercent } from '../src/location/battery';
import {
  advanceMotion,
  profileFor,
  SETTLE_AFTER_MS,
  STILL_UNKNOWN,
  type Motion,
} from '../src/location/tracking-profile';
import { releasedRecordings, RELEASE_AFTER_MS } from '../src/media/recording-cleanup';
import { evaluateVideoGate } from '../src/media/video-hold';

/**
 * Battery, phase 2 (the office, 2026-10-06): location slows on site and in Low
 * Power Mode, videos wait for Wi-Fi or a charger in Low Power Mode, and a
 * recording leaves the phone once the server has it.
 */

const HOUSE = { latitude: 29.7604, longitude: -95.3698 };
/** Roughly `metres` north of the house. */
const north = (metres: number) => ({ latitude: HOUSE.latitude + metres / 111_320, longitude: HOUSE.longitude });
const T0 = Date.parse('2026-10-06T15:00:00.000Z');
const fix = (place: { latitude: number; longitude: number }, minutes: number, accuracyMeters: number | null = 8) => ({
  ...place,
  accuracyMeters,
  at: T0 + minutes * 60_000,
});

describe('how hard the phone records where it is', () => {
  const settledAt = (motion: Motion, minutes: number, lowPower = false) =>
    profileFor({ motion, lowPower, now: T0 + minutes * 60_000 });

  it('records densely while moving, and settles after five minutes in one place', () => {
    let motion = advanceMotion(STILL_UNKNOWN, fix(HOUSE, 0));
    expect(settledAt(motion, 1)).toBe('MOVING');
    // Walking round the house: within the radius, so still settling.
    motion = advanceMotion(motion, fix(north(20), 3));
    expect(settledAt(motion, SETTLE_AFTER_MS / 60_000)).toBe('SETTLED');
  });

  it('is moving again the moment a fix lands down the road', () => {
    let motion = advanceMotion(STILL_UNKNOWN, fix(HOUSE, 0));
    motion = advanceMotion(motion, fix(north(300), 10));
    expect(settledAt(motion, 10.1)).toBe('MOVING');
  });

  it('does not believe a vague fix about moving', () => {
    // A tower fix 300 m off, ±400 m, says nothing about anyone driving away.
    let motion = advanceMotion(STILL_UNKNOWN, fix(HOUSE, 0));
    motion = advanceMotion(motion, fix(north(300), 6, 400));
    expect(settledAt(motion, 6)).toBe('SETTLED');
  });

  it('settles at once in Low Power Mode, wherever the technician is', () => {
    const motion = advanceMotion(STILL_UNKNOWN, fix(HOUSE, 0));
    expect(settledAt(motion, 0, true)).toBe('SETTLED');
    expect(profileFor({ motion: STILL_UNKNOWN, lowPower: true, now: T0 })).toBe('SETTLED');
  });

  it('starts dense when nothing is known yet', () => {
    expect(profileFor({ motion: STILL_UNKNOWN, lowPower: false, now: T0 })).toBe('MOVING');
  });
});

describe('a video in Low Power Mode', () => {
  const saving = { lowPower: true, charging: false };

  it('waits for Wi-Fi or a charger on mobile data', () => {
    expect(evaluateVideoGate({ power: saving, connectivity: { isMetered: true }, sendNow: false })).toMatchObject({
      allowed: false,
    });
  });

  it('goes on Wi-Fi, on a charger, or when the technician says send now', () => {
    expect(evaluateVideoGate({ power: saving, connectivity: { isMetered: false }, sendNow: false }).allowed).toBe(true);
    expect(
      evaluateVideoGate({ power: { lowPower: true, charging: true }, connectivity: { isMetered: true }, sendNow: false })
        .allowed,
    ).toBe(true);
    expect(evaluateVideoGate({ power: saving, connectivity: { isMetered: true }, sendNow: true }).allowed).toBe(true);
  });

  it('is never held with the battery at ease', () => {
    expect(
      evaluateVideoGate({ power: { lowPower: false, charging: false }, connectivity: { isMetered: true }, sendNow: false })
        .allowed,
    ).toBe(true);
  });
});

describe('recordings the server already has', () => {
  const now = T0;
  const recorded = (id: string, hoursAgo: number) => ({
    id,
    recordedAt: new Date(now - hoursAgo * 60 * 60_000).toISOString(),
  });

  it('are released once nothing queues them and a day has passed', () => {
    expect(
      releasedRecordings(
        [recorded('sent-last-week', 24 * 7), recorded('still-queued', 48), recorded('just-saved', 0.01)],
        [{ mediaId: 'still-queued' }],
        now,
      ),
    ).toEqual(['sent-last-week']);
  });

  it('keep a day of grace', () => {
    expect(RELEASE_AFTER_MS).toBe(24 * 60 * 60_000);
    expect(releasedRecordings([recorded('yesterday-evening', 20)], [], now)).toEqual([]);
  });
});

describe('the charge stamped on each fix', () => {
  it('is asked of the phone at most once a minute', async () => {
    const read = jest.fn().mockResolvedValue(0.42);
    await expect(cachedBatteryPercent(60_000, T0, read)).resolves.toBe(42);
    await expect(cachedBatteryPercent(60_000, T0 + 30_000, read)).resolves.toBe(42);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValue(0.41);
    await expect(cachedBatteryPercent(60_000, T0 + 61_000, read)).resolves.toBe(41);
  });
});
