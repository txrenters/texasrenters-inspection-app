'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DeliverableInvoice,
  DeliverableQuery,
  DeliverInvoicesInput,
  DeliverInvoicesResult,
  InvoiceDetail,
  InvoiceEmailSettingsView,
  PaymentDetail,
  SaveInvoiceEmailSettingsInput,
  SendInvoiceInput,
  SendReceiptInput,
} from '@texasrenters/shared';

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

/**
 * What Jobber emailed by itself and stops emailing at Take over (2026-11-09):
 * follow-ups about unpaid invoices, receipts, and many invoices at once. The
 * settings are a read of the console's own database; the sends are presses,
 * each carrying its key, and never run on a load, a refetch or a poll.
 */

const EMAIL_SETTINGS = '/api/v1/admin/invoice-settings/emails';

export const invoiceEmailSettingsKey = [...invoiceKeys.all, 'email-settings'] as const;

export function useInvoiceEmailSettings() {
  return useQuery({
    queryKey: invoiceEmailSettingsKey,
    queryFn: ({ signal }) => api<InvoiceEmailSettingsView>(EMAIL_SETTINGS, { signal }),
  });
}

export function useSaveInvoiceEmailSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveInvoiceEmailSettingsInput) =>
      api<InvoiceEmailSettingsView>(EMAIL_SETTINGS, { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: (settings) => client.setQueryData(invoiceEmailSettingsKey, settings),
    // Somebody else saved first: show theirs.
    onError: () => void client.invalidateQueries({ queryKey: invoiceEmailSettingsKey }),
  });
}

/** A payment's receipt, emailed on the press. */
export function useSendReceipt() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ paymentId, input }: { paymentId: string; input: SendReceiptInput }) =>
      api<PaymentDetail>(`/api/v1/admin/payments/${encodeURIComponent(paymentId)}/receipt`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: (payment) => {
      client.setQueryData(invoiceKeys.payment(payment.id), payment);
      // Its invoice lists the receipt with the other emails.
      void client.invalidateQueries({ queryKey: invoiceKeys.detail(payment.invoice.id) });
    },
    onError: (_error, { paymentId }) => void client.invalidateQueries({ queryKey: invoiceKeys.payment(paymentId) }),
  });
}

const DELIVERY = '/api/v1/admin/invoice-delivery';

export const deliverableKey = (query: DeliverableQuery) => [...invoiceKeys.all, 'deliverable', query] as const;

/** The invoices issued in a span of days that nobody has emailed yet. */
export function useDeliverableInvoices(query: DeliverableQuery, enabled = true) {
  return useQuery({
    queryKey: deliverableKey(query),
    queryFn: ({ signal }) =>
      api<DeliverableInvoice[]>(`${DELIVERY}/deliverable?from=${encodeURIComponent(query.from)}&to=${encodeURIComponent(query.to)}`, {
        signal,
      }),
    enabled: enabled && Boolean(query.from && query.to),
    placeholderData: (previous) => previous,
  });
}

export function useDeliverInvoices() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: DeliverInvoicesInput) =>
      api<DeliverInvoicesResult>(`${DELIVERY}/batch`, { method: 'POST', body: JSON.stringify(input) }),
    // Sent or not, each is on its invoice's record now, and off the list when it went.
    onSettled: () => void client.invalidateQueries({ queryKey: invoiceKeys.all }),
  });
}
