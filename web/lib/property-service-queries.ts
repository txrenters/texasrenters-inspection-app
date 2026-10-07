'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PropertyServiceChange, PropertyServiceView, SetPropertyServiceStatusInput } from '@texasrenters/shared';

import { api } from './api';
import { leaseScheduleKeys } from './lease-schedule-queries';
import { keys } from './queries';

/**
 * The office's switches on a property (2026-10-08): the owner ended the
 * management, or the property opted out of the benefit package.
 */

const serviceStatusKey = (propertyId: string) => [...keys.property(propertyId), 'service-status'] as const;

const url = (propertyId: string) => `/api/v1/admin/properties/${propertyId}/service-status`;

export function usePropertyServiceStatus(propertyId: string) {
  return useQuery({
    queryKey: serviceStatusKey(propertyId),
    queryFn: ({ signal }) => api<PropertyServiceView>(url(propertyId), { signal }),
    enabled: Boolean(propertyId),
  });
}

/**
 * Turn a switch. What it did -- called off, booked again, still booked -- comes
 * back in the answer, so the card shows it at once; the property (its badges)
 * and the lease schedule are fetched again, as both may have changed.
 */
export function useSetPropertyServiceStatus(propertyId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SetPropertyServiceStatusInput) =>
      api<PropertyServiceChange>(url(propertyId), { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: (change) => {
      client.setQueryData<PropertyServiceView>(serviceStatusKey(propertyId), {
        status: change.status,
        stillBooked: change.stillBooked,
        leaseScheduleOn: change.leaseScheduleOn,
      });
      void client.invalidateQueries({ queryKey: keys.property(propertyId), exact: true });
      void client.invalidateQueries({ queryKey: leaseScheduleKeys.all });
    },
  });
}
