'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PropertyAccount,
  SaveStatementSettingsInput,
  SendStatementInput,
  StatementQuery,
  StatementSettingsView,
  StatementView,
} from '@texasrenters/shared';

import { api } from './api';
import { invoiceKeys } from './invoice-queries';

/**
 * A property's account and its statement (2026-11-10, phase 3 of the invoice
 * gap review). Reads of the console's own copy, under the invoices' key so a
 * payment or an edit reads them again. A statement is emailed -- a billed
 * call -- only on the press, under its key.
 */

const PROPERTIES = '/api/v1/admin/properties';
const SETTINGS = '/api/v1/admin/invoice-settings/statements';

export const accountKey = (propertyId: string) => [...invoiceKeys.all, 'account', propertyId] as const;
export const statementSettingsKey = [...invoiceKeys.all, 'statement-settings'] as const;

export function usePropertyAccount(propertyId: string, enabled = true) {
  return useQuery({
    queryKey: accountKey(propertyId),
    queryFn: ({ signal }) => api<PropertyAccount>(`${PROPERTIES}/${encodeURIComponent(propertyId)}/account`, { signal }),
    enabled: enabled && Boolean(propertyId),
  });
}

/** The statement itself, read when somebody downloads it: never on a load. */
export function fetchStatement(propertyId: string, query: StatementQuery) {
  const search = new URLSearchParams({ period: query.period, ...(query.from ? { from: query.from } : {}) });
  return api<StatementView>(`${PROPERTIES}/${encodeURIComponent(propertyId)}/statement?${search.toString()}`);
}

export function useSendStatement(propertyId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SendStatementInput) =>
      api<PropertyAccount>(`${PROPERTIES}/${encodeURIComponent(propertyId)}/statement`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: (account) => client.setQueryData(accountKey(propertyId), account),
    // Sent or not, it is on the record: the card lists it.
    onError: () => void client.invalidateQueries({ queryKey: accountKey(propertyId) }),
  });
}

export function useStatementSettings() {
  return useQuery({
    queryKey: statementSettingsKey,
    queryFn: ({ signal }) => api<StatementSettingsView>(SETTINGS, { signal }),
  });
}

export function useSaveStatementSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveStatementSettingsInput) => api<StatementSettingsView>(SETTINGS, { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: (settings) => client.setQueryData(statementSettingsKey, settings),
    onError: () => void client.invalidateQueries({ queryKey: statementSettingsKey }),
  });
}
