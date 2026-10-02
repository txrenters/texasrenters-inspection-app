/**
 * A quarter's days as the Group maker's groups, for the Days view.
 *
 * The office, 2026-10-02: the Days view should work as the Group maker does --
 * the days listed as its groups are, the day picked drawn as the group being
 * built, its route from the technician's home with each leg's drive on it, and
 * a property clicked on the map joining the day picked.
 *
 * Unlike the Groups tab (`planDayGroups`), a day here is the server's day row,
 * with the move-outs and move-ins it is built around among its stops: they are
 * on its road, and the drive into the visit after one is from it.
 */

import { formatShortDay } from '@/lib/planning';
import type { PlanDay, PlanDayRoute } from '@/lib/planning-queries';

import { groupColorOf, groupColors, groupOutline, type FileGroup, type GroupFile, type GroupFileRow } from './group-file';
import { groupArea, routeMiles } from './manual-grouping';
import { dayKey, dayLabels, type DayStop } from './plan-day-groups';
import { splitAtWaypoints, type LngLat, type RoadLeg, type RouteView } from './road-routes';

/** What a property on the Days map is, for a click on it. */
export type DayMapEntry =
  | {
      kind: 'visit';
      stopId: string;
      /** The day it is on; null for a visit with no day yet. */
      dayId: string | null;
      technicianId: string | null;
      /** It has its inspection: moving it reschedules a booking. */
      booked: boolean;
      address: string;
    }
  /** A move-out or move-in a day is built around: its own inspection, moved in Jobber. */
  | { kind: 'booking'; dayId: string; address: string };

export interface PlanDaysFile {
  file: GroupFile;
  /** By the row's number on the map. */
  entries: ReadonlyMap<number, DayMapEntry>;
  /** Each day's group, by day id. */
  groupOf: ReadonlyMap<string, FileGroup>;
}

/** A position a map can draw: 0,0 is in the Atlantic, and is what a missing one becomes. */
const onEarth = (latitude: number | null, longitude: number | null): boolean =>
  latitude !== null &&
  longitude !== null &&
  Number.isFinite(latitude) &&
  Number.isFinite(longitude) &&
  (latitude !== 0 || longitude !== 0);

/** A day's stops -- its visits and the bookings it is built around -- in driving order, as its list numbers them. */
export function dayStopsInOrder(day: PlanDay) {
  return [
    ...day.stops.map((stop) => ({ ...stop, booking: null as null | 'MOVE_OUT' | 'MOVE_IN' })),
    ...(day.anchors ?? []).map((anchor) => ({
      id: anchor.id,
      buildingId: anchor.buildingId,
      positionInDay: anchor.positionInDay,
      driveSecondsForecast: anchor.driveSecondsForecast,
      address: anchor.address,
      city: anchor.city,
      latitude: anchor.latitude,
      longitude: anchor.longitude,
      zone: null,
      status: 'PUBLISHED' as const,
      booking: anchor.kind,
    })),
  ].sort((left, right) => (left.positionInDay ?? Number.MAX_SAFE_INTEGER) - (right.positionInDay ?? Number.MAX_SAFE_INTEGER));
}

/**
 * Every day as a group, numbered in the order the quarter is worked, and the
 * visits with no day yet as properties in no group -- green, as the Group maker
 * draws them. A day built from a template keeps its template group's number
 * and colour, and the quarter's other days are N1, N2... (`dayLabels`).
 */
