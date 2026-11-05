'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EditInvoiceInput, InvoiceDetail, InvoiceHistory, InvoiceStatusChangeInput } from '@texasrenters/shared';

import { api } from './api';
import { invoiceKeys } from './invoice-queries';

/**
 * Editing an invoice (2026-11-06, phase 3): the edit, its state, deleting a
 * draft, and its history. Each write is a person's, sent with the invoice as
 * it was read, and answered with the invoice as it now is.
 */

const INVOICES = '/api/v1/admin/invoices';
const invoiceUrl = (id: string) => `${INVOICES}/${encodeURIComponent(id)}`;

export const invoiceHistoryKey = (id: string) => [...invoiceKeys.detail(id), 'history'] as const;

/** What happened to the invoice in the console. Read with the invoice, and again after each change to it. */
export function useInvoiceHistory(id: string, enabled = true) {
  return useQuery({
    queryKey: invoiceHistoryKey(id),
    queryFn: ({ signal }) => api<InvoiceHistory>(`${invoiceUrl(id)}/history`, { signal }),
    enabled: Boolean(id) && enabled,
  });
}

export function useInvoiceEdits() {
  const client = useQueryClient();
  const saved = (invoice: InvoiceDetail) => {
    client.setQueryData(invoiceKeys.detail(invoice.id), invoice);
    // The list, the property's and visit's cards, and this invoice's history.
    void client.invalidateQueries({ queryKey: invoiceKeys.all });
  };
  return {
    edit: useMutation({
      mutationFn: ({ id, input }: { id: string; input: EditInvoiceInput }) =>
        api<InvoiceDetail>(invoiceUrl(id), { method: 'PATCH', body: JSON.stringify(input) }),
      onSuccess: saved,
    }),
    changeStatus: useMutation({
      mutationFn: ({ id, input }: { id: string; input: InvoiceStatusChangeInput }) =>
        api<InvoiceDetail>(`${invoiceUrl(id)}/status`, { method: 'POST', body: JSON.stringify(input) }),
      onSuccess: saved,
    }),
    /** A draft, deleted. Its page is left as the caller moves on, rather than asked for and answered "not found". */
    remove: useMutation({
      mutationFn: ({ id, expectedUpdatedAt }: { id: string; expectedUpdatedAt: string }) =>
        api<{ id: string }>(`${invoiceUrl(id)}?expectedUpdatedAt=${encodeURIComponent(expectedUpdatedAt)}`, { method: 'DELETE' }),
      onSuccess: (_removed, { id }) =>
        void client.invalidateQueries({
          queryKey: invoiceKeys.all,
          predicate: (query) => !query.queryKey.join('/').startsWith(invoiceKeys.detail(id).join('/')),
        }),
    }),
  };
}
