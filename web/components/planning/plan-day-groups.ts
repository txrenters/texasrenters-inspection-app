/**
 * A quarter's days as the Group maker's groups.
 *
 * The office (2026-10-01): the Group maker's map is the better one, so the
 * quarter's Groups tab draws its days the way the maker draws a template --
 * each technician-day a group in its own colour, its stops numbered in the
 * order they are driven, with the road between them. It replaced one numbered
 * circle per date, which could only say roughly where a day was.
 *
 * A day here is a technician's day, not a date: with three people out, a date
 * is three days, and a template's group is one of them.
 */

import { formatShortDay } from '@/lib/planning';

import { groupColorOf, groupColors, groupOutline, type FileGroup, type GroupFile, type GroupFileRow } from './group-file';
import { groupArea, routeMiles } from './manual-grouping';

/** A plan visit, as the Groups tab needs it. */
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

type Placed = DayStop & { latitude: number; longitude: number };

/** A position a map can draw: 0,0 is in the Atlantic, and is what a missing one becomes. */
const placed = (stop: DayStop): stop is Placed =>
  stop.latitude !== null &&
  stop.longitude !== null &&
  Number.isFinite(stop.latitude) &&
  Number.isFinite(stop.longitude) &&
  (stop.latitude !== 0 || stop.longitude !== 0);

/**
 * The quarter's days as groups, in the order they are worked: by date, and on
 * one date by whose day it is. Numbered in that order -- or, on a quarter built
 * from a template, labelled and coloured as the Days list labels them
 * (`dayLabels`, from the server's days). Each day's stops are in its driving
 * order, numbered from 1 as the day's own list numbers them. A visit with no
 * day yet has nowhere to be in a group, and is drawn on its own -- green, as
 * the Group maker draws a property in no group.
 */
export function planDayGroups(stops: readonly DayStop[], labels: ReadonlyMap<string, DayLabel> = new Map()): GroupFile {
  const byDay = new Map<string, { date: string; technician: DayStop['technician']; stops: Placed[] }>();
  const loose: GroupFileRow[] = [];
  /** A row's identity on the map: its place in the plan's own list, which never repeats. */
  let rowNumber = 0;
  const rowOf = (stop: Placed, group: string, place: number | null): GroupFileRow => ({
    rowNumber: (rowNumber += 1),
    group,
    stop: place,
    address: stop.address?.trim() || '',
    unit: stop.unit?.trim() || null,
    city: stop.city?.trim() || null,
    zip: stop.postalCode?.trim() || null,
    lease: stop.lease?.trim() || null,
    hvacPlan: stop.hvacPlan?.trim() || null,
    zone: stop.zone,
    latitude: stop.latitude,
    longitude: stop.longitude,
    geocodeSource: null,
    approximate: false,
    cells: {},
  });

  for (const stop of stops) {
    if (!placed(stop)) continue;
    if (!stop.scheduledOn) {
      loose.push(rowOf(stop, '', null));
      continue;
    }
    const key = dayKey(stop.scheduledOn, stop.technician?.id ?? null);
    const day = byDay.get(key) ?? { date: stop.scheduledOn, technician: stop.technician, stops: [] };
    day.stops.push(stop);
    byDay.set(key, day);
  }

  const days = [...byDay.entries()].sort(
    ([, left], [, right]) =>
      left.date.localeCompare(right.date) ||
      (left.technician?.displayName ?? '').localeCompare(right.technician?.displayName ?? '', undefined, { numeric: true }),
  );
  const ordered = days.map(([key, day]) => {
    // In the day's driving order; a stop the day has not ordered yet goes last, in the plan's own order.
    const inOrder = [...day.stops].sort(
      (left, right) => (left.positionInDay ?? Number.POSITIVE_INFINITY) - (right.positionInDay ?? Number.POSITIVE_INFINITY),
    );
    return inOrder.map((stop, index) => rowOf(stop, key, index + 1));
  });
  const colors = groupColors(ordered);
  // A day the server has no row for yet -- a visit just moved -- is one more of the quarter's extra days.
  let extra = [...labels.values()].filter((label) => label.color === null).length;

  const groups = days.map(([key, day], index): FileGroup => {
    const rows = ordered[index]!;
    const outline = groupOutline(rows);
    const top = outline.reduce((highest, point) => (point[1] > highest[1] ? point : highest));
    const named = labels.get(key);
    return {
      key,
      label: named?.label ?? (labels.size ? `N${(extra += 1)}` : String(index + 1)),
      name: `${formatShortDay(day.date)}${day.technician ? ` · ${day.technician.displayName}` : ''}`,
      area: groupArea(rows),
      rows,
      size: rows.length,
      spanMiles: null,
      routeMiles: routeMiles(rows),
      // The road's drive arrives from Mapbox and takes over in the list.
      driveMinutes: null,
      longestHopMinutes: null,
      longHop: null,
      color: (named?.color ? groupColorOf(named.color) : null) ?? colors[index]!,
      outline,
      labelAt: { latitude: top[1], longitude: top[0] },
    };
  });

  return {
    groups,
    placed: ordered.reduce((sum, rows) => sum + rows.length, 0),
    ungrouped: loose,
    skippedRows: [],
    missing: [],
    header: [],
  };
}