export function planDaysFile(days: readonly PlanDay[], visits: readonly DayStop[]): PlanDaysFile {
  const detailsOf = new Map(visits.map((visit) => [visit.id, visit]));
  const entries = new Map<number, DayMapEntry>();
  let rowNumber = 0;
  const rowOf = (
    stop: { id: string; address: string | null; city: string | null; zone: string | null; latitude: number; longitude: number },
    group: string,
    place: number | null,
  ): GroupFileRow => {
    const details = detailsOf.get(stop.id);
    return {
      rowNumber: (rowNumber += 1),
      group,
      stop: place,
      address: (details?.address ?? stop.address)?.trim() || '',
      unit: details?.unit?.trim() || null,
      city: (details?.city ?? stop.city)?.trim() || null,
      zip: details?.postalCode?.trim() || null,
      lease: details?.lease?.trim() || null,
      hvacPlan: details?.hvacPlan?.trim() || null,
      zone: stop.zone,
      latitude: stop.latitude,
      longitude: stop.longitude,
      geocodeSource: null,
      approximate: false,
      cells: {},
    };
  };

  const ordered = days.map((day) =>
    dayStopsInOrder(day).flatMap((stop, index) => {
      if (!onEarth(stop.latitude, stop.longitude)) return [];
      const row = rowOf(
        { ...stop, latitude: stop.latitude!, longitude: stop.longitude! },
        day.id,
        stop.positionInDay ?? index + 1,
      );
      entries.set(
        row.rowNumber,
        stop.booking
          ? { kind: 'booking', dayId: day.id, address: row.address }
          : {
              kind: 'visit',
              stopId: stop.id,
              dayId: day.id,
              technicianId: day.technicianId,
              booked: stop.status === 'PUBLISHED',
              address: row.address,
            },
      );
      return [row];
    }),
  );
  const palette = groupColors(ordered);
  const labels = dayLabels(days);

  const groups = days.map((day, index): FileGroup => {
    const rows = ordered[index]!;
    const outline = groupOutline(rows);
    const top = outline.length
      ? outline.reduce((highest, point) => (point[1] > highest[1] ? point : highest))
      : ([rows[0]?.longitude ?? 0, rows[0]?.latitude ?? 0] as [number, number]);
    return {
      key: day.id,
      label: labels.get(dayKey(day.date.slice(0, 10), day.technicianId))?.label ?? String(index + 1),
      name: `${formatShortDay(day.date.slice(0, 10))} · ${day.technician.displayName}`,
      area: groupArea(rows),
      rows,
      size: rows.length,
      spanMiles: null,
      routeMiles: routeMiles(rows),
      driveMinutes: day.totalDriveSeconds === null ? null : Math.round(day.totalDriveSeconds / 60),
      longestHopMinutes: null,
      longHop: null,
      color: (day.templateGroup ? groupColorOf(day.templateGroup.color) : null) ?? palette[index]!,
      outline,
      labelAt: { latitude: top[1], longitude: top[0] },
    };
  });

  // A visit the office left out of the quarter is no day's, and cannot be given one.
  const ungrouped = visits.flatMap((visit) => {
    if (visit.scheduledOn || visit.status === 'EXCLUDED' || !onEarth(visit.latitude, visit.longitude)) return [];
    const row = rowOf({ ...visit, latitude: visit.latitude!, longitude: visit.longitude! }, '', null);
    entries.set(row.rowNumber, {
      kind: 'visit',
      stopId: visit.id,
      dayId: null,
      technicianId: null,
      booked: false,
      address: row.address,
    });
    return [row];
  });

  return {
    file: {
      groups,
      placed: ordered.reduce((sum, rows) => sum + rows.length, 0),
      ungrouped,
      skippedRows: [],
      missing: [],
      header: [],
    },
    entries,
    groupOf: new Map(groups.map((group) => [group.key, group])),
  };
}

const toLngLat = (path: readonly [number, number][]): LngLat[] => path.map(([latitude, longitude]) => [longitude, latitude]);

/**
 * A day's road as the map draws a group's: the server's line from home and
 * through the stops, cut at each stop, with each leg's drive.
 *
 * The drive on each leg is the plan's own -- the figure the day's list, its
 * total and Optimize route all use -- so the map and the list never disagree
 * about a leg. The distance is the road's. Null while there is no such route
 * (a stop moved since it was drawn), and the map then joins the stops straight.
 */
export function dayRouteView(
  day: PlanDay,
  group: FileGroup,
  route: PlanDayRoute | undefined,
  origin: { latitude: number; longitude: number } | null,
): RouteView {
  if (!route) return { status: 'loading' };
  const between = dayStopsInOrder(day).filter((stop) => onEarth(stop.latitude, stop.longitude));
  if (!route.geometry.length || route.legs.length !== group.rows.length - 1 || between.length !== group.rows.length)
    return { status: 'error', message: 'The road could not be drawn for this order' };
  const home = origin && route.homeGeometry.length ? toLngLat(route.homeGeometry) : [];
  const geometry = [...home, ...toLngLat(route.geometry)];
  const waypoints: LngLat[] = [
    ...(home.length ? [[origin!.longitude, origin!.latitude] as LngLat] : []),
    ...group.rows.map((row) => [row.longitude, row.latitude] as LngLat),
  ];
  const legs: RoadLeg[] = [
    ...(home.length
      ? [{ durationS: day.homeDriveSeconds ?? 0, distanceM: day.homeDriveMeters ?? 0 }]
      : []),
    ...route.legs.map((leg, index) => ({
      durationS: between[index + 1]!.driveSecondsForecast ?? leg.durationSeconds,
      distanceM: leg.distanceMeters,
    })),
  ];
  const counted = home.length ? legs.slice(1) : legs;
  return {
    status: 'ok',
    route: {
      geometry,
      splits: splitAtWaypoints(geometry, waypoints),
      legs,
      durationS: counted.reduce((sum, leg) => sum + leg.durationS, 0),
      distanceM: counted.reduce((sum, leg) => sum + leg.distanceM, 0),
    },
  };
}
