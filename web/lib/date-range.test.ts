import { describe, expect, it } from 'vitest';

import { dayEnd, dayStart, fromDateValue, rangeLabel, toDateValue } from './date-range';

describe('date range', () => {
  it('round-trips a calendar date through the local timezone', () => {
    // The trap: `new Date('2026-09-01').toISOString()` is UTC midnight, which is
    // 31 August anywhere west of Greenwich. Parsing and formatting must both go
    // through local parts, so the day the reader picked is the day they get back.
    expect(toDateValue(fromDateValue('2026-09-01')!)).toBe('2026-09-01');
    expect(toDateValue(new Date(2026, 8, 1))).toBe('2026-09-01');

    const parsed = fromDateValue('2026-09-01')!;
    expect([parsed.getFullYear(), parsed.getMonth(), parsed.getDate()]).toEqual([2026, 8, 1]);
    expect([parsed.getHours(), parsed.getMinutes()]).toEqual([0, 0]);
  });

  it('rejects blanks and malformed values rather than inventing a date', () => {
    // These reach the query builder as `undefined` and drop out of the request.
    for (const value of ['', undefined, 'not-a-date', '2026-09']) {
      expect(fromDateValue(value)).toBeUndefined();
      expect(dayStart(value)).toBeUndefined();
      expect(dayEnd(value)).toBeUndefined();
    }
  });

  /** The office, 2026-10-06: "we are not using Manila time". A day picked is the field's day. */
  it('bounds a picked day by Texas midnights, whoever is reading', () => {
    expect(dayStart('2026-08-31')).toBe('2026-08-31T05:00:00.000Z');
    expect(dayEnd('2026-08-31')).toBe('2026-09-01T04:59:59.999Z');
    // An hour later once Texas is back on standard time.
    expect(dayStart('2026-12-01')).toBe('2026-12-01T06:00:00.000Z');
  });

  it('covers the whole of the last day, so the end of a range is not truncated', () => {
    // 2:30 PM in Houston on the 31st, and a minute before its midnight: both the 31st's.
    for (const instant of ['2026-08-31T19:30:00.000Z', '2026-09-01T04:59:00.000Z'])
      expect(instant >= dayStart('2026-08-31')! && instant <= dayEnd('2026-08-31')!).toBe(true);
    // Midnight in Houston is the next day.
    expect('2026-09-01T05:00:00.000Z' <= dayEnd('2026-08-31')!).toBe(false);
  });

  it('labels open-ended ranges without claiming an exclusive bound', () => {
    // "before" would be wrong: `dayEnd` includes the 31st itself.
    expect(rangeLabel('', '2026-08-31')).toMatch(/^through /);
    expect(rangeLabel('2026-08-01', '')).toMatch(/^from /);
    expect(rangeLabel('2026-08-01', '2026-08-31')).toMatch(' – ');
  });
});
