'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InvoiceTakeoverView, TakeOverInvoicingInput } from '@texasrenters/shared';

import { api } from './api';
import { invoiceKeys } from './invoice-queries';

/**
 * Taking invoicing over from Jobber (2026-11-06, phase 8): what it waits on,
 * taking it over -- which reads Jobber one last time on the server -- and
 * undoing that while nothing has changed since. Neither is billed.
 */

const TAKEOVER = '/api/v1/admin/invoice-takeover';

export const invoiceTakeoverKey = [...invoiceKeys.all, 'takeover'] as const;

export function useInvoiceTakeover() {
  return useQuery({
    queryKey: invoiceTakeoverKey,
    queryFn: ({ signal }) => api<InvoiceTakeoverView>(TAKEOVER, { signal }),
  });
}

export function useInvoiceTakeoverActions() {
  const client = useQueryClient();
  const done = (view: InvoiceTakeoverView) => {
    client.setQueryData(invoiceTakeoverKey, view);
    // Every invoice page's Edit, New invoice, Record payment and Send turn on or off with it.
    void client.invalidateQueries({ queryKey: invoiceKeys.all, predicate: (query) => query.queryKey.at(-1) !== 'takeover' });
  };
  return {
    takeOver: useMutation({
      mutationFn: (input: TakeOverInvoicingInput) => api<InvoiceTakeoverView>(TAKEOVER, { method: 'POST', body: JSON.stringify(input) }),
      onSuccess: done,
    }),
    undo: useMutation({
      mutationFn: () => api<InvoiceTakeoverView>(`${TAKEOVER}/undo`, { method: 'POST' }),
      onSuccess: done,
    }),
  };
}
