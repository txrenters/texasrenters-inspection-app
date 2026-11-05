'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { InvoiceDetail, SendInvoiceInput } from '@texasrenters/shared';

import { api } from './api';
import { invoiceKeys } from './invoice-queries';

/**
 * Sending an invoice by email (2026-11-06, phase 5). The one console call that
 * makes the server pay a provider, so it is a mutation and nothing else: it
 * runs when somebody presses Send, never on a load, a refetch or a poll, and
 * carries the dialog's key so a resend of the same press sends nothing twice.
 */
export function useSendInvoice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: SendInvoiceInput }) =>
      api<InvoiceDetail>(`/api/v1/admin/invoices/${encodeURIComponent(id)}/send`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: (invoice) => {
      client.setQueryData(invoiceKeys.detail(invoice.id), invoice);
      void client.invalidateQueries({ queryKey: invoiceKeys.all });
    },
    // A send that did not go is on the record too: its page and history say so.
    onError: (_error, { id }) => void client.invalidateQueries({ queryKey: invoiceKeys.detail(id) }),
  });
}
