'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { XeroConnectionView } from '@texasrenters/shared';

import { api } from './api';

/**
 * The office's Xero organisation (2026-11-10, phase 1 of the Xero plan). The
 * page reads the console's own copy of what Xero last said; only "Read from
 * Xero" asks Xero again, and the server allows that every five minutes at most.
 */

const XERO = '/api/v1/admin/integrations/xero';

export const xeroKey = ['admin', 'integrations', 'xero'] as const;

export function useXeroConnection(enabled = true) {
  return useQuery({
    queryKey: xeroKey,
    queryFn: ({ signal }) => api<XeroConnectionView>(`${XERO}/connection`, { signal }),
    enabled,
  });
}

export function useXeroActions() {
  const client = useQueryClient();
  const saved = (view: XeroConnectionView) => client.setQueryData(xeroKey, view);
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
