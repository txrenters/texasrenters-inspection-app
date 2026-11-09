'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SaveXeroSettingsInput, XeroConnectionView, XeroSendingView, XeroSettingsView } from '@texasrenters/shared';

import { ApiError, api } from './api';

/**
 * The office's Xero organisation (2026-11-10, phases 1-2 of the Xero plan).
 * The page reads the console's own copy of what Xero last said; only "Read
 * from Xero" asks Xero again, and the server allows that every five minutes at
 * most. Choosing accounts never calls Xero.
 */

const XERO = '/api/v1/admin/integrations/xero';

export const xeroKey = ['admin', 'integrations', 'xero'] as const;
const connectionKey = [...xeroKey, 'connection'] as const;
export const xeroSettingsKey = [...xeroKey, 'settings'] as const;
export const xeroSendingKey = [...xeroKey, 'sending'] as const;

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
    void client.invalidateQueries({ queryKey: xeroSettingsKey });
    void client.invalidateQueries({ queryKey: xeroSendingKey });
  };
  return {
    authorize: useMutation({
      mutationFn: () => api<{ authorizationUrl: string }>(`${XERO}/oauth/authorize`, { method: 'POST' }),
    }),
    read: useMutation({
      mutationFn: () => api<XeroConnectionView>(`${XERO}/read`, { method: 'POST' }),
      onSuccess: saved,
      onError: () => void client.invalidateQueries({ queryKey: xeroKey }),
    }),
    disconnect: useMutation({
      mutationFn: () => api<XeroConnectionView & { removedAtXero: boolean }>(`${XERO}/disconnect`, { method: 'POST' }),
      onSuccess: saved,
    }),
  };
}

/** What goes where in Xero (phase 2): the console's own record, no call to Xero. */
export function useXeroSettings(enabled = true) {
  return useQuery({
    queryKey: xeroSettingsKey,
    queryFn: ({ signal }) => api<XeroSettingsView>(`${XERO}/settings`, { signal }),
    enabled,
  });
}

export function useSaveXeroSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveXeroSettingsInput) => api<XeroSettingsView>(`${XERO}/settings`, { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: (view) => {
      client.setQueryData(xeroSettingsKey, view);
      // Whether sending may run follows the choices.
      void client.invalidateQueries({ queryKey: xeroSendingKey });
    },
    // Somebody saved in between: show theirs.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) void client.invalidateQueries({ queryKey: xeroSettingsKey });
    },
  });
}

/** Sending invoices (phase 3): the console's own record of what went, no call to Xero. */
export function useXeroSending(enabled = true) {
  return useQuery({
    queryKey: xeroSendingKey,
    queryFn: ({ signal }) => api<XeroSendingView>(`${XERO}/sending`, { signal }),
    enabled,
  });
}

export function useXeroSendingActions() {
  const client = useQueryClient();
  const saved = (view: XeroSendingView) => client.setQueryData(xeroSendingKey, view);
  const refetch = () => void client.invalidateQueries({ queryKey: xeroSendingKey });
  return {
    setEnabled: useMutation({
      mutationFn: (enabled: boolean) => api<XeroSendingView>(`${XERO}/sending`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
      onSuccess: saved,
      onError: refetch,
    }),
    // A run answers once it is done: it may take a few seconds while Xero answers.
    run: useMutation({
      mutationFn: () => api<XeroSendingView>(`${XERO}/sending/run`, { method: 'POST' }),
      onSuccess: saved,
      onError: refetch,
    }),
    retry: useMutation({
      mutationFn: () => api<XeroSendingView>(`${XERO}/sending/retry`, { method: 'POST' }),
      onSuccess: saved,
    }),
  };
}
