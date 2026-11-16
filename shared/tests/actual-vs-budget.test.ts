import { describe, expect, it } from 'vitest';

import {
  actualSeconds,
  budgetedMinutes,
  driveTimeRange,
  driveTimeTotal,
  logRangeProblem,
  revenueLogTotals,
  secondsAsHours,
  timeBudgetedTotal,
} from '../src/contracts/actual-vs-budget';

// Every expectation below is a figure from the workbook itself: Amy's tab, the
// day of 11/11/2026 (rows 377-384), unless it says otherwise.
describe('Drive Time', () => {
  it('reads a range, a single figure, and nothing', () => {
    expect(driveTimeRange('10–20 min')).toEqual({ low: 10, high: 20 });
    expect(driveTimeRange('35-50 min')).toEqual({ low: 35, high: 50 });
    expect(driveTimeRange('0 min')).toEqual({ low: 0, high: 0 });
    expect(driveTimeRange('15 mins')).toEqual({ low: 15, high: 15 });
    expect(driveTimeRange('Start')).toEqual({ low: 0, high: 0 });
    expect(driveTimeRange(null)).toEqual({ low: 0, high: 0 });
  });

  it("adds the lows and the highs, as the day's Total row does", () => {
    expect(driveTimeTotal(['Start', '0 min', '10–20 min', '15–25 min', '35–50 min', '0 min'])).toBe('60–95 min');
    // An empty day (Amy, 11/17, row 412).
    expect(driveTimeTotal([null, null])).toBe('0–0 min');
  });
});

describe('Time Budgeted', () => {
  it('reads hours and minutes however they are spaced', () => {
    expect(budgetedMinutes('2 hrs')).toEqual({ low: 120, high: 120 });
    expect(budgetedMinutes('1 hr')).toEqual({ low: 60, high: 60 });
    expect(budgetedMinutes('6hrs')).toEqual({ low: 360, high: 360 });
    expect(budgetedMinutes('30 mins')).toEqual({ low: 30, high: 30 });
    expect(budgetedMinutes('2–3 hrs')).toEqual({ low: 120, high: 180 });
    expect(budgetedMinutes('ave')).toBeNull();
    expect(budgetedMinutes('')).toBeNull();
  });

  it('totals the day as "5h 40m"', () => {
    expect(timeBudgetedTotal(['20 mins', '2 hrs', '30 mins', '30 mins', '2 hrs', '20 mins'])).toBe('5h 40m');
    // 11/12, rows 386-389.
    expect(timeBudgetedTotal(['2 hrs', '2 hrs', '3 hrs', '20 mins'])).toBe('7h 20m');
    expect(timeBudgetedTotal(['2 hrs', '2–3 hrs'])).toBe('4h 00m – 5h 00m');
    expect(timeBudgetedTotal([null, null])).toBe('-');
    expect(timeBudgetedTotal(['2 hrs', null])).toBe('2h 00m');
  });
});

describe('Actual Time', () => {
  it('is leaving minus arrival', () => {
    // 4:49 PM to 5:33 PM, row 378.
    expect(actualSeconds('16:49', '17:33')).toBe(44 * 60);
    expect(secondsAsHours(actualSeconds('12:06', '14:18')!)).toBe('2h 12m');
  });

  it('carries over midnight, as MOD(I-H,1) does', () => {
    expect(actualSeconds('23:30', '00:15')).toBe(45 * 60);
  });

  it('is nothing without both times', () => {
    expect(actualSeconds('16:49', null)).toBeNull();
    expect(actualSeconds('4:49 PM', '17:33')).toBeNull();
  });
});

describe('the Total row', () => {
  it("adds the day's money and time", () => {
    const row = (estimatedBudgetCents: number, laborCents: number | null, seconds: number | null) => ({
      driveTime: null,
      timeBudgeted: null,
      estimatedBudgetCents,
      actualSeconds: seconds,
      laborCents,
      serviceCallFeeCents: null,
      materialsCents: null,
    });
    const totals = revenueLogTotals([row(7899, 7899, 960), row(9500, 9500, 2640), row(7899, 0, null), row(7899, 0, null), row(9500, 9500, 7920), row(7899, 7899, 3720)]);
    expect(totals.estimatedBudgetCents).toBe(50596);
    expect(totals.laborCents).toBe(34798);
    expect(secondsAsHours(totals.actualSeconds)).toBe('4h 14m');
    expect(totals.serviceCallFeeCents).toBe(0);
  });
});

describe('the stretch read', () => {
  it('is a real, forward stretch of at most 62 days', () => {
    expect(logRangeProblem('2026-11-11', '2026-11-11')).toBeNull();
    expect(logRangeProblem('2026-11-12', '2026-11-11')).toBe('The first day comes after the last.');
    expect(logRangeProblem('2026-09-01', '2026-11-30')).toBe('Choose 62 days or fewer.');
    expect(logRangeProblem('11/11/2026', '2026-11-11')).toBe('Choose a first and a last day.');
  });
});
