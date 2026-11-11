'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddBillingRulesInput,
  AddInvoiceProductsInput,
  ChangeInvoiceProductInput,
  InvoiceSettingsView,
  SaveInvoiceSettingsInput,
} from '@texasrenters/shared';

import { api } from './api';
import { invoiceKeys } from './invoice-queries';

/**
 * The office's invoice settings (2026-11-06, phase 6): the company details,
 * what a new invoice starts with, and the products and services at its
 * prices. Reads and writes of the console's own database; nothing billed is
 * called. Each write answers with the settings as they now are.
 */

const SETTINGS = '/api/v1/admin/invoice-settings';

export const invoiceSettingsKey = [...invoiceKeys.all, 'settings'] as const;

export function useInvoiceSettings() {
  return useQuery({
    queryKey: invoiceSettingsKey,
    queryFn: ({ signal }) => api<InvoiceSettingsView>(SETTINGS, { signal }),
  });
}

export function useInvoiceSettingsEdits() {
  const client = useQueryClient();
  const saved = (settings: InvoiceSettingsView) => {
    client.setQueryData(invoiceSettingsKey, settings);
    // The company on every invoice and receipt, and what a new invoice starts with, read again when next shown.
    void client.invalidateQueries({ queryKey: invoiceKeys.all, predicate: (query) => query.queryKey.at(-1) !== 'settings' });
  };
  return {
    save: useMutation({
      mutationFn: (input: SaveInvoiceSettingsInput) => api<InvoiceSettingsView>(SETTINGS, { method: 'PUT', body: JSON.stringify(input) }),
      onSuccess: saved,
    }),
    addProducts: useMutation({
      mutationFn: (input: AddInvoiceProductsInput) =>
        api<InvoiceSettingsView>(`${SETTINGS}/products`, { method: 'POST', body: JSON.stringify(input) }),
      onSuccess: saved,
    }),
    changeProduct: useMutation({
      mutationFn: ({ id, input }: { id: string; input: ChangeInvoiceProductInput }) =>
        api<InvoiceSettingsView>(`${SETTINGS}/products/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
      onSuccess: saved,
    }),
    // What a finished visit bills (2026-11-12).
    addBillingRules: useMutation({
      mutationFn: (input: AddBillingRulesInput) =>
        api<InvoiceSettingsView>(`${SETTINGS}/billing-rules`, { method: 'POST', body: JSON.stringify(input) }),
      onSuccess: saved,
    }),
    removeBillingRule: useMutation({
      mutationFn: (id: string) => api<InvoiceSettingsView>(`${SETTINGS}/billing-rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      onSuccess: saved,
    }),
  };
}
