import { describe, expect, it } from 'vitest';

import { fromDateValue, toDateValue } from './date-range';

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
    for (const value of ['', undefined, 'not-a-date', '2026-09']) expect(fromDateValue(value)).toBeUndefined();
  });
});
