import { describe, expect, it } from 'vitest';

import {
  isRescheduleMonday,
  plannedVisitDaysOfQuarter,
  quarterWeekIndex,
  weekStartOf,
  weeklyZoneTechnicians,
  zoneNumberOf,
} from '../src/contracts/zone-rotation.js';
import { workingDaysOfQuarter } from '../src/contracts/quarter-plan.js';

const Q4_2026 = { year: 2026, quarter: 4 as const };

describe('a zone as the tenant report writes it', () => {
  it('is its number, however it is written', () => {
    expect(zoneNumberOf('3')).toBe('3');
    expect(zoneNumberOf('Zone 3')).toBe('3');
    expect(zoneNumberOf(' zone 03 ')).toBe('3');
  });

  it('is nothing when the report has none', () => {
    expect(zoneNumberOf('Not Set')).toBeNull();
    expect(zoneNumberOf('')).toBeNull();
    expect(zoneNumberOf(null)).toBeNull();
  });
});

describe('the weeks of a quarter', () => {
  /** Q4 2026 starts on a Thursday: its first week is 1-2 October, its second starts Monday 5 October. */
  it('counts calendar weeks, Monday to Sunday, from the week the quarter starts in', () => {
    expect(quarterWeekIndex('2026-10-01', Q4_2026)).toBe(0);
    expect(quarterWeekIndex('2026-10-02', Q4_2026)).toBe(0);
    expect(quarterWeekIndex('2026-10-05', Q4_2026)).toBe(1);
    expect(quarterWeekIndex('2026-10-16', Q4_2026)).toBe(2);
    expect(weekStartOf('2026-10-16')).toBe('2026-10-12');
  });
});

/**
 * The office keeps Mondays free for the visits rescheduled from the week before
 * (2026-09-16), from the second week on: the first has nothing to reschedule.
 */
describe('the Mondays kept for rescheduled visits', () => {
  it('keeps every Monday from the second week on', () => {
    expect(isRescheduleMonday('2026-10-05', Q4_2026)).toBe(true);
    expect(isRescheduleMonday('2026-10-19', Q4_2026)).toBe(true);
    expect(isRescheduleMonday('2026-10-06', Q4_2026)).toBe(false);
  });

  it('plans a Monday that falls in the quarter’s first week', () => {
    // Q2 2026 starts on Wednesday 1 April; Q3 2025 on Tuesday 1 July. Q2 2024 starts on Monday 1 April.
    expect(isRescheduleMonday('2024-04-01', { year: 2024, quarter: 2 })).toBe(false);
    expect(isRescheduleMonday('2024-04-08', { year: 2024, quarter: 2 })).toBe(true);
  });

  it('plans visits on the working days less those Mondays', () => {
    const planned = plannedVisitDaysOfQuarter(Q4_2026);
    const mondays = workingDaysOfQuarter(Q4_2026).filter((date) => new Date(`${date}T00:00:00Z`).getUTCDay() === 1);

    // Q4 2026's working Mondays: 13 Mondays, less Columbus Day on the 12th of October.
    expect(mondays).toHaveLength(12);
    expect(planned).toHaveLength(workingDaysOfQuarter(Q4_2026).length - 12);
    expect(planned.some((date) => new Date(`${date}T00:00:00Z`).getUTCDay() === 1)).toBe(false);
  });
});

/**
 * The office's example (2026-09-16): Moses on zone 1, Kevin on 2, Emanuel on 3,
 * and everyone moves one zone on each week.
 */
describe('who has which zone each week', () => {
  const crew = ['moses', 'kevin', 'emanuel'];

  it('starts the crew on the first zones, in order', () => {
    expect(weeklyZoneTechnicians(crew, ['1', '2', '3', '4'], 0)).toEqual({ '1': 'moses', '2': 'kevin', '3': 'emanuel' });
  });

  it('moves everyone one zone on each week, round the circle', () => {
    expect(weeklyZoneTechnicians(crew, ['1', '2', '3', '4'], 1)).toEqual({ '2': 'moses', '3': 'kevin', '4': 'emanuel' });
    expect(weeklyZoneTechnicians(crew, ['1', '2', '3', '4'], 3)).toEqual({ '4': 'moses', '1': 'kevin', '2': 'emanuel' });
    expect(weeklyZoneTechnicians(crew, ['1', '2', '3', '4'], 4)).toEqual(weeklyZoneTechnicians(crew, ['1', '2', '3', '4'], 0));
  });

  it('leaves a different zone without anybody each week when zones outnumber the crew', () => {
    const empty = [0, 1, 2, 3].map((week) =>
      ['1', '2', '3', '4'].find((zone) => !(zone in weeklyZoneTechnicians(crew, ['1', '2', '3', '4'], week))),
    );
    expect(empty).toEqual(['4', '1', '2', '3']);
  });

  it('gives a different person the week off when the crew outnumbers the zones', () => {
    expect(Object.values(weeklyZoneTechnicians(crew, ['1', '2'], 0))).toEqual(['moses', 'kevin']);
    expect(Object.values(weeklyZoneTechnicians(crew, ['1', '2'], 1)).sort()).toEqual(['emanuel', 'moses']);
  });
});
