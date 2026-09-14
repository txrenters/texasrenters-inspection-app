import { describe, expect, it } from 'vitest';

import {
  isLocationPaused,
  LOCATION_PAUSED_AFTER_MS,
  ONLINE_WITHIN_MS,
  presenceOf,
} from '../src/contracts/technician-location.js';

/**
 * Whether somebody is out there now — asked by two different views.
 *
 * The roster list and the map markers both need this answer, and they used to
 * compute it separately. One threshold, in one place, is what keeps the list
 * from saying online while the pin beside it says otherwise.
 */

const NOW = Date.parse('2026-09-12T15:00:00.000Z');
const agoMs = (ms: number) => ({ recordedAt: new Date(NOW - ms).toISOString() });

describe('is this technician reporting now', () => {
  it('is online for a fix that just arrived', () => {
    expect(presenceOf(agoMs(30_000), NOW)).toBe('ONLINE');
  });

  it('stays online through a long silence inside a house', () => {
    // Thirty minutes, because thick walls take a phone off the network and
    // the technician has not stopped working.
    expect(presenceOf(agoMs(ONLINE_WITHIN_MS - 1000), NOW)).toBe('ONLINE');
    expect(presenceOf(agoMs(ONLINE_WITHIN_MS), NOW)).toBe('ONLINE');
  });

  it('goes offline once past the threshold', () => {
    expect(presenceOf(agoMs(ONLINE_WITHIN_MS + 1000), NOW)).toBe('OFFLINE');
    expect(presenceOf(agoMs(6 * 60 * 60_000), NOW)).toBe('OFFLINE');
  });

  it('counts somebody who has never reported as offline', () => {
    /**
     * Assigned work and never opened the app. A different story from having
     * stopped reporting, and the row says so in words — but neither is out
     * there now, and a filter with three answers to a two-answer question is
     * harder to use than the question deserves.
     */
    expect(presenceOf(null, NOW)).toBe('OFFLINE');
    expect(presenceOf(undefined, NOW)).toBe('OFFLINE');
  });

  it('does not read an unparseable timestamp as this instant', () => {
    // `Date.parse` gives NaN, and `now - NaN <= threshold` is false — but only
    // by luck of NaN comparison rules. Asserted so a later refactor cannot
    // turn a broken clock into a permanently online technician.
    expect(presenceOf({ recordedAt: 'not a date' }, NOW)).toBe('OFFLINE');
  });
});

describe('a technician working with a stalled location', () => {
  /**
   * 14 September: Moses's phone stopped recording location at 11:02 and he
   * went on starting and submitting inspections for two and a half hours. The
   * map called him offline the whole time.
   */
  const twoHoursAgo = agoMs(2 * 60 * 60_000);
  const appOpen = { connected: true, lastSeenAt: new Date(NOW).toISOString() };

  it('is online while the app is open, however old the location', () => {
    expect(presenceOf({ ...twoHoursAgo, app: appOpen }, NOW)).toBe('ONLINE');
  });

  it('says the location has stopped, so the old pin is not taken for where they are', () => {
    expect(isLocationPaused({ ...twoHoursAgo, app: appOpen }, NOW)).toBe(true);
  });

  it('does not call a location paused between ordinary fixes', () => {
    expect(isLocationPaused({ ...agoMs(LOCATION_PAUSED_AFTER_MS - 1000), app: appOpen }, NOW)).toBe(false);
  });

  it('is still offline with the app closed and no recent location', () => {
    const closed = { connected: false, lastSeenAt: null };
    expect(presenceOf({ ...twoHoursAgo, app: closed }, NOW)).toBe('OFFLINE');
    expect(isLocationPaused({ ...twoHoursAgo, app: closed }, NOW)).toBe(false);
  });

  it('falls back to the location alone when nothing is known about the app', () => {
    expect(presenceOf({ ...twoHoursAgo, app: null }, NOW)).toBe('OFFLINE');
    expect(presenceOf({ ...agoMs(60_000) }, NOW)).toBe('ONLINE');
  });
});
