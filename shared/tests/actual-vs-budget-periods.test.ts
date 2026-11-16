import { describe, expect, it } from 'vitest';

import { monthEnd, monthWeeks, monthWords, weekOf, weekWords } from '../src/contracts/actual-vs-budget';

// The workbook's own weekly tabs name every expectation here.
describe("a month's weeks", () => {
  it('divide October as the workbook does: Oct 1-2, 5-9, 12-16, 19-23, 26-30', () => {
    expect(monthWeeks('2026-10').map(weekWords)).toEqual([
      'OCTOBER 1-2, 2026',
      'OCTOBER 5-9, 2026',
      'OCTOBER 12-16, 2026',
      'OCTOBER 19-23, 2026',
      'OCTOBER 26-30, 2026',
    ]);
  });

  it('end August with a week of its last Monday only, and start September on the Tuesday', () => {
    expect(weekWords(monthWeeks('2026-08').at(-1)!)).toBe('AUGUST 31, 2026');
    expect(weekWords(monthWeeks('2026-09')[0]!)).toBe('SEPTEMBER 1-4, 2026');
    expect(weekWords(monthWeeks('2026-09').at(-1)!)).toBe('SEPTEMBER 28-30, 2026');
  });

  it("put a weekend a month opens on into its first week: August 1-2 is a Saturday and Sunday", () => {
    expect(monthWeeks('2026-08')[0]).toEqual({ from: '2026-08-01', to: '2026-08-09' });
    expect(weekWords(monthWeeks('2026-08')[0]!)).toBe('AUGUST 3-7, 2026');
  });

  it('keep every day of the month in exactly one week', () => {
    for (const month of ['2026-02', '2026-08', '2026-11', '2027-01']) {
      const weeks = monthWeeks(month);
      expect(weeks[0]!.from).toBe(`${month}-01`);
      expect(weeks.at(-1)!.to).toBe(monthEnd(month));
      for (let i = 1; i < weeks.length; i++) expect(Date.parse(weeks[i]!.from) - Date.parse(weeks[i - 1]!.to)).toBe(86_400_000);
    }
  });

  it('find the week a day is in, weekends included', () => {
    // November 1, 2026 is a Sunday, so it opens the week of the 2nd-6th.
    expect(weekOf('2026-11-04')).toEqual({ from: '2026-11-01', to: '2026-11-08' });
    expect(weekOf('2026-11-01')).toEqual({ from: '2026-11-01', to: '2026-11-08' });
    expect(weekWords(weekOf('2026-11-04'))).toBe('NOVEMBER 2-6, 2026');
    expect(weekOf('2026-11-14')).toEqual({ from: '2026-11-09', to: '2026-11-15' });
  });

  it('name the month as the workbook does', () => {
    expect(monthWords('2026-10')).toBe('Month of October');
  });
});
