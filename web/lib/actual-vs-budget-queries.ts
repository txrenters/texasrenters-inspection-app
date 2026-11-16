'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  RevenueColumn,
  RevenueLog,
  RevenueLogTechnicians,
  RevenueProductColumns,
  SaveRevenueLogEntryInput,
} from '@texasrenters/shared';

import { api } from './api';

/**
 * Actual vs Budget (2026-11-17): the office's revenue monitoring. Read when the
 * page opens or its technician or days change, kept a minute, never polled:
 * the log is looked at and typed into, not watched. Nothing it reads is billed.
 */

const BASE = '/api/v1/admin/actual-vs-budget';
const KEPT = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

export const actualVsBudgetKeys = {
  all: ['actual-vs-budget'] as const,
  technicians: ['actual-vs-budget', 'technicians'] as const,
  log: (technicianId: string, from: string, to: string) => ['actual-vs-budget', 'log', technicianId, from, to] as const,
  products: ['actual-vs-budget', 'products'] as const,
};

export function useRevenueTechnicians() {
  return useQuery({
    queryKey: actualVsBudgetKeys.technicians,
    queryFn: ({ signal }) => api<RevenueLogTechnicians>(`${BASE}/technicians`, { signal }),
    ...KEPT,
  });
}

export function useRevenueLog(technicianId: string, from: string, to: string) {
  return useQuery({
    queryKey: actualVsBudgetKeys.log(technicianId, from, to),
    queryFn: ({ signal }) =>
      api<RevenueLog>(`${BASE}/log?${new URLSearchParams({ technicianId, from, to }).toString()}`, { signal }),
    enabled: Boolean(technicianId && from && to),
    ...KEPT,
  });
}

export function useRevenueProducts(enabled: boolean) {
  return useQuery({
    queryKey: actualVsBudgetKeys.products,
    queryFn: ({ signal }) => api<RevenueProductColumns>(`${BASE}/products`, { signal }),
    enabled,
    ...KEPT,
  });
}

/** Where a row is saved: on its visit, on the office's own entry, or as a new row. */
export type RowTarget = { inspectionId: string } | { entryId: string } | { add: true };

export function useRevenueLogEdits() {
  const client = useQueryClient();
  const reread = () => client.invalidateQueries({ queryKey: [...actualVsBudgetKeys.all, 'log'] });
  return {
    save: useMutation({
      mutationFn: ({ target, input }: { target: RowTarget; input: SaveRevenueLogEntryInput }) => {
        const body = JSON.stringify(input);
        if ('inspectionId' in target)
          return api<{ entryId: string }>(`${BASE}/log/visits/${encodeURIComponent(target.inspectionId)}`, { method: 'PUT', body });
        if ('entryId' in target)
          return api<{ entryId: string }>(`${BASE}/log/entries/${encodeURIComponent(target.entryId)}`, { method: 'PATCH', body });
        return api<{ entryId: string }>(`${BASE}/log/entries`, { method: 'POST', body });
      },
      onSuccess: reread,
    }),
    remove: useMutation({
      mutationFn: (entryId: string) => api<{ removed: boolean }>(`${BASE}/log/entries/${encodeURIComponent(entryId)}`, { method: 'DELETE' }),
      onSuccess: reread,
    }),
    saveProductColumn: useMutation({
      mutationFn: ({ productId, column }: { productId: string; column: RevenueColumn }) =>
        api<RevenueProductColumns>(`${BASE}/products/${encodeURIComponent(productId)}`, { method: 'PUT', body: JSON.stringify({ column }) }),
      onSuccess: (products) => {
        client.setQueryData(actualVsBudgetKeys.products, products);
        void reread();
      },
    }),
  };
}
