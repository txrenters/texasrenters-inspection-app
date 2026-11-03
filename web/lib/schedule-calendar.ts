import { isFinishedStatus, type JobberDayComparison, type JobberDayRow } from '@texasrenters/shared';

import { BUSINESS_TIME_ZONE, shiftDay } from '@/lib/clock';

/**
 * The Schedule's calendar, laid out as Jobber's (components/schedule): a month,
 * a week from Sunday, or a day with a column per technician.
 *
 * Everything here is arithmetic on Texas days held as `YYYY-MM-DD` strings, and
 * on the day comparison the Schedule already reads (`GET …/jobber/day`), which
 * is built from what the Jobber sync stored and never calls Jobber.
 */

export type CalendarView = 'month' | 'week' | 'day';

/** In Jobber's order. */
export const CALENDAR_VIEWS = [
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
] as const satisfies readonly { value: CalendarView; label: string }[];

export function parseCalendarView(value: string | undefined): CalendarView {
  return value === 'month' || value === 'day' ? value : 'week';
}

/** A `YYYY-MM-DD` is a date, so it is read at noon UTC, which is that date everywhere. */
const noon = (date: string) => new Date(`${date}T12:00:00.000Z`);

/** Jobber's weeks start on Sunday ("Week of Sunday, November 1"), so these do. */
export function sundayOf(date: string): string {
  return shiftDay(date, -noon(date).getUTCDay());
}

export function weekOf(date: string): string[] {
  const sunday = sundayOf(date);
  return Array.from({ length: 7 }, (_, index) => shiftDay(sunday, index));
}

/** The month's own days, and the whole weeks that show them, Sunday to Saturday. */
export function monthOf(date: string): { days: string[]; grid: string[] } {
  const first = `${date.slice(0, 7)}-01`;
  const days: string[] = [];
  for (let day = first; day.slice(0, 7) === first.slice(0, 7); day = shiftDay(day, 1)) days.push(day);
  const start = sundayOf(first);
  const last = days.at(-1)!;
  const end = shiftDay(last, 6 - noon(last).getUTCDay());
  const grid: string[] = [];
  for (let day = start; day <= end; day = shiftDay(day, 1)) grid.push(day);
  return { days, grid };
}

/** The days whose visits the view shows: never the grey days of the months either side. */
export function daysToRead(view: CalendarView, anchor: string): string[] {
  if (view === 'day') return [anchor];
  if (view === 'week') return weekOf(anchor);
  return monthOf(anchor).days;
}

/** The arrows: a day, a week, or a month at a time (the 31st becomes the 30th, not the 1st). */
export function stepAnchor(view: CalendarView, anchor: string, direction: -1 | 1): string {
  if (view === 'day') return shiftDay(anchor, direction);
  if (view === 'week') return shiftDay(anchor, direction * 7);
  const [year, month, day] = anchor.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + direction, 1, 12));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

const MONTH_TITLE = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
/** "November 2026": Jobber's title over every view. */
export const monthTitle = (date: string) => MONTH_TITLE.format(noon(date));

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
export const weekdayOf = (date: string) => WEEKDAY.format(noon(date));
export const dayOfMonth = (date: string) => Number(date.slice(8, 10));

/** When a visit starts: our time if we set one, else Jobber's. Null is Jobber's "Anytime". */
export function visitStart(row: JobberDayRow): string | null {
  return row.here?.startAt ?? row.jobber?.startAt ?? null;
}

const TEXAS_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
});

/** Minutes after midnight, in Texas, wherever the reader is (the office reads from Manila). */
export function texasMinutes(value: string | Date): number {
  const parts = TEXAS_CLOCK.formatToParts(typeof value === 'string' ? new Date(value) : value);
  const read = (type: 'hour' | 'minute') => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return (read('hour') % 24) * 60 + read('minute');
}

/**
 * The hours the time grid draws: the working day, widened to take in any visit
 * outside it. Null when nothing has a time, and the grid is left out rather
 * than drawn empty -- most of the office's visits are "Anytime", as they are in
 * Jobber.
 */
export function hourWindow(minutes: readonly number[]): { from: number; to: number } | null {
  if (!minutes.length) return null;
  const earliest = Math.min(...minutes);
  const latest = Math.max(...minutes);
  return {
    from: Math.max(0, Math.min(8, Math.floor(earliest / 60))),
    to: Math.min(24, Math.max(17, Math.floor(latest / 60) + 1)),
  };
}

/**
 * Where a visit stands, as the Status filter offers it. "Only in Jobber" is a
 * visit named as an inspection in Jobber that has no inspection here.
 */
export type VisitStatusGroup = 'upcoming' | 'active' | 'done' | 'cancelled' | 'jobber';

export const STATUS_GROUPS = [
  { value: 'upcoming', label: 'To do' },
  { value: 'active', label: 'In progress' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'jobber', label: 'Only in Jobber' },
] as const satisfies readonly { value: VisitStatusGroup; label: string }[];

export function statusGroup(row: JobberDayRow): VisitStatusGroup {
  if (!row.inspectionId) return 'jobber';
  if (row.status === 'CANCELLED') return 'cancelled';
  if (row.status === 'IN_PROGRESS') return 'active';
  if (isFinishedStatus(row.status)) return 'done';
  return 'upcoming';
}

/** The filter key for "nobody is on it", which has no technician id. */
export const NOBODY = 'nobody';
export const technicianKey = (technicianId: string | null) => technicianId ?? NOBODY;
/** A visit with no known type, so the Type filter can still hide it. */
export const UNKNOWN_TYPE = 'UNKNOWN';

/** What each filter hides, so a new technician or type shows until somebody unticks it. */
export interface CalendarFilters {
  types: ReadonlySet<string>;
  technicians: ReadonlySet<string>;
  statuses: ReadonlySet<string>;
}

export const NO_FILTERS: CalendarFilters = { types: new Set(), technicians: new Set(), statuses: new Set() };

export function isShown(row: JobberDayRow, hidden: CalendarFilters): boolean {
  return (
    !hidden.types.has(row.inspectionType ?? UNKNOWN_TYPE) &&
    !hidden.technicians.has(technicianKey(row.technicianId)) &&
    !hidden.statuses.has(statusGroup(row))
  );
}

/** What "N visits" counts: the work still on the day, so not a cancelled visit. */
export const counts = (row: JobberDayRow) => row.status !== 'CANCELLED';

export interface DayColumn {
  technicianId: string | null;
  name: string;
}

/**
 * The Day view's columns, as Jobber's: "Unassigned" first, always, then each
 * technician with something on the day, by name.
 */
export function dayColumns(day: JobberDayComparison | undefined): DayColumn[] {
  const people = (day?.technicians ?? [])
    .filter((person) => person.technicianId !== null)
    .map((person) => ({ technicianId: person.technicianId, name: person.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [{ technicianId: null, name: 'Unassigned' }, ...people];
}

/** A day's visits in reading order: timed ones by the clock, then Anytime by person and property. */
export function sortVisits(rows: readonly JobberDayRow[], nameOf: (row: JobberDayRow) => string): JobberDayRow[] {
  return [...rows].sort((a, b) => {
    const at = visitStart(a);
    const bt = visitStart(b);
    if (at && bt && at !== bt) return at.localeCompare(bt);
    if (at && !bt) return -1;
    if (!at && bt) return 1;
    return nameOf(a).localeCompare(nameOf(b)) || a.property.localeCompare(b.property);
  });
}
