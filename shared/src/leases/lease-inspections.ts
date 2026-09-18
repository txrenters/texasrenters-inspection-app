/**
 * The move-outs and move-ins a lease calls for, and on which days.
 *
 * The office's rules (2026-09-18), now that this system books them from
 * Propertyware's leases rather than the office booking them in Jobber:
 *
 * - **Every lease gets a move-out sixty days before its tenancy ends**, whether
 *   or not the tenant has given notice. The tenancy ends on Propertyware's
 *   scheduled move-out where it has one, and otherwise on the lease's end date.
 *   Moses takes the move-outs.
 * - **A tenant who is leaving gets a move-in twenty-two days after they go**,
 *   for the make-ready: twenty-two days is the quickest turnaround the office
 *   has had. Leaving means notice given, an eviction, or the lease gone from
 *   Propertyware's report without a lease under the same name taking its place
 *   -- a lease that renews or goes month-to-month gets no move-in. Amy takes the
 *   move-ins.
 * - **Nothing is booked more than ninety days ahead**, so each quarter's
 *   benefit-package plan is built knowing Moses's move-out days.
 * - A move-out whose day has passed while the tenant is still there goes on the
 *   next working day; a move-in whose day passed more than two weeks ago is left
 *   to the office. Every day is a working day: a weekday that is not a US
 *   federal holiday, the next one when the rule lands on a day off.
 */

import { usFederalHolidays } from '../contracts/quarter-plan.js';

export const MOVE_OUT_DAYS_BEFORE_END = 60;
export const MOVE_IN_DAYS_AFTER_LEAVING = 22;
export const LEASE_INSPECTION_HORIZON_DAYS = 90;
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

/** The move-out and move-in a lease calls for today, if any, within the ninety days ahead. */
export function inspectionsDue(lease: LeaseDates, today: string): DueInspection[] {
  const horizon = addDays(today, LEASE_INSPECTION_HORIZON_DAYS);
  const due: DueInspection[] = [];

  const ends = tenancyEndsOn(lease);
  if (lease.isActive && ends && ends > today) {
    const dueOn = addDays(ends, -MOVE_OUT_DAYS_BEFORE_END);
    const scheduledOn = bookableDay(dueOn, today);
    // While the tenant is still there: a move-out after they have gone is not one.
    if (dueOn <= horizon && scheduledOn <= ends) due.push({ kind: 'MOVE_OUT', dueOn, scheduledOn });
  }

  const leaving = tenantIsLeaving(lease) ? leavingOn(lease) : null;
  if (leaving) {
    const dueOn = addDays(leaving, MOVE_IN_DAYS_AFTER_LEAVING);
    if (dueOn <= horizon && dueOn >= addDays(today, -MOVE_IN_GRACE_DAYS))
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
  /** The last day it can go -- a move-out while the tenant is still there -- or null for any. */
  latest: string | null;
}

/**
 * Working days for inspections whose day has already passed, a few a day.
 *
 * Fourteen leases were past their sixty days when the schedule started, and the
 * next working day would have put all fourteen move-outs on one technician's
 * Monday. So they go three a day from the next working day, soonest due first,
 * each kind on its own -- they are different technicians' days. One whose turn
 * would come after the tenant leaves goes on the next working day instead.
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
      days.set(entry.key, entry.latest && day > entry.latest ? first : day);
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
