'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChangePaymentInput,
  CreateInvoiceInput,
  CreateInvoicesInput,
  CreatedInvoices,
  InvoiceDetail,
  InvoiceDraft,
  InvoiceFilter,
  InvoiceList,
  PaymentDetail,
  PaymentList,
  PaymentMethod,
  RecordPaymentInput,
} from '@texasrenters/shared';

import { api } from './api';

/**
 * Invoices and payments, read from the console's copy of Jobber's and written
 * through to Jobber (see `shared/src/contracts/invoices.ts`).
 *
 * Reads of the console's own database only: the copy is kept up to date by
 * Jobber's webhooks on the server, so nothing here polls, and no page asks
 * Jobber anything. The two writes are a person's, each with its own key so a
 * double click or a resend makes one invoice or one payment.
 */

const INVOICES = '/api/v1/admin/invoices';
const PAYMENTS = '/api/v1/admin/payments';

export interface InvoiceQuery {
  filter?: InvoiceFilter;
  search?: string;
  page?: number;
  pageSize?: number;
  propertyId?: string;
  inspectionId?: string;
  /** Issued on or after, and on or before (2026-11-09). */
  issuedFrom?: string;
  issuedTo?: string;
  /** One company's invoices (2026-11-10): an organisation's tenant id, or `none`. */
  company?: string;
}

export interface PaymentQuery {
  search?: string;
  method?: PaymentMethod;
  page?: number;
  /** Paid on or after, and on or before (2026-11-09). */
  paidFrom?: string;
  paidTo?: string;
}

export const invoiceKeys = {
  all: ['admin', 'invoices'] as const,
  list: (query: InvoiceQuery) => ['admin', 'invoices', 'list', query] as const,
  detail: (id: string) => ['admin', 'invoices', 'detail', id] as const,
  draft: (inspectionId: string) => ['admin', 'invoices', 'draft', inspectionId] as const,
  payments: (query: PaymentQuery) => ['admin', 'invoices', 'payments', query] as const,
  payment: (id: string) => ['admin', 'invoices', 'payment', id] as const,
};

const queryString = (values: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : '';
};

export function useInvoices(query: InvoiceQuery, enabled = true) {
  return useQuery({
    queryKey: invoiceKeys.list(query),
    queryFn: ({ signal }) =>
      api<InvoiceList>(
        `${INVOICES}${queryString({
          filter: query.filter && query.filter !== 'all' ? query.filter : undefined,
          search: query.search?.trim(),
          page: query.page,
          pageSize: query.pageSize,
          propertyId: query.propertyId,
          inspectionId: query.inspectionId,
          issuedFrom: query.issuedFrom,
          issuedTo: query.issuedTo,
          company: query.company,
        })}`,
        { signal },
      ),
    enabled,
    placeholderData: (previous) => previous,
  });
}

export function useInvoice(id: string) {
  return useQuery({
    queryKey: invoiceKeys.detail(id),
    queryFn: ({ signal }) => api<InvoiceDetail>(`${INVOICES}/${encodeURIComponent(id)}`, { signal }),
    enabled: Boolean(id),
  });
}

/**
 * What a finished visit would be invoiced for, before anybody edits it; or a
 * property's invoice, for work no visit covers (2026-11-06).
 */
export function useInvoiceDraft(target: { inspectionId?: string; propertyId?: string }) {
  const key = target.inspectionId ? `visit:${target.inspectionId}` : target.propertyId ? `property:${target.propertyId}` : '';
  return useQuery({
    queryKey: invoiceKeys.draft(key),
    queryFn: ({ signal }) =>
      api<InvoiceDraft>(
        `${INVOICES}/draft${queryString({ inspectionId: target.inspectionId, propertyId: target.propertyId })}`,
        { signal },
      ),
    enabled: Boolean(key),
    // A draft is a starting point: read once, and never refetched under the editor.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function usePayments(query: PaymentQuery) {
  return useQuery({
    queryKey: invoiceKeys.payments(query),
    queryFn: ({ signal }) =>
      api<PaymentList>(
        `${PAYMENTS}${queryString({
          search: query.search?.trim(),
          method: query.method,
          page: query.page,
          paidFrom: query.paidFrom,
          paidTo: query.paidTo,
        })}`,
        { signal },
      ),
    placeholderData: (previous) => previous,
  });
}

/** One payment, for its own page. */
export function usePayment(id: string) {
  return useQuery({
    queryKey: invoiceKeys.payment(id),
    queryFn: ({ signal }) => api<PaymentDetail>(`${PAYMENTS}/${encodeURIComponent(id)}`, { signal }),
    enabled: Boolean(id),
  });
}

/** A key for one write, made when the form opens, so a resend is the same write. */
export function newClientRequestId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `web-${random}`;
}

export function useInvoiceActions() {
  const client = useQueryClient();
  const refresh = () => void client.invalidateQueries({ queryKey: invoiceKeys.all });
  return {
    /** Make the invoice for a finished visit, and send it to Jobber. */
    create: useMutation({
      mutationFn: (input: CreateInvoiceInput) =>
        api<InvoiceDetail>(INVOICES, { method: 'POST', body: JSON.stringify(input) }),
      onSuccess: (invoice) => {
        client.setQueryData(invoiceKeys.detail(invoice.id), invoice);
        refresh();
      },
    }),
    /** Make one invoice per company from one form (2026-11-10): together, or none of them. */
    createPerCompany: useMutation({
      mutationFn: (input: CreateInvoicesInput) =>
        api<CreatedInvoices>(`${INVOICES}/per-company`, { method: 'POST', body: JSON.stringify(input) }),
      onSuccess: refresh,
    }),
    /** Record a payment against an invoice, which marks it paid once it is all paid. */
    recordPayment: useMutation({
      mutationFn: ({ invoiceId, input }: { invoiceId: string; input: RecordPaymentInput }) =>
        api<InvoiceDetail>(`${INVOICES}/${encodeURIComponent(invoiceId)}/payments`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: (invoice) => {
        client.setQueryData(invoiceKeys.detail(invoice.id), invoice);
        refresh();
      },
    }),
    /** Correct a payment; its invoice's balance is worked out again on the server. */
    changePayment: useMutation({
      mutationFn: ({ paymentId, input }: { paymentId: string; input: ChangePaymentInput }) =>
        api<PaymentDetail>(`${PAYMENTS}/${encodeURIComponent(paymentId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
      onSuccess: (payment) => {
        client.setQueryData(invoiceKeys.payment(payment.id), payment);
        refresh();
      },
    }),
    /** Take a payment off its invoice, which then owes it again. */
    removePayment: useMutation({
      mutationFn: ({ paymentId, expectedUpdatedAt }: { paymentId: string; expectedUpdatedAt: string }) =>
        api<{ invoiceId: string }>(
          `${PAYMENTS}/${encodeURIComponent(paymentId)}${queryString({ expectedUpdatedAt })}`,
          { method: 'DELETE' },
        ),
      // Everything read again but the payment itself, which is gone: its page is
      // left as the caller moves on, rather than asked for and answered "not found".
      onSuccess: (_removed, { paymentId }) =>
        void client.invalidateQueries({
          queryKey: invoiceKeys.all,
          predicate: (query) => query.queryKey.join('/') !== invoiceKeys.payment(paymentId).join('/'),
        }),
    }),
  };
}
