'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SaveXeroSettingsInput, XeroConnectionView, XeroSettingsView } from '@texasrenters/shared';

import { ApiError, api } from './api';

/**
 * The office's Xero organisations (2026-11-10): one sign-in, each company's
 * books an organisation of its own. The page reads the console's own copy of
 * what Xero last said; only "Read from Xero" asks Xero again, one organisation
 * at a time and every five minutes at most. Choosing accounts never calls Xero.
 */

const XERO = '/api/v1/admin/integrations/xero';
const organisation = (tenantId: string) => `${XERO}/organisations/${encodeURIComponent(tenantId)}`;

export const xeroKey = ['admin', 'integrations', 'xero'] as const;
const connectionKey = [...xeroKey, 'connection'] as const;
export const xeroSettingsKey = (tenantId: string) => [...xeroKey, 'settings', tenantId] as const;

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
    // The choices are checked against what was read: a new read, or none, changes the checks.
    void client.invalidateQueries({ queryKey: [...xeroKey, 'settings'] });
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
    onSuccess: (view) => client.setQueryData(xeroSettingsKey(tenantId), view),
    // Somebody saved in between: show theirs.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) void client.invalidateQueries({ queryKey: xeroSettingsKey(tenantId) });
    },
  });
}
