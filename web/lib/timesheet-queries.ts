'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from './api';
import { businessToday } from './clock';
import { humanize } from './format';

/**
 * The hours a technician worked, read from where they actually were.
 *
 * Replacing Start job / End job, which a month of real work showed wrong in
 * both directions -- one visit recorded 43.9 hours because End was never
 * pressed, others recorded seven minutes for visits that ran two hours. This
 * is the office's side of it: one day's totals, the properties behind them,
 * and the two things a person is allowed to do about them.
 */

const TIME_TRACKING = '/api/v1/admin/time-tracking';

/** One technician's row: the number payroll reads. */
export interface TimesheetTotal {
  technicianId: string;
  technician: string;
  /** Inside the circle of a property they had a visit at. */
  onsiteSeconds: number;
  /** On the road between properties: the drive. */
  generalSeconds: number;
  /**
   * Standing still between properties somewhere that is not one -- the
   * hardware store, a supply run, lunch. Its own figure (the office, 2026-10-17).
   */
  stopSeconds: number;
  /** All three: the day from the first arrival to the last departure. */
  totalSeconds: number;
  /**
   * How much of the total the phone was silent for.
   *
   * Inside the hours: a quiet phone does not stop the clock. Shown so hours
   * that were carried through a silence can be told from hours that were
   * measured.
   */
  quietSeconds: number;
}

/**
 * One technician's time at one property on the day: one row, however often
 * they walked out to the van and back.
 */
export interface TimesheetVisit {
  key: string;
  technicianId: string;
  technician: string;
  buildingId: string | null;
  inspectionId: string | null;
  address: string | null;
  /** First into the circle. */
  arrivedAt: string;
  /** Last out of it. */
  leftAt: string;
  /** Inside the circle, added up. The rest of the span is general time. */
  onsiteSeconds: number;
  quietSeconds: number;
  /** How many times they went in. */
  stays: number;
  /** Sent back with a correction: the stretches it replaces. */
  segmentIds: string[];
  /** A person has corrected some of this; reading the day again will not touch it. */
  adjusted: boolean;
  addedByHand: boolean;
  /** Every visit the technician had there that day, the one the time is filed under first. */
  jobs: TimesheetJob[];
}

/** One visit behind a row: what the technician was there to do. */
export interface TimesheetJob {
  inspectionId: string;
  type: string;
  /** Booked as the quarter's Tenant Benefit Package. */
  benefitPackage: boolean;
  status: string;
}

/** The office's names for the kinds of visit (the inspections list's, shortened). */
const JOB_LABEL: Record<string, string> = {
  MOVE_IN: 'Move-in',
  OCCUPIED: 'Occupied',
  BACK_TO_MARKET: 'Back-to-market',
  MOVE_OUT: 'Move-out',
  HVAC: 'HVAC',
  ROOF: 'Roof',
  SUPRA_LOCKBOX_PLACEMENT: 'Supra + lockbox placement',
  SUPRA_LOCKBOX_REMOVAL: 'Supra + lockbox removal',
  AC_FILTER_DELIVERY: 'AC filter delivery',
};

/** "Move-out", or the type in words for one this page has no name for yet. */
export function jobLabel(job: Pick<TimesheetJob, 'type' | 'status'>): string {
  const label = JOB_LABEL[job.type] ?? humanize(job.type);
  return job.status === 'CANCELLED' ? `${label} (cancelled)` : label;
}

/** What a stop away from the properties turned out to be, once looked up. */
export type StopPlaceKind = 'PROPERTY' | 'HOME' | 'BUSINESS' | 'ADDRESS' | 'UNKNOWN';

/**
 * A stop away from the properties: where a technician stood still between
 * two of them, and for how long. Only for somebody who may see a technician's
 * position; everybody else sees the minutes in the totals and not where.
 */
export interface TimesheetStop {
  key: string;
  technicianId: string;
  technician: string;
  arrivedAt: string;
  leftAt: string;
  durationSeconds: number;
  quietSeconds: number;
  /** Null until it has been looked up, which happens within minutes. */
  place: {
    kind: StopPlaceKind;
    name: string | null;
    address: string | null;
    /**
     * What kind of place a business is, as OpenStreetMap tags it:
     * "shop=hardware". Null when not known yet, empty when it had none.
     * `stopKind` puts it in words.
     */
    category?: string | null;
  } | null;
  latitude: number | null;
  longitude: number | null;
}

/**
 * The time between two places: a stretch of general time, with the rows it
 * ran between named by their keys -- a visit's or a stop's. Both ends the same
 * visit is a step out of the circle and back, not a drive.
 */
