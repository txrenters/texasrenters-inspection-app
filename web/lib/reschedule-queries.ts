'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BookAgainRescheduleRequestInput,
  DismissRescheduleRequestInput,
  MoveRescheduleRequestInput,
  RescheduleRequestFilter,
  RescheduleRequestList,
  RescheduleRequestView,
} from '@texasrenters/shared';

import { api } from './api';
import { keys } from './queries';

/**
 * The visits to book again (2026-10-21), for their queue: what technicians
 * asked, and the office's three answers.
 */

const RESCHEDULE_REQUESTS = '/api/v1/admin/reschedule-requests';

export const rescheduleKeys = {
  all: ['admin', 'reschedule-requests'] as const,
  list: (filter: RescheduleRequestFilter, search = '') => ['admin', 'reschedule-requests', filter, search] as const,
};

export function useRescheduleRequests(
  filter: RescheduleRequestFilter,
  /** Off for an account that may not answer requests (Home's Workflow card asks only when allowed). */
  enabled = true,
  /** An address, a name, a reason or a job; both lists and their counts follow it. */
  search = '',
) {
  const term = search.trim();
  return useQuery({
    queryKey: rescheduleKeys.list(filter, term),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ filter });
      if (term) params.set('q', term);
      return api<RescheduleRequestList>(`${RESCHEDULE_REQUESTS}?${params.toString()}`, { signal });
    },
    enabled,
    // The list stays on screen while the next search is read, rather than blinking to a skeleton.
    placeholderData: keepPreviousData,
  });
}

/** The queue, searched for one visit: where the job page's "Open Reschedules" goes. */
export function reschedulesHref(address: string | null | undefined) {
  const term = address?.trim();
  return term ? `/reschedules?q=${encodeURIComponent(term)}` : '/reschedules';
}

/**
 * Moving or booking changes inspections -- the list, the visit's own page, the
 * new one -- so every inspection query is read again, as well as the queue.
 */
function useAnswer<T>(path: 'move' | 'book-again' | 'dismiss') {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: T }) =>
      api<RescheduleRequestView>(`${RESCHEDULE_REQUESTS}/${id}/${path}`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: rescheduleKeys.all });
      void client.invalidateQueries({ queryKey: keys.inspectionsRoot });
      void client.invalidateQueries({ queryKey: ['admin', 'inspection'] });
    },
  });
}

export const useMoveRescheduleRequest = () => useAnswer<MoveRescheduleRequestInput>('move');
export const useBookAgainRescheduleRequest = () => useAnswer<BookAgainRescheduleRequestInput>('book-again');
export const useDismissRescheduleRequest = () => useAnswer<DismissRescheduleRequestInput>('dismiss');
