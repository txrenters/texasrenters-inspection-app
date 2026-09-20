'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LeaseScheduleOverview, LeaseScheduleRun } from '@texasrenters/shared';

import { api } from './api';

/**
 * The move-outs and move-ins booked from Propertyware's leases (the office,
 * 2026-09-18), for their page.
 */

const LEASE_SCHEDULE = '/api/v1/admin/lease-inspections';

export const leaseScheduleKeys = { all: ['lease-schedule'] as const };

export function useLeaseSchedule() {
  return useQuery({
    queryKey: leaseScheduleKeys.all,
    queryFn: ({ signal }) => api<LeaseScheduleOverview>(LEASE_SCHEDULE, { signal }),
  });
}

/** Apply the rules now: `true` previews what a run would do and writes nothing. */
export function useLeaseScheduleRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (dryRun: boolean) =>
      api<LeaseScheduleRun>(`${LEASE_SCHEDULE}/run`, { method: 'POST', body: JSON.stringify({ dryRun }) }),
    onSuccess: (run) => {
      if (!run.dryRun) void client.invalidateQueries({ queryKey: leaseScheduleKeys.all });
    },
  });
}