export interface TimesheetDrive {
  key: string;
  technicianId: string;
  technician: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  quietSeconds: number;
  fromKey: string | null;
  toKey: string | null;
}

export interface Timesheet {
  date: string;
  totals: TimesheetTotal[];
  visits: TimesheetVisit[];
  /** Absent, not empty, for somebody who may not see where a technician was. */
  stops?: TimesheetStop[];
  /** Every drive of the day, in order. Absent from a server older than 2026-11-04. */
  drives?: TimesheetDrive[];
}

/**
 * What to call a stop, in the office's words.
 *
 * Home is only ever "Home" -- the office has no use for the address. A
 * property with no visit says so, because the office will ask why the
 * technician was there. A stop nobody could name says that rather than
 * showing coordinates.
 */
export function stopTitle(stop: Pick<TimesheetStop, 'place'>): string {
  const place = stop.place;
  if (!place) return 'Finding the place…';
  if (place.kind === 'HOME') return 'Home';
  return place.name ?? place.address ?? 'A place with no name';
}

/** The second line under a stop's name: what kind of place it was. */
export function stopDetail(stop: Pick<TimesheetStop, 'place'>): string | null {
  const place = stop.place;
  if (!place) return null;
  if (place.kind === 'PROPERTY') return 'A property with no visit booked';
  if (place.kind === 'BUSINESS') return place.address;
  return null;
}

/** Whether a place's name came from OpenStreetMap, which then has to be credited. */
export const namedByOpenStreetMap = (stop: Pick<TimesheetStop, 'place'>) =>
  stop.place?.kind === 'BUSINESS' || stop.place?.kind === 'ADDRESS';

/**
 * OpenStreetMap's tags in the office's words: the places a technician stops
 * at between properties. Home Depot and Lowe's are "doityourself" there.
 */
const PLACE_KIND: Record<string, string> = {
  'shop=hardware': 'Hardware store',
  'shop=doityourself': 'Home improvement store',
  'shop=trade': 'Building supplies',
  'shop=paint': 'Paint store',
  'shop=electrical': 'Electrical supplies',
  'shop=locksmith': 'Locksmith',
  'shop=garden_centre': 'Garden center',
  'shop=convenience': 'Convenience store',
  'shop=supermarket': 'Grocery store',
  'shop=general': 'General store',
  'shop=variety_store': 'Dollar store',
  'shop=department_store': 'Department store',
  'shop=car_parts': 'Auto parts store',
  'shop=car_repair': 'Auto repair',
  'shop=tyres': 'Tire shop',
  'shop=chemist': 'Pharmacy',
  'shop=mobile_phone': 'Phone store',
  'amenity=fuel': 'Gas station',
  'amenity=car_wash': 'Car wash',
  'amenity=fast_food': 'Fast food',
  'amenity=restaurant': 'Restaurant',
  'amenity=cafe': 'Coffee shop',
  'amenity=bank': 'Bank',
  'amenity=atm': 'ATM',
  'amenity=pharmacy': 'Pharmacy',
  'amenity=post_office': 'Post office',
  'amenity=parking': 'Parking lot',
  'amenity=toilets': 'Restroom',
};

/**
 * What kind of place a stop was -- "Hardware store", "Convenience store" --
 * or null when that is not known. A tag this page has no words for yet says
 * its own: "shop=pet" is "Pet".
 */
export function stopKind(stop: Pick<TimesheetStop, 'place'>): string | null {
  const category = stop.place?.kind === 'BUSINESS' ? stop.place.category : null;
  if (!category) return null;
  const known = PLACE_KIND[category];
  if (known) return known;
  const value = category.split('=')[1];
  return value ? humanize(value) : null;
}

/** One line of a technician's day, in the order it happened. */
export type DayEntry =
  | {
      kind: 'visit';
      key: string;
      startedAt: string;
      endedAt: string;
      seconds: number;
      visit: TimesheetVisit;
      /** Out of the circle and back to it, inside this visit: general time, not a drive. */
      steppedOutSeconds: number;
    }
  | { kind: 'stop'; key: string; startedAt: string; endedAt: string; seconds: number; stop: TimesheetStop }
  | {
      kind: 'drive';
      key: string;
      startedAt: string;
      endedAt: string;
      seconds: number;
      drive: TimesheetDrive;
      /** Where it set off from and went to, in words; null when the day does not say. */
      from: string | null;
      to: string | null;
    };

/**
 * One technician's day as a list, the way Jobber's timesheet reads: each
 * property, each drive and each stop, in order. A drive names its two ends --
 * a property's address, a store's name, or only "a stop" for somebody who may
 * not see where -- and a step out of a property's circle and back is folded
 * into that visit instead of listed as a drive.
 */
