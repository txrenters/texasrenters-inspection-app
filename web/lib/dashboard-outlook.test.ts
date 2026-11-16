import type { OutlookDay, OutlookQuarter } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import {
  aheadOfPlanLabel,
  daySummary,
  outlookWeeks,
  percentDone,
  quarterPace,
  scaleTop,
  totalAt,
  weekComparisonLabel,
} from './dashboard-outlook';

/** The arithmetic behind the dashboard's charts. Invented counts throughout. */

const MONDAY = '2026-11-16';
const day = (offset: number, over: Partial<OutlookDay['booked']> = {}, planned = 0): OutlookDay => ({
  date: new Date(Date.parse(`${MONDAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10),
  booked: { OCCUPIED: 0, MOVE_OUT: 0, MOVE_IN: 0, HVAC: 0, OTHER: 0, ...over },
  done: 0,
  planned,
});
const fortnight = (weekend: Partial<OutlookDay['booked']> = {}) =>
  Array.from({ length: 14 }, (_, index) =>
    index === 5 ? day(index, weekend) : day(index, index % 7 > 4 ? {} : { OCCUPIED: index + 1 }),
  );

function quarter(over: Partial<OutlookQuarter> = {}): OutlookQuarter {
  return {
    planId: 'plan-q4',
    label: 'Q4 2026',
    phase: 'CURRENT',
    planStatus: 'PUBLISHED',
    startsOn: '2026-10-01',
    endsOn: '2026-12-31',
    total: 600,
    done: 300,
    booked: 200,
    planned: 80,
    notScheduled: 20,
    dueByToday: 280,
    plan: [],
    progress: [
      { date: '2026-10-27', count: 120 },
      { date: '2026-11-17', count: 300 },
    ],
    ...over,
  };
}

describe('the schedule chart', () => {
  it('shows Monday to Friday while the weekends are empty', () => {
    const weeks = outlookWeeks(fortnight(), 2);
    expect(weeks.map((week) => week.length)).toEqual([5, 5]);
    expect(weeks[0][0].date).toBe(MONDAY);
    expect(weeks[1][4].date).toBe('2026-11-27');
  });

  it('brings the weekends back as soon as one has a visit on it', () => {
    expect(outlookWeeks(fortnight({ MOVE_OUT: 1 }), 2).map((week) => week.length)).toEqual([7, 7]);
  });

  it('cuts to the weeks asked for', () => {
    expect(outlookWeeks(fortnight(), 1)).toHaveLength(1);
  });

  it('scales to the busiest day, planned stops included, rounded up to ten', () => {
    expect(scaleTop([day(0, { OCCUPIED: 18, HVAC: 4 }, 9)])).toBe(40);
    expect(scaleTop([day(0)])).toBe(10);
  });

  it('says a day in words', () => {
    expect(daySummary(day(0, { OCCUPIED: 14, MOVE_OUT: 6, HVAC: 2 }, 3))).toBe(
      '25 visits: 14 occupied (TBP), 6 move-out, 2 HVAC, 3 planned, not booked',
    );
    expect(daySummary(day(0, { MOVE_IN: 1 }))).toBe('1 visit: 1 move-in');
    expect(daySummary(day(0))).toBe('Nothing booked');
  });
});

describe('a quarter’s pace', () => {
  it('reads a running total as of a day', () => {
    const points = quarter().progress;
    expect(totalAt(points, '2026-10-26')).toBe(0);
    expect(totalAt(points, '2026-10-27')).toBe(120);
    expect(totalAt(points, '2026-11-16')).toBe(120);
  });

  it('carries the last three weeks forward over working days', () => {
    // 180 done in the 15 working days to Tuesday the 17th: 12 a day, 60 a week.
    // 300 left is 25 working days, which ends on Tuesday, December 22.
    const pace = quarterPace(quarter(), '2026-11-17');
    expect(pace).toMatchObject({ perWeek: 60, finishOn: '2026-12-22', late: false, remaining: 300, aheadOfPlan: 20 });
    expect(pace.daysLeft).toBe(44);
  });

  it('says so when the pace lands after the quarter ends', () => {
    const slow = quarter({ progress: [{ date: '2026-10-27', count: 270 }, { date: '2026-11-17', count: 300 }] });
    expect(quarterPace(slow, '2026-11-17')).toMatchObject({ perWeek: 10, late: true });
  });

  it('gives no finish day when nothing was done lately, or nothing is left', () => {
    expect(quarterPace(quarter({ progress: [{ date: '2026-10-05', count: 300 }] }), '2026-11-17').finishOn).toBeNull();
    expect(quarterPace(quarter({ done: 600 }), '2026-11-17')).toMatchObject({ finishOn: null, remaining: 0 });
  });

  it('puts the figures in words', () => {
    expect(aheadOfPlanLabel(62)).toBe('62 ahead of the plan');
    expect(aheadOfPlanLabel(-8)).toBe('8 behind the plan');
    expect(aheadOfPlanLabel(0)).toBe('On the plan');
    expect(weekComparisonLabel(208, 196)).toBe('12 more than the last 7 days');
    expect(weekComparisonLabel(190, 196)).toBe('6 fewer than the last 7 days');
    expect(weekComparisonLabel(5, 5)).toBe('Same as the last 7 days');
    expect(percentDone(quarter())).toBe(50);
    expect(percentDone(quarter({ total: 0, done: 0 }))).toBe(0);
  });
});
