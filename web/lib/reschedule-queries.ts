'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  list: (filter: RescheduleRequestFilter) => ['admin', 'reschedule-requests', filter] as const,
};

export function useRescheduleRequests(filter: RescheduleRequestFilter) {
  return useQuery({
    queryKey: rescheduleKeys.list(filter),
    queryFn: ({ signal }) => api<RescheduleRequestList>(`${RESCHEDULE_REQUESTS}?filter=${filter}`, { signal }),
  });
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
