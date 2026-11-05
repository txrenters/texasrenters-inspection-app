'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BatchInvoiceInput, BatchInvoiceResult, UninvoicedVisitList } from '@texasrenters/shared';

import { api } from './api';
import { invoiceKeys } from './invoice-queries';

/**
 * Making many invoices at once (2026-11-06, phase 4): the finished visits in a
 * span of days that have no invoice, and the batch that invoices the ones
 * chosen. Reads of the console's own database; nothing billed is called.
 */

const INVOICES = '/api/v1/admin/invoices';

export interface UninvoicedQuery {
  from: string;
  to: string;
}

export const uninvoicedKey = (query: UninvoicedQuery) => [...invoiceKeys.all, 'uninvoiced', query] as const;

export function useUninvoicedVisits(query: UninvoicedQuery, enabled = true) {
  return useQuery({
    queryKey: uninvoicedKey(query),
    queryFn: ({ signal }) =>
      api<UninvoicedVisitList>(
        `${INVOICES}/uninvoiced?from=${encodeURIComponent(query.from)}&to=${encodeURIComponent(query.to)}`,
        { signal },
      ),
    enabled: enabled && Boolean(query.from && query.to),
    placeholderData: (previous) => previous,
  });
}

export function useBatchInvoices() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: BatchInvoiceInput) =>
      api<BatchInvoiceResult>(`${INVOICES}/batch`, { method: 'POST', body: JSON.stringify(input) }),
    // The list, the cards, and the visits still to invoice.
    onSuccess: () => void client.invalidateQueries({ queryKey: invoiceKeys.all }),
  });
}
