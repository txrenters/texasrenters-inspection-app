/**
 * The move-outs and move-ins a lease calls for, and on which days.
 *
 * The office's rules (2026-09-18), now that this system books them from
 * Propertyware's leases rather than the office booking them in Jobber:
 *
 * - **Every lease gets a move-out on the day after its tenancy ends**, booked
 *   sixty days before, whether or not the tenant has given notice. That is the
 *   day the office books in Jobber -- eight of the nine move-outs it had coming
 *   up were the day after the lease ended -- and "sixty days before" is when it
 *   is booked, not when it is walked. The tenancy ends on Propertyware's
 *   scheduled move-out where it has one, and otherwise on the lease's end date.
 *   Moses takes the move-outs.
 * - **A tenant who is leaving gets a move-in twenty-two days after they go**,
 *   for the make-ready: twenty-two days is the quickest turnaround the office
 *   has had. Leaving means notice given, an eviction, or the lease gone from
 *   Propertyware's report without a lease under the same name taking its place
 *   -- a lease that renews or goes month-to-month gets no move-in. Amy takes the
 *   move-ins, booked up to ninety days ahead.
 * - A lease whose end has already passed with the tenant still there -- gone
 *   month-to-month, or Propertyware not yet told -- gets no move-out: that one
 *   is the office's. A move-in whose day passed more than two weeks ago is left
 *   to the office too. Every day is a working day: a weekday that is not a US
 *   federal holiday, the next one when the rule lands on a day off.
 */

import { usFederalHolidays } from '../contracts/quarter-plan.js';

/** The move-out is the day after the tenancy ends. */
export const MOVE_OUT_DAYS_AFTER_END = 1;
/** ...and is booked this many days before it. */
export const MOVE_OUT_BOOKED_DAYS_AHEAD = 60;
export const MOVE_IN_DAYS_AFTER_LEAVING = 22;
/** How far ahead a move-in is booked. */
export const MOVE_IN_BOOKED_DAYS_AHEAD = 90;

/** How far ahead each kind is booked. */
export const BOOKED_DAYS_AHEAD: Record<LeaseInspectionKind, number> = {
  MOVE_OUT: MOVE_OUT_BOOKED_DAYS_AHEAD,
  MOVE_IN: MOVE_IN_BOOKED_DAYS_AHEAD,
};
/** How long after its day a move-in the rules missed is still booked. */
export const MOVE_IN_GRACE_DAYS = 14;

export type LeaseInspectionKind = 'MOVE_OUT' | 'MOVE_IN';

/** What the rules read from a lease, dates as `YYYY-MM-DD`. */
export interface LeaseDates {
  /** Propertyware's status as written: "Active", "Active - Notice Given", "Going MTM", "Eviction". */
  status: string | null;
  /** Still on Propertyware's report. */
  isActive: boolean;
  endDate: string | null;
  scheduledMoveOutDate: string | null;
  noticeGivenDate: string | null;
  /** The day it dropped off the report, for a lease no longer on it. */
  droppedOn: string | null;
  /** Another lease on the report at the same building under the same name: a renewal written as a new lease. */
  renewed: boolean;
}

export interface DueInspection {
  kind: LeaseInspectionKind;
  /** The day the rule gives. */
  dueOn: string;
  /** The working day it is booked for. */
  scheduledOn: string;
}

const DAY_MS = 86_400_000;

/** `date` moved by whole days, `YYYY-MM-DD`. */
export const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Whether somebody can be sent out on a day: a weekday that is not a US federal holiday. */
export function isWorkingDay(date: string): boolean {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !usFederalHolidays(Number(date.slice(0, 4))).includes(date);
}

/** The day itself when it is a working day, and otherwise the next one. */
export function workingDayOnOrAfter(date: string): string {
  let day = date;
  while (!isWorkingDay(day)) day = addDays(day, 1);
  return day;
}

/** The day the tenancy ends: the scheduled move-out where Propertyware has one, else the lease's end. */
export const tenancyEndsOn = (lease: LeaseDates) => lease.scheduledMoveOutDate ?? lease.endDate;

/** Whether the tenant is leaving: notice given, an eviction, or the lease gone from the report unrenewed. */
export function tenantIsLeaving(lease: LeaseDates): boolean {
  if (lease.renewed) return false;
  if (!lease.isActive) return true;
  const status = (lease.status ?? '').toLowerCase();
  return Boolean(lease.noticeGivenDate) || status.includes('notice') || status.includes('eviction');
}

/**
 * The day the tenant goes: when the tenancy ends, or when the lease dropped off
 * the report if that was earlier -- an eviction, or a tenant who left early.
 */
export function leavingOn(lease: LeaseDates): string | null {
  const ends = tenancyEndsOn(lease);
  if (!lease.isActive && lease.droppedOn && (!ends || lease.droppedOn < ends)) return lease.droppedOn;
  return ends;
}

/** The working day for a rule's day: after today when the day has passed, so there is always notice. */
const bookableDay = (dueOn: string, today: string) =>
  dueOn < today ? workingDayOnOrAfter(addDays(today, 1)) : workingDayOnOrAfter(dueOn);

