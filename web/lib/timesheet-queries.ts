'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from './api';

/**
 * The hours a technician is paid for, read from where they actually were.
 *
 * Replacing Start job / End job, which a month of real work showed wrong in
 * both directions -- one visit recorded 43.9 hours because End was never
 * pressed, others recorded seven minutes for visits that ran two hours. This
 * is the office's side of it: the totals, the visits behind them, and the two
 * things a person is allowed to change.
 */

const TIME_TRACKING = '/api/v1/admin/time-tracking';

export type TimeSegmentCategory = 'ONSITE' | 'DRIVING' | 'GENERAL';

/** One technician's row: the number payroll reads. */
export interface TimesheetTotal {
  technicianId: string;
  technician: string;
  onsiteSeconds: number;
  drivingSeconds: number;
  generalSeconds: number;
  /**
   * Time the trail could not account for, and nobody has settled.
   *
   * Never added into the hours. It is a question, not an answer, and a total
   * that swallowed it would pay somebody the wrong amount quietly.
   */
  unsettledGapSeconds: number;
}

export interface TimesheetSegment {
  id: string;
  technicianId: string;
  technician: string;
  inspectionId: string;
  address: string | null;
  inspectionType: string;
  category: TimeSegmentCategory;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  source: 'AUTOMATIC' | 'MANUAL';
  /** A person has corrected this one; a recompute will not touch it again. */
  adjusted: boolean;
  flag: string | null;
}

export interface TimesheetGap {
  id: string;
  technicianId: string;
  technician: string;
  inspectionId: string | null;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  resolved: boolean;
  resolution: string | null;
}

export interface Timesheet {
  from: string;
  to: string;
  totals: TimesheetTotal[];
  segments: TimesheetSegment[];
  gaps: TimesheetGap[];
}

export const timesheetKeys = {
  all: ['timesheet'] as const,
  range: (from: string, to: string, technicianId?: string) =>
    ['timesheet', from, to, technicianId ?? 'everyone'] as const,
};

export function useTimesheet(from: string, to: string, technicianId?: string) {
  return useQuery({
    queryKey: timesheetKeys.range(from, to, technicianId),
    queryFn: ({ signal }) => {
      const query = new URLSearchParams({ from, to });
      if (technicianId) query.set('technicianId', technicianId);
      return api<Timesheet>(`${TIME_TRACKING}/timesheet?${query.toString()}`, { signal });
    },
    enabled: Boolean(from && to),
  });
}

export function useTimesheetActions() {
  const client = useQueryClient();
  // Any of these changes what somebody is paid, so the whole sheet is read
  // again rather than patched: a total that disagreed with its own rows would
  // be worse than a moment's delay.
  const refresh = () => void client.invalidateQueries({ queryKey: timesheetKeys.all });

  return {
    /** Read a job's time from the trail again. Writes segments and nothing else. */
    recompute: useMutation({
      mutationFn: (inspectionId: string) =>
        api<{ onsiteSeconds: number; manualSeconds: number | null; segments: unknown[] }>(
          `${TIME_TRACKING}/inspections/${encodeURIComponent(inspectionId)}/recompute`,
          { method: 'POST' },
        ),
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

    /**
     * Settle a stretch the trail could not account for.
     *
     * With minutes, the office is saying the work happened and the phone missed
     * it. Without, it is saying the technician was not working -- which is also
     * a real answer, and better said than left open.
     */
    resolveGap: useMutation({
      mutationFn: ({
        gapId,
        ...body
      }: {
        gapId: string;
        resolution: string;
        creditedMinutes?: number;
      }) =>
        api<{ id: string; creditedMinutes: number }>(
          `${TIME_TRACKING}/gaps/${encodeURIComponent(gapId)}/resolve`,
          { method: 'POST', body: JSON.stringify(body) },
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
