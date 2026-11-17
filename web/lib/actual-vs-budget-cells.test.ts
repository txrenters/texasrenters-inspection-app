import { describe, expect, it } from 'vitest';

import { accounting, dollars, importSummary, readCell, readClock, readCents, readDay, readRow, readWorkTime } from './actual-vs-budget-cells';

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

describe('the daily sheets', () => {
  it('write dollars as the sheets do', () => {
    expect(dollars(40000, { decimals: 0 })).toBe('$400');
    expect(dollars(34798)).toBe('$347.98');
    expect(dollars(-15798)).toBe('-$157.98');
    expect(dollars(-7535, { negative: 'brackets' })).toBe('($75.35)');
    expect(dollars(293342, { decimals: 0 })).toBe('$2,933');
  });

  it('write the weekly reports as accounting figures', () => {
    expect(accounting(355000)).toBe('3,550.00');
    expect(accounting(-119186)).toBe('(1,191.86)');
    expect(accounting(0)).toBe('-');
  });

  it('read hours worked', () => {
    expect(readWorkTime('8h 25m')).toBe(30300);
    expect(readWorkTime('11h 3m')).toBe(39780);
    expect(readWorkTime('8h')).toBe(28800);
    expect(readWorkTime('8:25')).toBe(30300);
    expect(readWorkTime('lots')).toBeNull();
    expect(readWorkTime('8h 75m')).toBeNull();
  });
});

describe('what an import brought in', () => {
  it('says how many rows went on their visits, the budgets, the reports, the past logs, what was kept and the names it did not know', () => {
    expect(
      importSummary({
        imported: [{ name: 'Nathan', rowCount: 528 }],
        current: {
          logs: [
            { tab: 'Amy', technician: 'Amy Wilson', visits: 1200, officeRows: 30, keptEdits: 2, skipped: 4 },
            { tab: 'Moses', technician: 'Moses Rodriguez', visits: 900, officeRows: 5, keptEdits: 0, skipped: 0 },
          ],
          budgets: ['Amy Wilson', 'Moses Rodriguez'],
          days: 85,
          weeks: 31,
          months: 0,
          unmatched: ['Allen'],
        },
      }),
    ).toBe(
      '2,135 log rows (2,100 on their visits, 35 without one) · budgets for Amy Wilson, Moses Rodriguez · 85 days, 31 weeks, 0 months · 1 past logs · 2 cells kept as changed here · not a technician here: Allen',
    );
  });
});
