import { describe, expect, it } from 'vitest';

import { readCell, readClock, readCents, readDay, readRow } from './actual-vs-budget-cells';

describe("the log's cells take the workbook's own formats", () => {
  it('reads dates', () => {
    expect(readDay('11/11/2026')).toBe('2026-11-11');
    expect(readDay('1/5/26')).toBe('2026-01-05');
    expect(readDay('2026-11-11')).toBe('2026-11-11');
    expect(readDay('13/1/2026')).toBeNull();
    expect(readDay('N/A')).toBeNull();
  });

  it('reads times, as written in the sheet or as 24-hour', () => {
    expect(readClock('5:36 PM')).toBe('17:36');
    expect(readClock('12:06 pm')).toBe('12:06');
    expect(readClock('12:15 AM')).toBe('00:15');
    expect(readClock('17:36')).toBe('17:36');
    expect(readClock('5:36')).toBe('05:36');
    expect(readClock('25:00')).toBeNull();
  });

  it('reads money, and the dash the sheet writes for zero', () => {
    expect(readCents('78.99')).toBe(7899);
    expect(readCents('$1,078.99')).toBe(107899);
    expect(readCents('-')).toBe(0);
    expect(readCents('abc')).toBeNull();
  });

  it('says what is wrong with a cell in words', () => {
    expect(readCell('arrival', '5 o clock')).toEqual({ problem: 'Arrival Time: type a time, like 5:36 PM.' });
    expect(readCell('laborCents', 'lots')).toEqual({ problem: 'Labor Hours Income: type an amount, like 78.99.' });
    expect(readCell('workComplete', 'maybe')).toEqual({ problem: 'Is the Work Complete?: type Yes or No.' });
  });

  it('clears a cell when it is emptied, and keeps the office words in Date Posted in PW', () => {
    expect(readCell('laborCents', '  ')).toEqual({ value: null });
    expect(readCell('workComplete', 'y')).toEqual({ value: true });
    expect(readCell('postedInPw', 'N/A')).toEqual({ value: 'N/A' });
    expect(readCell('postedInPw', '11/12/2026')).toEqual({ value: '2026-11-12' });
  });

  it('reads a new row at once', () => {
    expect(readRow({ date: '11/17/2026', address: '200 Sample Rd', laborCents: '95' })).toEqual({
      input: { date: '2026-11-17', address: '200 Sample Rd', laborCents: 9500 },
    });
    expect(readRow({ date: '11/17/2026', arrival: 'soon' })).toEqual({ problem: 'Arrival Time: type a time, like 5:36 PM.' });
  });
});
