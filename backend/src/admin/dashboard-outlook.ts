import {
  OUTLOOK_DAYS,
  OUTLOOK_VISIT_TYPES,
  type AdminDashboardOutlook,
  type OutlookDay,
  type OutlookQuarter,
  type OutlookRunningTotal,
  type OutlookTechnicianLoad,
  type OutlookVisitType,
  type Quarter,
  nextQuarter,
  previousQuarter,
  quarterEnd,
  quarterLabel,
  quarterOf,
} from '@texasrenters/shared';

import { businessDate } from '../common/business-day';

/**
 * The dashboard's forward view, worked out from rows the service has read.
 *
 * Pure, so the arithmetic is tested without a database: which Texas day a
 * visit falls on, what counts as booked, and what a quarter still owes.
 * Every day here is a `YYYY-MM-DD` Texas calendar day. `scheduledAt` and a
 * stop's `scheduledOn` are date columns, so their UTC date IS that day.
 */

const MS_PER_DAY = 86_400_000;

export const isoDay = (date: Date) => date.toISOString().slice(0, 10);
export const dayToDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
export const addDays = (day: string, count: number) =>
  isoDay(new Date(dayToDate(day).getTime() + count * MS_PER_DAY));
/** 0 is Sunday, as `Date` has it. */
const weekday = (day: string) => dayToDate(day).getUTCDay();
export const mondayOf = (day: string) => addDays(day, -((weekday(day) + 6) % 7));

/** The next `count` Monday-to-Friday days, today included when it is one. */
export function workingDaysFrom(day: string, count: number): string[] {
  const days: string[] = [];
  for (let cursor = day; days.length < count; cursor = addDays(cursor, 1))
    if (weekday(cursor) !== 0 && weekday(cursor) !== 6) days.push(cursor);
  return days;
}

/** The days the service must read to draw the outlook for `today`. */
export function outlookWindow(today: string) {
  const from = mondayOf(today);
  const weekBefore = addDays(today, -7);
  return {
    from,
    to: addDays(from, OUTLOOK_DAYS - 1),
    /** The seven days before today start before this week's Monday. */
    readFrom: weekBefore < from ? weekBefore : from,
    loadDays: workingDaysFrom(today, 5),
  };
}

/** Last quarter, this one and the next, for `today`. */
export function outlookQuarters(today: string): Array<Quarter & { phase: OutlookQuarter['phase'] }> {
  const current = quarterOf(dayToDate(today));
  return [
    { ...previousQuarter(current), phase: 'PAST' },
    { ...current, phase: 'CURRENT' },
    { ...nextQuarter(current), phase: 'NEXT' },
  ];
}

const visitType = (type: string): OutlookVisitType =>
  (OUTLOOK_VISIT_TYPES as readonly string[]).includes(type) ? (type as OutlookVisitType) : 'OTHER';

export interface OutlookInspectionCount {
  scheduledAt: Date;
  inspectionType: string;
  status: string;
  count: number;
}

export interface OutlookStopRow {
  planId: string;
  status: string;
  scheduledOn: Date | null;
  inspection: {
    status: string;
    scheduledAt: Date;
    submittedAt: Date | null;
    completedAt: Date | null;
  } | null;
}

export interface OutlookPlanRow {
  id: string;
  quarterYear: number;
  quarterNumber: number;
  status: string;
  quarterStartsOn: Date;
  startsOn: Date | null;
}

export interface OutlookInput {
  today: string;
  /** Grouped by day, kind and status, over `outlookWindow().readFrom..to`. */
  inspections: OutlookInspectionCount[];
  doneStatuses: readonly string[];
  inProgressStatus: string;
  plans: OutlookPlanRow[];
  stops: OutlookStopRow[];
  /** One entry per visit on the load days: who is on it, or null. */
  load: Array<{ technicianId: string; name: string } | null>;
  earliestUnassignedOn: string | null;
}

function runningTotals(days: string[]): OutlookRunningTotal[] {
  const perDay = new Map<string, number>();
  for (const day of days) perDay.set(day, (perDay.get(day) ?? 0) + 1);
  let count = 0;
  return [...perDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, added]) => {
      count += added;
      return { date, count };
    });
}