export function technicianDay(sheet: Timesheet, technicianId: string): DayEntry[] {
  const visits = sheet.visits.filter((visit) => visit.technicianId === technicianId);
  const stops = (sheet.stops ?? []).filter((stop) => stop.technicianId === technicianId);
  const drives = (sheet.drives ?? []).filter((drive) => drive.technicianId === technicianId);
  const visitByKey = new Map(visits.map((visit) => [visit.key, visit]));
  const stopByKey = new Map(stops.map((stop) => [stop.key, stop]));

  const nameOf = (key: string | null): string | null => {
    if (!key) return null;
    const visit = visitByKey.get(key);
    if (visit) return visit.address ?? 'a property';
    const stop = stopByKey.get(key);
    // Not named yet is still a stop; "Finding the place…" is for its own row.
    return stop?.place ? stopTitle(stop) : 'a stop';
  };

  const steppedOut = new Map<string, number>();
  const entries: DayEntry[] = [];
  for (const drive of drives) {
    if (drive.fromKey && drive.fromKey === drive.toKey && visitByKey.has(drive.fromKey)) {
      steppedOut.set(drive.fromKey, (steppedOut.get(drive.fromKey) ?? 0) + drive.durationSeconds);
      continue;
    }
    entries.push({
      kind: 'drive',
      key: drive.key,
      startedAt: drive.startedAt,
      endedAt: drive.endedAt,
      seconds: drive.durationSeconds,
      drive,
      from: nameOf(drive.fromKey),
      to: nameOf(drive.toKey),
    });
  }
  for (const visit of visits)
    entries.push({
      kind: 'visit',
      key: visit.key,
      startedAt: visit.arrivedAt,
      endedAt: visit.leftAt,
      seconds: visit.onsiteSeconds,
      visit,
      steppedOutSeconds: steppedOut.get(visit.key) ?? 0,
    });
  for (const stop of stops)
    entries.push({
      kind: 'stop',
      key: stop.key,
      startedAt: stop.arrivedAt,
      endedAt: stop.leftAt,
      seconds: stop.durationSeconds,
      stop,
    });

  return entries.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

export const timesheetKeys = {
  all: ['timesheet'] as const,
  day: (date: string, technicianId?: string) => ['timesheet', date, technicianId ?? 'everyone'] as const,
};

/**
 * How often today's timesheet asks again.
 *
 * The server reads today from the trail every five minutes, while the
 * technicians are still out, and a page left open on the office's second
 * monitor should move with it. An earlier day is not going to change by
 * itself, so it is asked for once.
 */
const REFRESH_EVERY_MS = 60_000;

export function useTimesheet(date: string, technicianId?: string) {
  return useQuery({
    queryKey: timesheetKeys.day(date, technicianId),
    queryFn: ({ signal }) => {
      const query = new URLSearchParams({ date });
      if (technicianId) query.set('technicianId', technicianId);
      return api<Timesheet>(`${TIME_TRACKING}/timesheet?${query.toString()}`, { signal });
    },
    enabled: Boolean(date),
    refetchInterval: date === businessToday() ? REFRESH_EVERY_MS : false,
  });
}

export function useTimesheetActions() {
  const client = useQueryClient();
  // Either of these changes what somebody is paid, so the sheet is read again
  // rather than patched: a total that disagreed with its own rows would be
  // worse than a moment's delay.
  const refresh = () => void client.invalidateQueries({ queryKey: timesheetKeys.all });

  return {
    /**
     * Read every technician's days from the trail again, from one day to another.
     *
     * Today and yesterday are read on their own. This is for the days behind
     * them: after a property's pin or distances are corrected, or the rule
     * changes. Hours corrected by hand are left alone, a day with no trail
     * left keeps what it has, and pressing it again gives the same answer.
     */
    recalculate: useMutation({
      mutationFn: (body: { from: string; to: string }) =>
        api<{ days: number; technicians: number; changed: number }>(`${TIME_TRACKING}/recalculate`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      onSuccess: refresh,
    }),

    /** Correct a technician's time at one property. The reason is required. */
    correct: useMutation({
      mutationFn: (body: { segmentIds: string[]; startedAt: string; endedAt: string; reason: string }) =>
        api<{ id: string; durationSeconds: number }>(`${TIME_TRACKING}/visits/correct`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      onSuccess: refresh,
    }),
  };
}

/** "6h 42m", as a timesheet reads rather than as seconds. */
export function asHours(seconds: number): string {
  const whole = Math.round(seconds / 60);
  const hours = Math.floor(whole / 60);
  const minutes = whole % 60;
  if (!hours) return `${minutes}m`;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}
