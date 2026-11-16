import { describe, expect, it } from 'vitest';

import {
  hoursAndMinutesValue,
  overtimeSeconds,
  payrollPeriodOf,
  payrollPeriodWords,
  percentText,
  trackerFigures,
} from '../src/contracts/actual-vs-budget';

// The figures are the workbook's own: "New 1111", the revenue tracker for 11/11/2026.
const minutes = (h: number, m: number) => (h * 60 + m) * 60;

describe('the revenue tracker', () => {
  it("works out Amy's day as the workbook does", () => {
    const amy = trackerFigures({ budgetCents: 40000, otRateCents: 5600, actualCents: 34798, workSeconds: minutes(8, 25) });
    expect(amy).toMatchObject({ overtimeSeconds: minutes(0, 25), addOnCents: 2333, finalBudgetCents: 42333, overCents: -7535 });
    expect(percentText(amy.share)).toBe('82.20%');
  });

  it("works out Emanuel's and Thomas's, past three hours over", () => {
    const emanuel = trackerFigures({ budgetCents: 61000, otRateCents: 8500, actualCents: 89381, workSeconds: minutes(11, 3) });
    expect(emanuel).toMatchObject({ addOnCents: 25925, finalBudgetCents: 86925, overCents: 2456 });
    expect(percentText(emanuel.share)).toBe('102.83%');
    const thomas = trackerFigures({ budgetCents: 61000, otRateCents: 8500, actualCents: 59500, workSeconds: minutes(11, 19) });
    expect(thomas).toMatchObject({ addOnCents: 28192, finalBudgetCents: 89192, overCents: -29692 });
    expect(percentText(thomas.share)).toBe('66.71%');
  });

  it('adds nothing for a day of eight hours or less, or none recorded', () => {
    expect(overtimeSeconds(minutes(8, 0))).toBe(0);
    expect(overtimeSeconds(null)).toBe(0);
    expect(trackerFigures({ budgetCents: 0, otRateCents: 8500, actualCents: 0, workSeconds: null }).share).toBeNull();
    expect(percentText(null)).toBe('');
  });
});

describe('payroll periods', () => {
  it('run a fortnight at a time from November 2', () => {
    expect(payrollPeriodOf('2026-11-11', '2026-11-02', 14)).toEqual({ from: '2026-11-02', to: '2026-11-15' });
    expect(payrollPeriodOf('2026-11-16', '2026-11-02', 14)).toEqual({ from: '2026-11-16', to: '2026-11-29' });
    expect(payrollPeriodOf('2026-10-30', '2026-11-02', 14)).toEqual({ from: '2026-10-19', to: '2026-11-01' });
  });

  it('are named as the tracker names them', () => {
    expect(payrollPeriodWords({ from: '2026-11-02', to: '2026-11-15' })).toBe('November 2-15');
    expect(payrollPeriodWords({ from: '2026-11-30', to: '2026-12-13' })).toBe('November 30 - December 13');
  });
});

describe('billable hours', () => {
  it('read the log total, the low end of a range', () => {
    expect(hoursAndMinutesValue('5h 40m')).toBe(340);
    expect(hoursAndMinutesValue('6h 00m – 7h 00m')).toBe(360);
    expect(hoursAndMinutesValue('-')).toBe(0);
  });
});
