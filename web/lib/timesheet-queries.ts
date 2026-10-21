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
  /** Everything else between the first arrival of the day and the last departure. */
  generalSeconds: number;
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

export interface Timesheet {
  date: string;
  totals: TimesheetTotal[];
  visits: TimesheetVisit[];
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
