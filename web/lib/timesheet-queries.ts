'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from './api';

/**
 * The hours a technician worked, read from where they actually were.
 *
 * Replacing Start job / End job, which a month of real work showed wrong in
 * both directions -- one visit recorded 43.9 hours because End was never
 * pressed, others recorded seven minutes for visits that ran two hours. This
 * is the office's side of it: the totals, the stretches behind them, and the
 * two things a person is allowed to do about them.
 */

const TIME_TRACKING = '/api/v1/admin/time-tracking';

/** At a property, or between properties. There is no third kind. */
export type TimeSegmentCategory = 'ONSITE' | 'GENERAL';

/** One technician's row: the number payroll reads. */
export interface TimesheetTotal {
  technicianId: string;
  technician: string;
  /** Inside the circle of a property they had a visit at. */
  onsiteSeconds: number;
  /** Everything else between the first arrival of a day and the last departure. */
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

export interface TimesheetSegment {
  id: string;
  technicianId: string;
  technician: string;
  /** The visit an on-site stretch was for. Null for general time. */
  inspectionId: string | null;
  /** The property. Null for general time, which is between properties. */
  address: string | null;
  category: TimeSegmentCategory;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  quietSeconds: number;
  source: 'AUTOMATIC' | 'MANUAL';
  /** A person has corrected this one; reading the day again will not touch it. */
  adjusted: boolean;
  flag: string | null;
}

export interface Timesheet {
  from: string;
  to: string;
  totals: TimesheetTotal[];
  segments: TimesheetSegment[];
}

export const timesheetKeys = {
  all: ['timesheet'] as const,
  range: (from: string, to: string, technicianId?: string) =>
    ['timesheet', from, to, technicianId ?? 'everyone'] as const,
};

/**
 * How often an open timesheet asks again.
 *
 * The server reads today from the trail every five minutes, while the
 * technicians are still out. A page left open on the office's second monitor
 * should move with it, or "the clock starts when they walk in" is only true
 * for somebody who keeps pressing refresh.
 */
const REFRESH_EVERY_MS = 60_000;

export function useTimesheet(from: string, to: string, technicianId?: string) {
  return useQuery({
    queryKey: timesheetKeys.range(from, to, technicianId),
    queryFn: ({ signal }) => {
      const query = new URLSearchParams({ from, to });
      if (technicianId) query.set('technicianId', technicianId);
      return api<Timesheet>(`${TIME_TRACKING}/timesheet?${query.toString()}`, { signal });
    },
    enabled: Boolean(from && to),
    refetchInterval: REFRESH_EVERY_MS,
  });
}

export function useTimesheetActions() {
  const client = useQueryClient();
  // Either of these changes what somebody is paid, so the whole sheet is read
  // again rather than patched: a total that disagreed with its own rows would
  // be worse than a moment's delay.
  const refresh = () => void client.invalidateQueries({ queryKey: timesheetKeys.all });

  return {
    /**
     * Read every technician's days in this range from the trail again.
     *
     * For the days behind today and yesterday, which are read on their own:
     * after a property's pin or distances are corrected, or the rule changes.
     * Hours corrected by hand are left alone, and pressing it again gives the
     * same answer.
     */
    recalculate: useMutation({
      mutationFn: (body: { from: string; to: string }) =>
        api<{ days: number; technicians: number; changed: number }>(`${TIME_TRACKING}/recalculate`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      onSuccess: refresh,
    }),

    /** Correct a segment the trail got wrong. The reason is required. */
    adjust: useMutation({
      mutationFn: ({
        segmentId,
        ...body
      }: {
        segmentId: string;
        startedAt: string;
        endedAt: string;
        reason: string;
      }) =>
        api<{ id: string; durationSeconds: number }>(
          `${TIME_TRACKING}/segments/${encodeURIComponent(segmentId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        ),
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