/** The day a lease's move-out falls on by the rule, before it is moved to a working day, if it has one to come. */
export function moveOutDueOn(lease: LeaseDates, today: string): string | null {
  const ends = tenancyEndsOn(lease);
  // Not once the end has passed with the tenant still there: that one is the office's.
  return lease.isActive && ends && ends >= today ? addDays(ends, MOVE_OUT_DAYS_AFTER_END) : null;
}

/** The move-out and move-in a lease calls for today, if any: each once it is near enough to book. */
export function inspectionsDue(lease: LeaseDates, today: string): DueInspection[] {
  const due: DueInspection[] = [];

  const moveOut = moveOutDueOn(lease, today);
  if (moveOut && moveOut <= addDays(today, MOVE_OUT_BOOKED_DAYS_AHEAD))
    due.push({ kind: 'MOVE_OUT', dueOn: moveOut, scheduledOn: bookableDay(moveOut, today) });

  const leaving = tenantIsLeaving(lease) ? leavingOn(lease) : null;
  if (leaving) {
    const dueOn = addDays(leaving, MOVE_IN_DAYS_AFTER_LEAVING);
    if (dueOn <= addDays(today, MOVE_IN_BOOKED_DAYS_AHEAD) && dueOn >= addDays(today, -MOVE_IN_GRACE_DAYS))
      due.push({ kind: 'MOVE_IN', dueOn, scheduledOn: bookableDay(dueOn, today) });
  }
  return due;
}

/** How many whose day has already passed go on one working day (the office, 2026-09-18). */
export const OVERDUE_PER_DAY = 3;

export interface OverdueInspection {
  /** Anything that tells them apart: the lease and kind. */
  key: string;
  kind: LeaseInspectionKind;
  dueOn: string;
}

/**
 * Working days for inspections whose day has already passed, a few a day.
 *
 * A move-out never has -- its day is always after today -- but move-ins missed
 * by up to two weeks do, and the next working day would put them all on one
 * morning. So they go three a day from the next working day, soonest due first,
 * each kind on its own: they are different technicians' days.
 */
export function spreadOverdue(
  overdue: readonly OverdueInspection[],
  today: string,
  perDay = OVERDUE_PER_DAY,
): Map<string, string> {
  const days = new Map<string, string>();
  const first = workingDayOnOrAfter(addDays(today, 1));
  for (const kind of ['MOVE_OUT', 'MOVE_IN'] as const) {
    let day = first;
    let taken = 0;
    const ofKind = overdue
      .filter((entry) => entry.kind === kind)
      .sort((left, right) => left.dueOn.localeCompare(right.dueOn) || left.key.localeCompare(right.key));
    for (const entry of ofKind) {
      if (taken === perDay) {
        day = workingDayOnOrAfter(addDays(day, 1));
        taken = 0;
      }
      days.set(entry.key, day);
      taken += 1;
    }
  }
  return days;
}

/** What the lease schedule did about one lease's move-out or move-in, as the console shows it. */
export type LeaseScheduleOutcome =
  | 'SCHEDULED'
  | 'ALREADY_BOOKED'
  | 'NEEDS_UNIT'
  | 'NOT_BOOKABLE'
  | 'CALLED_OFF'
  | 'CANCELLED';

/** What one run did, or in a dry run would do, about one lease's move-out or move-in. */
export type LeaseScheduleAction = 'BOOK' | 'ALREADY_BOOKED' | 'NEEDS_UNIT' | 'NOT_BOOKABLE' | 'MOVE' | 'CALL_OFF';

export interface LeaseScheduleChange {
  leaseId: string;
  kind: LeaseInspectionKind;
  action: LeaseScheduleAction;
  /** The working day it is, or would be, booked for. */
  scheduledOn: string;
  property: { id: string; address: string | null; city: string | null };
  inspectionId: string | null;
  detail: string | null;
}

export interface LeaseScheduleRun {
  /** The Texas day the rules were applied on. */
  today: string;
  /** Nothing was written: what a run would do. */
  dryRun: boolean;
  leases: number;
  counts: Record<LeaseScheduleAction, number>;
  changes: LeaseScheduleChange[];
}

export interface LeaseScheduleItem {
  id: string;
  kind: LeaseInspectionKind;
  dueOn: string;
  scheduledOn: string;
  outcome: LeaseScheduleOutcome;
  detail: string | null;
  updatedAt: string;
  property: { id: string; name: string; address: string | null; city: string | null };
  lease: { id: string; status: string | null; endsOn: string | null };
  inspection: {
    id: string;
    status: string;
    scheduledOn: string;
    technician: { id: string; displayName: string } | null;
  } | null;
}

/** Whether the daily run is on, when it next runs, and what the last one did. */
export interface LeaseScheduleState {
  enabled: boolean;
  cron: string;
  nextRunAt: string | null;
  running: boolean;
  lastRun: { at: string; counts: Record<LeaseScheduleAction, number> } | null;
}

export interface LeaseScheduleOverview {
  schedule: LeaseScheduleState;
  items: LeaseScheduleItem[];
}
