import { describe, expect, it } from 'vitest';

import { EMPTY, formatScheduledDate } from './format';

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
