import { describe, expect, it } from 'vitest';

import { EMPTY, formatDate, formatDateTime, formatScheduledDate, formatTime } from './format';

/**
 * An inspection booked in Jobber for September 3rd showed as September 2nd in
 * the console. Nothing was stored wrong: `scheduledAt` is a Postgres `date`
 * serialised as midnight UTC, and `Intl.DateTimeFormat` with no `timeZone`
 * renders that instant where the reader is standing. Midnight UTC is the
 * previous evening anywhere west of Greenwich, which is every office this
 * system serves — and the reason it went unnoticed is that the person looking
 * was in Manila, where +8 happens to land back on the right day.
 */
describe('a scheduled day', () => {
  it('is the stored day, not the reader\u2019s', () => {
    expect(formatScheduledDate('2026-09-03T00:00:00.000Z')).toBe('Sep 3, 2026');
  });

  it('does not drift across a year boundary either', () => {
    // The same failure at its most visible: a January 1st visit filed to the
    // previous year.
    expect(formatScheduledDate('2027-01-01T00:00:00.000Z')).toBe('Jan 1, 2027');
  });

  it('prints no time, because the column holds none', () => {
    // `formatDateTime` printed one, so every row in the list claimed 8:00 AM —
    // which is what midnight UTC looks like from Manila, and a time nobody
    // scheduled.
    expect(formatScheduledDate('2026-09-03T00:00:00.000Z')).not.toMatch(/\d:\d\d/);
  });

  it('is the em dash when there is no date at all', () => {
    expect(formatScheduledDate(null)).toBe(EMPTY);
    expect(formatScheduledDate(undefined)).toBe(EMPTY);
    expect(formatScheduledDate('not a date')).toBe(EMPTY);
  });
});

/**
 * A moment -- a time somebody started, a link's expiry -- in Texas time,
 * whoever reads it (the office, 2026-10-06: "we are not using Manila time").
 * These run in the reader's zone; the expected values are Houston's.
 */
describe('a moment', () => {
  it('is printed in Texas time', () => {
    // 2 PM UTC is 9 AM in Houston in October, 10 PM in Manila.
    expect(formatDateTime('2026-10-06T14:00:00.000Z')).toBe('Oct 6, 2026, 9:00 AM');
    // An hour's difference in winter.
    expect(formatDateTime('2026-12-01T15:00:00.000Z')).toBe('Dec 1, 2026, 9:00 AM');
  });

  it('has its clock time read in Texas too, when the day is said elsewhere', () => {
    expect(formatTime('2026-10-06T14:30:00.000Z')).toBe('9:30 AM');
    expect(formatTime(null)).toBe(EMPTY);
  });

  it('is on its Texas date, which an evening there is not in Manila', () => {
    // 9 PM in Houston on the 5th is already the 6th in Manila and in UTC.
    expect(formatDate('2026-10-06T02:00:00.000Z')).toBe('Oct 5, 2026');
  });
});

describe('a day written some other way', () => {
  it('keeps its date', () => {
    // A Propertyware report can leave a date it could not read as written.
    expect(formatScheduledDate('10/1/2015')).toBe('Oct 1, 2015');
  });
});
