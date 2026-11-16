import {
  OUTLOOK_VISIT_TYPES,
  type OutlookDay,
  type OutlookQuarter,
  type OutlookRunningTotal,
  type OutlookVisitType,
} from '@texasrenters/shared';

/**
 * The arithmetic behind the dashboard's charts, kept apart from their drawing.
 *
 * Every day is a `YYYY-MM-DD` Texas calendar day, as the outlook endpoint sends
 * it, and is only ever moved through UTC so no reader's own clock shifts it.
 */

const MS_PER_DAY = 86_400_000;
const toDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
export const addDays = (day: string, count: number) =>
  new Date(toDate(day).getTime() + count * MS_PER_DAY).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) =>
  Math.round((toDate(to).getTime() - toDate(from).getTime()) / MS_PER_DAY);
const isWeekend = (day: string) => [0, 6].includes(toDate(day).getUTCDay());

export const VISIT_TYPE_LABELS: Record<OutlookVisitType, string> = {
  OCCUPIED: 'Occupied (TBP)',
  MOVE_OUT: 'Move-out',
  MOVE_IN: 'Move-in',
  HVAC: 'HVAC',
  OTHER: 'Other',
};

export const bookedTotal = (day: OutlookDay) =>
  OUTLOOK_VISIT_TYPES.reduce((sum, type) => sum + day.booked[type], 0);

/** "33 visits: 14 occupied (TBP), 6 move-out, 3 planned, not booked", or "Nothing booked". */
export function daySummary(day: OutlookDay): string {
  const total = bookedTotal(day) + day.planned;
  if (!total) return 'Nothing booked';
  const parts = OUTLOOK_VISIT_TYPES.filter((type) => day.booked[type]).map(
    (type) => `${day.booked[type]} ${VISIT_TYPE_LABELS[type].toLowerCase().replace('(tbp)', '(TBP)').replace('hvac', 'HVAC')}`,
  );
  if (day.planned) parts.push(`${day.planned} planned, not booked`);
  return `${total} ${total === 1 ? 'visit' : 'visits'}: ${parts.join(', ')}`;
}

/**
 * The days in weeks of seven, Monday first, cut to `weekCount` weeks.
 *
 * Saturdays and Sundays are dropped unless one of them in the range has work
 * on it: the office works Monday to Friday, and ten empty columns in six weeks
 * would make every real one narrower. A weekend visit must still be seen, so
 * one is enough to bring the weekends back.
 */
export function outlookWeeks(days: OutlookDay[], weekCount: number): OutlookDay[][] {
  const shown = days.slice(0, weekCount * 7);
  const weekendWork = shown.some((day) => isWeekend(day.date) && bookedTotal(day) + day.planned > 0);
  const weeks: OutlookDay[][] = [];
  for (let index = 0; index < shown.length; index += 7)
    weeks.push(shown.slice(index, index + 7).filter((day) => weekendWork || !isWeekend(day.date)));
  return weeks;
}

/** The top of the chart's scale: the busiest day, rounded up to the next ten. */
export function scaleTop(days: OutlookDay[]): number {
  const busiest = Math.max(0, ...days.map((day) => bookedTotal(day) + day.planned));
  return Math.max(10, Math.ceil(busiest / 10) * 10);
}

/** A running total as of the end of `day`: the last point on or before it. */
export function totalAt(points: OutlookRunningTotal[], day: string): number {
  let count = 0;
  for (const point of points) {
    if (point.date > day) break;
    count = point.count;
  }
  return count;
}

/** How many of the days after `from`, up to and including `to`, are Monday to Friday. */
function workingDaysIn(from: string, to: string): number {
  let count = 0;
  for (let day = addDays(from, 1); day <= to; day = addDays(day, 1)) if (!isWeekend(day)) count += 1;
  return count;
}

/** The weeks of work the pace is read from. */
export const PACE_WEEKS = 3;

export interface QuarterPace {
  /** Done, less what the plan had on days before today: above zero is ahead of it. */
  aheadOfPlan: number;
  /** Visits done a week over the last `PACE_WEEKS` weeks, rounded. */
  perWeek: number;
  /** The day the quarter's last visit is done at that pace. Null when nothing was done lately, or nothing is left. */
  finishOn: string | null;
  /** That day is after the quarter ends. */
  late: boolean;
  remaining: number;
  daysLeft: number;
}

/**
 * Where a quarter is heading: the last three weeks' pace, carried forward over
 * working days until nothing is left.
 *
 * Three weeks, not the whole quarter: a slow first month should not hide that
 * the crew is now on pace, nor a fast one that it has since stalled. It is a
 * straight line and says so on the page; it knows nothing of holidays ahead.
 */
export function quarterPace(quarter: OutlookQuarter, today: string): QuarterPace {
  const since = addDays(today, -PACE_WEEKS * 7);
  const recent = totalAt(quarter.progress, today) - totalAt(quarter.progress, since);
  const perDay = recent / Math.max(1, workingDaysIn(since, today));
  const remaining = Math.max(0, quarter.total - quarter.done);
  let finishOn: string | null = null;
  if (remaining > 0 && perDay > 0) {
    let left = Math.ceil(remaining / perDay);
    finishOn = today;
    while (left > 0) {
      finishOn = addDays(finishOn, 1);
      if (!isWeekend(finishOn)) left -= 1;
    }
  }
  return {
    aheadOfPlan: quarter.done - quarter.dueByToday,
    perWeek: Math.round(perDay * 5),
    finishOn,
    late: finishOn !== null && finishOn > quarter.endsOn,
    remaining,
    daysLeft: Math.max(0, daysBetween(today, quarter.endsOn)),
  };
}

/** "62 ahead of the plan", "8 behind the plan", "On the plan". */
export function aheadOfPlanLabel(ahead: number): string {
  if (ahead > 0) return `${ahead.toLocaleString()} ahead of the plan`;
  if (ahead < 0) return `${Math.abs(ahead).toLocaleString()} behind the plan`;
  return 'On the plan';
}

/** "12 more than the last 7 days", "5 fewer than the last 7 days", "Same as the last 7 days". */
export function weekComparisonLabel(next7: number, previous7: number): string {
  const difference = next7 - previous7;
  if (!difference) return 'Same as the last 7 days';
  return `${Math.abs(difference).toLocaleString()} ${difference > 0 ? 'more' : 'fewer'} than the last 7 days`;
}

/** The share done, as a whole percentage; 0 for an empty plan. */
export const percentDone = (quarter: OutlookQuarter) =>
  quarter.total ? Math.round((quarter.done / quarter.total) * 100) : 0;
