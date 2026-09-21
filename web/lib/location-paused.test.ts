import { isLocationPaused, LOCATION_PAUSED_AFTER_MS } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

/**
 * Standing still is not a fault, and the map used to say it was.
 *
 * The background task is registered with `distanceInterval: 10`, so a phone
 * that has not moved ten metres earns no fix at all, however long it sits
 * there. The rule was written on the opposite assumption -- "a handset reports
 * at least every few minutes standing still" -- so it fired on every
 * inspection long enough to be worth doing.
 *
 * On 2026-09-21 Moses moved **eleven metres in twenty-three minutes**, inside a
 * property, and the console showed "Location paused" in warning colours with
 * no speed and no heading. The office read that as the tracking being broken.
 * It was a technician doing an inspection.
 *
 * The handset reports its tracking status independently of any fix, so a fresh
 * status with no new position is exactly what stillness looks like.
 */
const now = Date.parse('2026-09-21T18:53:00.000Z');
const ago = (milliseconds: number) => new Date(now - milliseconds).toISOString();
const QUIET = LOCATION_PAUSED_AFTER_MS + 60_000;

const position = (over: Record<string, unknown> = {}) => ({
  recordedAt: ago(QUIET),
  app: { connected: true },
  tracking: { recording: 'BACKGROUND', reportedAt: ago(30_000) },
  ...over,
});

describe('whether a quiet phone has stopped recording', () => {
  it('is not paused while the phone still reports it is recording', () => {
    expect(isLocationPaused(position(), now)).toBe(false);
  });

  it('is paused when the phone says recording is off', () => {
    expect(
      isLocationPaused(
        position({ tracking: { recording: 'OFF', reportedAt: ago(30_000) } }),
        now,
      ),
    ).toBe(true);
  });

  /**
   * A status as stale as the silence says nothing either way, so the silence
   * wins: a phone that stopped reporting both is a phone that stopped.
   */
  it('is paused when the status went quiet too', () => {
    expect(
      isLocationPaused(position({ tracking: { recording: 'BACKGROUND', reportedAt: ago(QUIET) } }), now),
    ).toBe(true);
  });

  it('is paused when the phone has never reported a status', () => {
    expect(isLocationPaused(position({ tracking: null }), now)).toBe(true);
  });

  /** A recent fix is the whole answer; nothing else is consulted. */
  it('is not paused while positions are still arriving', () => {
    expect(isLocationPaused(position({ recordedAt: ago(30_000), tracking: null }), now)).toBe(false);
  });

  /** Nothing is claimed about a phone whose app is closed — that is presence. */
  it('says nothing about a technician whose app is not connected', () => {
    expect(isLocationPaused(position({ app: { connected: false } }), now)).toBe(false);
    expect(isLocationPaused(null, now)).toBe(false);
  });
});
