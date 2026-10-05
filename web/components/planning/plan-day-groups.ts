/**
 * A quarter's visits and the labels of its days, for the Schedule's map.
 *
 * A day here is a technician's day, not a date: with three people out, a date
 * is three days, and a template's group is one of them. The Groups tab that
 * drew every day at once from these (`planDayGroups`) went on 2026-10-05; the
 * Schedule draws the server's days instead (`planDaysFile`).
 */

/** A plan visit, as the Schedule's map needs it. */
export interface DayStop {
  id: string;
  latitude: number | null;
  longitude: number | null;
  /** `YYYY-MM-DD`, or null for a visit with no day yet. */
  scheduledOn: string | null;
  /** Its place in the day's drive, from 1; null before the day is ordered. */
  positionInDay: number | null;
  /** Whose day it is -- on a quarter sent out unassigned, the day's group ("Day group 2"). */
  technician: { id: string; displayName: string } | null;
  zone: string | null;
  address: string | null;
  unit: string | null;
  city: string | null;
  postalCode: string | null;
  lease: string | null;
  hvacPlan: string | null;
  /** The visit's state in the plan; a visit the office left out is no day's. */
  status?: string;
}

/** The key a day's group is known by: its date and whose day it is. */
export const dayKey = (date: string, technicianId: string | null) => `${date}|${technicianId ?? ''}`;

/** What a day is called on the map and in the list, and its template group's colour. */
export interface DayLabel {
  label: string;
  /** `#rrggbb`; null for a day of no template group. */
  color: string | null;
}

/**
 * Each day's label, by `dayKey` (the office, 2026-10-03: "let's not modify the
 * groupings label, it should stay the same as is").
 *
 * A day laid out from a template group is that group's number, as the Group
 * maker numbers it: Group 37 is "37" whatever date it falls on. The quarter's
 * other days -- made from properties in none of its groups, or by hand -- are
 * "N1", "N2"... in the order given, so none is taken for a template group.
 * A quarter with no template day at all has no labels here: its days are
 * numbered in the order they are worked, as they always were.
 */
export function dayLabels(
  days: readonly { date: string; technicianId: string; templateGroup?: { position: number; color: string } | null }[],
): Map<string, DayLabel> {
  const labels = new Map<string, DayLabel>();
  if (!days.some((day) => day.templateGroup)) return labels;
  let extra = 0;
  for (const day of days)
    labels.set(
      dayKey(day.date.slice(0, 10), day.technicianId),
      day.templateGroup
        ? { label: String(day.templateGroup.position), color: day.templateGroup.color }
        : { label: `N${(extra += 1)}`, color: null },
    );
  return labels;
}