function quarterOutlook(
  plan: OutlookPlanRow,
  phase: OutlookQuarter['phase'],
  stops: OutlookStopRow[],
  input: OutlookInput,
): OutlookQuarter {
  const quarter = { year: plan.quarterYear, quarter: plan.quarterNumber } as Quarter;
  const result = { done: 0, booked: 0, planned: 0, notScheduled: 0, dueByToday: 0 };
  const planDays: string[] = [];
  const doneDays: string[] = [];
  for (const stop of stops) {
    if (stop.status === 'EXCLUDED') continue;
    const visit = stop.inspection && stop.inspection.status !== 'CANCELLED' ? stop.inspection : null;
    const day = visit ? isoDay(visit.scheduledAt) : stop.scheduledOn ? isoDay(stop.scheduledOn) : null;
    if (visit && input.doneStatuses.includes(visit.status)) {
      result.done += 1;
      // The day the technician sent it in, in Texas; a visit closed some other
      // way has only its own day to go by.
      const finished = visit.submittedAt ?? visit.completedAt;
      doneDays.push(finished ? businessDate(finished) : isoDay(visit.scheduledAt));
    } else if (visit || (stop.status === 'PUBLISHED' && day)) result.booked += 1;
    else if (stop.status === 'PLANNED' && day) result.planned += 1;
    else {
      result.notScheduled += 1;
      continue;
    }
    if (day) {
      planDays.push(day);
      if (day < input.today) result.dueByToday += 1;
    }
  }
  return {
    planId: plan.id,
    label: quarterLabel(quarter),
    phase,
    planStatus: plan.status as OutlookQuarter['planStatus'],
    startsOn: isoDay(plan.startsOn ?? plan.quarterStartsOn),
    endsOn: isoDay(new Date(quarterEnd(quarter).getTime() - MS_PER_DAY)),
    total: result.done + result.booked + result.planned + result.notScheduled,
    ...result,
    plan: runningTotals(planDays),
    progress: runningTotals(doneDays),
  };
}

export function buildOutlook(input: OutlookInput): AdminDashboardOutlook {
  const { today } = input;
  const window = outlookWindow(today);
  const days = new Map<string, OutlookDay>();
  for (let index = 0; index < OUTLOOK_DAYS; index += 1) {
    const date = addDays(window.from, index);
    days.set(date, {
      date,
      booked: { OCCUPIED: 0, MOVE_OUT: 0, MOVE_IN: 0, HVAC: 0, OTHER: 0 },
      done: 0,
      planned: 0,
    });
  }

  const todayCounts = { total: 0, done: 0, inProgress: 0 };
  let next7 = 0;
  let previous7 = 0;
  const next7Until = addDays(today, 6);
  const previous7From = addDays(today, -7);
  for (const row of input.inspections) {
    if (row.status === 'CANCELLED') continue;
    const date = isoDay(row.scheduledAt);
    const done = input.doneStatuses.includes(row.status);
    const day = days.get(date);
    if (day) {
      day.booked[visitType(row.inspectionType)] += row.count;
      if (done) day.done += row.count;
    }
    if (date === today) {
      todayCounts.total += row.count;
      if (done) todayCounts.done += row.count;
      if (row.status === input.inProgressStatus) todayCounts.inProgress += row.count;
    }
    if (date >= today && date <= next7Until) next7 += row.count;
    if (date >= previous7From && date < today) previous7 += row.count;
  }

  // In a plan, on a day, and not on the calendar yet. A stop whose visit was
  // cancelled is not planned work either: somebody took it off.
  for (const stop of input.stops) {
    if (stop.status !== 'PLANNED' || stop.inspection || !stop.scheduledOn) continue;
    const day = days.get(isoDay(stop.scheduledOn));
    if (day) day.planned += 1;
  }

  const byTechnician = new Map<string | null, OutlookTechnicianLoad>();
  for (const person of input.load) {
    const key = person?.technicianId ?? null;
    const current = byTechnician.get(key);
    if (current) current.visits += 1;
    else byTechnician.set(key, { technicianId: key, name: person?.name ?? 'Unassigned', visits: 1 });
  }
  // Busiest first, and nobody last whatever their count: it is a different thing.
  const technicianLoad = [...byTechnician.values()].sort(
    (a, b) =>
      Number(a.technicianId === null) - Number(b.technicianId === null) ||
      b.visits - a.visits ||
      a.name.localeCompare(b.name),
  );

  const quarters = outlookQuarters(today).flatMap(({ phase, ...quarter }) => {
    const plan = input.plans.find(
      (candidate) =>
        candidate.quarterYear === quarter.year && candidate.quarterNumber === quarter.quarter,
    );
    if (!plan) return [];
    return [
      quarterOutlook(plan, phase, input.stops.filter((stop) => stop.planId === plan.id), input),
    ];
  });

  return {
    today,
    days: [...days.values()],
    todayCounts,
    next7,
    previous7,
    earliestUnassignedOn: input.earliestUnassignedOn,
    loadDays: window.loadDays,
    technicianLoad,
    quarters,
  };
}
