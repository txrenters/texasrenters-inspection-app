'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InvoiceAutoDraftsView, SaveInvoiceAutoDraftsInput } from '@texasrenters/shared';

import { api } from './api';
import { invoiceKeys } from './invoice-queries';

/** "Draft invoices automatically" (2026-11-13). */
const AUTO_DRAFTS = '/api/v1/admin/invoice-settings/auto-drafts';

export const invoiceAutoDraftsKey = [...invoiceKeys.all, 'auto-drafts'] as const;

export function useInvoiceAutoDrafts() {
  return useQuery({
    queryKey: invoiceAutoDraftsKey,
    queryFn: ({ signal }) => api<InvoiceAutoDraftsView>(AUTO_DRAFTS, { signal }),
  });
}

export function useSaveInvoiceAutoDrafts() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveInvoiceAutoDraftsInput) => api<InvoiceAutoDraftsView>(AUTO_DRAFTS, { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: (view) => client.setQueryData(invoiceAutoDraftsKey, view),
    // Somebody else changed it first: show theirs.
    onError: () => void client.invalidateQueries({ queryKey: invoiceAutoDraftsKey }),
  });
}
