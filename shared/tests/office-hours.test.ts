import { describe, expect, it } from 'vitest';

import { isOfficeDay, isWithinOfficeHours, officeClock } from '../src/contracts/office-hours.js';
import {
  isLocationPaused,
  LOCATION_PAUSED_AFTER_MS,
  rejectLocationFix,
  usableLocationFixes,
} from '../src/contracts/technician-location.js';

/**
 * Location is recorded and shared Monday to Friday, 7 AM up to 6 PM Texas
 * time, and never on a weekend or a federal holiday (the office, 2026-11-24).
 */

const at = (iso: string) => Date.parse(iso);

describe('office hours, Texas time', () => {
  it('opens at 7 AM and closes at 6 PM on a weekday in summer (UTC-5)', () => {
    // Wednesday 26 August 2026, daylight time.
    expect(isWithinOfficeHours(at('2026-08-26T11:59:59Z'))).toBe(false); // 6:59:59 AM
    expect(isWithinOfficeHours(at('2026-08-26T12:00:00Z'))).toBe(true); // 7:00 AM
    expect(isWithinOfficeHours(at('2026-08-26T22:59:59Z'))).toBe(true); // 5:59:59 PM
    expect(isWithinOfficeHours(at('2026-08-26T23:00:00Z'))).toBe(false); // 6:00 PM
  });

  it('opens at 7 AM and closes at 6 PM on a weekday in winter (UTC-6)', () => {
    // Tuesday 1 December 2026, standard time.
    expect(isWithinOfficeHours(at('2026-12-01T12:59:00Z'))).toBe(false); // 6:59 AM
    expect(isWithinOfficeHours(at('2026-12-01T13:00:00Z'))).toBe(true); // 7:00 AM
    expect(isWithinOfficeHours(at('2026-12-01T23:59:00Z'))).toBe(true); // 5:59 PM
    expect(isWithinOfficeHours(at('2026-12-02T00:00:00Z'))).toBe(false); // 6:00 PM
  });

  it('follows the clocks on the Mondays after they change', () => {
    // 8 March 2026 the clocks went forward; 1 November 2026 they went back.
    expect(isWithinOfficeHours(at('2026-03-09T11:59:00Z'))).toBe(false);
    expect(isWithinOfficeHours(at('2026-03-09T12:00:00Z'))).toBe(true);
    expect(isWithinOfficeHours(at('2026-11-02T12:59:00Z'))).toBe(false);
    expect(isWithinOfficeHours(at('2026-11-02T13:00:00Z'))).toBe(true);
  });

  it('is closed all weekend, even at midday', () => {
    expect(isWithinOfficeHours(at('2026-11-28T18:00:00Z'))).toBe(false); // Saturday noon
    expect(isWithinOfficeHours(at('2026-11-29T18:00:00Z'))).toBe(false); // Sunday noon
  });

  it('reads the day in Texas, not in UTC', () => {
    // Friday 5:30 PM in Texas is already Saturday in UTC: still open.
    expect(isWithinOfficeHours(at('2026-11-27T23:30:00Z'))).toBe(true);
    // Sunday 6:30 PM in Texas is already Monday in UTC: still closed.
    expect(isWithinOfficeHours(at('2026-11-30T00:30:00Z'))).toBe(false);
  });

  it('is closed on federal holidays, as they are observed', () => {
    expect(isWithinOfficeHours(at('2026-11-26T18:00:00Z'))).toBe(false); // Thanksgiving
    expect(isWithinOfficeHours(at('2026-11-27T18:00:00Z'))).toBe(true); // the Friday after is a working day
    expect(isWithinOfficeHours(at('2026-12-25T18:00:00Z'))).toBe(false); // Christmas
    // Independence Day 2026 is a Saturday, so it is observed on Friday 3 July.
    expect(isWithinOfficeHours(at('2026-07-03T17:00:00Z'))).toBe(false);
    expect(isOfficeDay('2026-07-03')).toBe(false);
    expect(isOfficeDay('2026-07-02')).toBe(true);
  });

  it('never takes an unreadable time for an office-hours one', () => {
    expect(isWithinOfficeHours(Number.NaN)).toBe(false);
    expect(isWithinOfficeHours(new Date('not a date'))).toBe(false);
  });

  it('reads the office wall clock', () => {
    expect(officeClock(at('2026-11-27T23:30:00Z'))).toEqual({
      date: '2026-11-27',
      weekday: 5,
      minute: 17 * 60 + 30,
    });
  });
});

describe('a fix taken outside office hours is never sent or stored', () => {
  const fix = (recordedAt: string) => ({ latitude: 30.2672, longitude: -97.7431, recordedAt });
  const now = at('2026-11-30T18:00:00Z'); // Monday noon

  it('refuses a fix from the weekend, or after 6 PM', () => {
    expect(rejectLocationFix(fix('2026-11-28T18:00:00.000Z'), now)).toBe('OUTSIDE_OFFICE_HOURS');
    expect(rejectLocationFix(fix('2026-11-27T00:30:00.000Z'), now)).toBe('OUTSIDE_OFFICE_HOURS');
  });

  it('accepts one from office hours, even when it arrives after them', () => {
    // 5:55 PM on Friday, held back by a dead zone and sent on Monday.
    expect(rejectLocationFix(fix('2026-11-27T23:55:00.000Z'), now)).toBeNull();
  });

  it('keeps only the office-hours fixes of a mixed batch', () => {
    const friday = fix('2026-11-27T20:00:00.000Z');
    const saturday = fix('2026-11-28T20:00:00.000Z');
    const monday = fix('2026-11-30T17:00:00.000Z');
    expect(usableLocationFixes([saturday, monday, friday], now)).toEqual([friday, monday]);
  });
});

describe('silence outside office hours is not a fault on the map', () => {
  const appOpen = { connected: true, lastSeenAt: '2026-11-28T18:00:00.000Z' };

  it('does not call a weekend silence a paused location', () => {
    const saturdayNoon = at('2026-11-28T18:00:00Z');
    const lastFix = new Date(saturdayNoon - 20 * 60 * 60_000).toISOString(); // Friday afternoon
    expect(isLocationPaused({ recordedAt: lastFix, app: appOpen }, saturdayNoon)).toBe(false);
  });

  it('still calls it paused inside office hours', () => {
    const mondayNoon = at('2026-11-30T18:00:00Z');
    const lastFix = new Date(mondayNoon - LOCATION_PAUSED_AFTER_MS - 60_000).toISOString();
    expect(isLocationPaused({ recordedAt: lastFix, app: appOpen }, mondayNoon)).toBe(true);
  });
});
