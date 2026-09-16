import { quarterStart, workingDaysOfQuarter, type Quarter } from './quarter-plan.js';

/**
 * How the office gives out a quarter's benefit-package days (2026-09-16).
 *
 * The crew -- Moses, Kevin and Emanuel, in the office's order -- each work one
 * zone a week, and everyone moves one zone round the circle each week: if Moses
 * is on zone 1 this week, Kevin is on 2 and Emanuel on 3, and next week Moses is
 * on 2, Kevin on 3 and Emanuel on 4. Nobody crosses town, and a tenant sees
 * whoever has their part of it that week.
 *
 * Mondays are kept free of planned visits from the quarter's second week on:
 * that is where the office puts the visits rescheduled from the week before.
 * The first week has nothing to reschedule yet.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** "3" for "3", "Zone 3" or " zone 03 "; null for "Not Set", blank or missing. */
export function zoneNumberOf(zone: string | null | undefined): string | null {
  const digits = /\d+/.exec(zone ?? '');
  return digits ? String(Number(digits[0])) : null;
}

/** Zones in the order the circle goes round them: by number. */
export function byZoneNumber(left: string, right: string): number {
  return Number(left) - Number(right) || left.localeCompare(right);
}

/** The Monday of the week a day falls in, `YYYY-MM-DD`. */
export function weekStartOf(date: string): string {
  const day = Date.parse(`${date}T00:00:00Z`);
  const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * MS_PER_DAY;
  return new Date(monday).toISOString().slice(0, 10);
}

/**
 * The week of the quarter a day falls in, counting from 0.
 *
 * Calendar weeks, Monday to Sunday, so the quarter's first week is whatever is
 * left of the week it starts in: Q4 2026 starts on a Thursday, so its first
 * week is 1-2 October and its second starts on Monday 5 October.
 */
export function quarterWeekIndex(date: string, quarter: Quarter): number {
  const firstMonday = Date.parse(`${weekStartOf(quarterStart(quarter).toISOString().slice(0, 10))}T00:00:00Z`);
  return Math.floor((Date.parse(`${date}T00:00:00Z`) - firstMonday) / (7 * MS_PER_DAY));
}

/** Whether a day is kept free for rescheduled visits: a Monday from the quarter's second week on. */
export function isRescheduleMonday(date: string, quarter: Quarter): boolean {
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 1 && quarterWeekIndex(date, quarter) >= 1;
}

/**
 * The days a quarter's planned visits can go on: its working days -- weekdays,
 * less US federal holidays and any day the office names as closed -- less the
 * Mondays kept for rescheduled visits.
 */
export function plannedVisitDaysOfQuarter(quarter: Quarter, closedDays: readonly string[] = []): string[] {
  return workingDaysOfQuarter(quarter, closedDays).filter((date) => !isRescheduleMonday(date, quarter));
}

/**
 * Who works which zone in a week of the quarter, as `zone -> technician`.
 *
 * The crew goes round the zones in order, one zone each, and all move one zone
 * on each week. With more zones than people, one zone a week has nobody -- a
 * different one each week -- and its visits go to the nearest day it does. With
 * more people than zones, one person a week has no zone, again in turn.
 */
export function weeklyZoneTechnicians(
  crew: readonly string[],
  zones: readonly string[],
  week: number,
): Record<string, string> {
  const owners: Record<string, string> = {};
  const slots = Math.max(crew.length, zones.length);
  if (slots === 0) return owners;
  crew.forEach((technicianId, position) => {
    const slot = (((position + week) % slots) + slots) % slots;
    if (slot < zones.length) owners[zones[slot]!] = technicianId;
  });
  return owners;
}
