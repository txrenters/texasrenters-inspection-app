'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SaveXeroSettingsInput, XeroBooksView, XeroCheckView, XeroConnectionView, XeroSendingView, XeroSettingsView } from '@texasrenters/shared';

import { ApiError, api } from './api';

/**
 * The office's Xero organisations (2026-11-10): one sign-in, each company's
 * books an organisation of its own, with its own choices and its own sending.
 * The page reads the console's own copy of what Xero last said; only "Read
 * from Xero" asks Xero again, one organisation at a time and every five
 * minutes at most. Choosing accounts never calls Xero.
 */

const XERO = '/api/v1/admin/integrations/xero';
const organisation = (tenantId: string) => `${XERO}/organisations/${encodeURIComponent(tenantId)}`;

export const xeroKey = ['admin', 'integrations', 'xero'] as const;
const connectionKey = [...xeroKey, 'connection'] as const;
export const xeroSettingsKey = (tenantId: string) => [...xeroKey, 'settings', tenantId] as const;
export const xeroSendingKey = (tenantId: string) => [...xeroKey, 'sending', tenantId] as const;
export const xeroCheckKey = (tenantId: string, month: string) => [...xeroKey, 'check', tenantId, month] as const;
export const xeroBooksKey = (tenantId: string) => [...xeroKey, 'books', tenantId] as const;

export function useXeroConnection(enabled = true) {
  return useQuery({
    queryKey: connectionKey,
    queryFn: ({ signal }) => api<XeroConnectionView>(`${XERO}/connection`, { signal }),
    enabled,
  });
}

export function useXeroActions() {
  const client = useQueryClient();
  const saved = (view: XeroConnectionView) => {
    client.setQueryData(connectionKey, view);
    // The choices are checked against what was read, and so is sending (Xero's reminders): a new read, or none, changes both.
    void client.invalidateQueries({ queryKey: [...xeroKey, 'settings'] });
    void client.invalidateQueries({ queryKey: [...xeroKey, 'sending'] });
  };
  return {
    authorize: useMutation({
      mutationFn: () => api<{ authorizationUrl: string }>(`${XERO}/oauth/authorize`, { method: 'POST' }),
    }),
    read: useMutation({
      mutationFn: (tenantId: string) => api<XeroConnectionView>(`${organisation(tenantId)}/read`, { method: 'POST' }),
      onSuccess: saved,
      onError: () => void client.invalidateQueries({ queryKey: xeroKey }),
    }),
    disconnectOrganisation: useMutation({
      mutationFn: (tenantId: string) => api<XeroConnectionView & { removedAtXero: boolean }>(`${organisation(tenantId)}/disconnect`, { method: 'POST' }),
      onSuccess: saved,
    }),
    disconnect: useMutation({
      mutationFn: () => api<XeroConnectionView & { removedAtXero: boolean }>(`${XERO}/disconnect`, { method: 'POST' }),
      onSuccess: saved,
    }),
  };
}

/** What goes where in one organisation: the console's own record, no call to Xero. */
export function useXeroSettings(tenantId: string, enabled = true) {
  return useQuery({
    queryKey: xeroSettingsKey(tenantId),
    queryFn: ({ signal }) => api<XeroSettingsView>(`${organisation(tenantId)}/settings`, { signal }),
    enabled,
  });
}

export function useSaveXeroSettings(tenantId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveXeroSettingsInput) =>
      api<XeroSettingsView>(`${organisation(tenantId)}/settings`, { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: (view) => {
      client.setQueryData(xeroSettingsKey(tenantId), view);
      // Whether sending may run follows the choices.
      void client.invalidateQueries({ queryKey: xeroSendingKey(tenantId) });
    },
    // Somebody saved in between: show theirs.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) void client.invalidateQueries({ queryKey: xeroSettingsKey(tenantId) });
    },
  });
}

/** Sending invoices to one organisation: the console's own record of what went, no call to Xero. */
export function useXeroSending(tenantId: string, enabled = true) {
  return useQuery({
    queryKey: xeroSendingKey(tenantId),
    queryFn: ({ signal }) => api<XeroSendingView>(`${organisation(tenantId)}/sending`, { signal }),
    enabled,
  });
}

export function useXeroSendingActions(tenantId: string) {
  const client = useQueryClient();
  const saved = (view: XeroSendingView) => client.setQueryData(xeroSendingKey(tenantId), view);
  const refetch = () => void client.invalidateQueries({ queryKey: xeroSendingKey(tenantId) });
  return {
    setEnabled: useMutation({
      mutationFn: (enabled: boolean) => api<XeroSendingView>(`${organisation(tenantId)}/sending`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
      onSuccess: saved,
      onError: refetch,
    }),
    // A run answers once it is done: it may take a few seconds while Xero answers.
    run: useMutation({
      mutationFn: () => api<XeroSendingView>(`${organisation(tenantId)}/sending/run`, { method: 'POST' }),
      onSuccess: saved,
      onError: refetch,
    }),
    retry: useMutation({
      mutationFn: () => api<XeroSendingView>(`${organisation(tenantId)}/sending/retry`, { method: 'POST' }),
      onSuccess: saved,
    }),
  };
}

/**
 * A month's latest check against Xero (2026-11-10, phase 5), from the console's
 * record: reading it never asks Xero. Only "Check now" does.
 */
export function useXeroCheck(tenantId: string, month: string, enabled = true) {
  return useQuery({
    queryKey: xeroCheckKey(tenantId, month),
    queryFn: ({ signal }) => api<XeroCheckView>(`${organisation(tenantId)}/check?month=${encodeURIComponent(month)}`, { signal }),
    enabled,
  });
}

/** "Check now": reads the month from Xero -- one call per 100 invoices -- and keeps what differs. */
export function useRunXeroCheck(tenantId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (month: string) => api<XeroCheckView>(`${organisation(tenantId)}/check`, { method: 'POST', body: JSON.stringify({ month }) }),
    onSuccess: (view) => client.setQueryData(xeroCheckKey(tenantId, view.month), view),
  });
}

/**
 * The company's books read back from Xero (2026-11-12): what has been read,
 * from the console's own rows. Reading it never asks Xero; the server reads
 * every hour, and "Read invoices from Xero now" once more.
 */
export function useXeroBooks(tenantId: string, enabled = true) {
  return useQuery({
    queryKey: xeroBooksKey(tenantId),
    queryFn: ({ signal }) => api<XeroBooksView>(`${organisation(tenantId)}/books`, { signal }),
    enabled,
  });
}

/** "Read invoices from Xero now": a page of its invoices and one of its payments -- two calls -- at most once a minute. */
export function useReadXeroBooks(tenantId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<XeroBooksView>(`${organisation(tenantId)}/books/read`, { method: 'POST' }),
    onSuccess: (view) => client.setQueryData(xeroBooksKey(tenantId), view),
    onError: () => void client.invalidateQueries({ queryKey: xeroBooksKey(tenantId) }),
  });
}
