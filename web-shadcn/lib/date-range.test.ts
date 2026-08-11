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

  it('covers the whole of the last day, so the end of a range is not truncated', () => {
    const start = new Date(dayStart('2026-08-31')!);
    const end = new Date(dayEnd('2026-08-31')!);

    expect([start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([0, 0, 0]);
    expect([end.getHours(), end.getMinutes(), end.getSeconds()]).toEqual([23, 59, 59]);

    // The bound the API is given must contain every instant of the chosen day.
    // A bare date here would exclude an inspection scheduled that afternoon.
    const afternoon = new Date(2026, 7, 31, 14, 30);
    expect(afternoon >= start && afternoon <= end).toBe(true);
  });

  it('does not mutate the caller through the shared parse', () => {
    // `dayEnd` shifts the hours on the parsed date; a second call must not see it.
    expect(dayEnd('2026-08-31')).toBe(dayEnd('2026-08-31'));
    expect(new Date(dayStart('2026-08-31')!).getHours()).toBe(0);
  });

  it('labels open-ended ranges without claiming an exclusive bound', () => {
    // "before" would be wrong: `dayEnd` includes the 31st itself.
    expect(rangeLabel('', '2026-08-31')).toMatch(/^through /);
    expect(rangeLabel('2026-08-01', '')).toMatch(/^from /);
    expect(rangeLabel('2026-08-01', '2026-08-31')).toMatch(' – ');
  });
});
