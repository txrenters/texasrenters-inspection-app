'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SaveXeroBillSettingsInput, VendorBillInXero, XeroBillSettingsView } from '@texasrenters/shared';

import { api } from './api';

/**
 * Vendor bills to Xero (2026-11-19, phase 7). A bill's standing is read from
 * the console's own database when the order's page opens, and again after the
 * bill is approved or paid there: no call to Xero. Xero is called only when
 * somebody presses "Send to Xero" or "Send the payment", once a press. Nothing
 * here is polled.
 */

const BASE = '/api/v1/admin/purchasing';
const KEPT = { staleTime: 60_000, refetchOnWindowFocus: false } as const;
const standingPath = (orderId: string) => `${BASE}/orders/${encodeURIComponent(orderId)}/bill/xero`;
const settingsPath = (tenantId: string) => `${BASE}/xero-bills/${encodeURIComponent(tenantId)}/settings`;

/** Under the purchasing pages' own key, so approving or paying the bill reads it again. */
export const billInXeroKey = (orderId: string) => ['purchasing', 'bill-xero', orderId] as const;
export const xeroBillSettingsKey = (tenantId: string) => ['xero-bills', 'settings', tenantId] as const;

export function useBillInXero(orderId: string, enabled: boolean) {
  return useQuery({ queryKey: billInXeroKey(orderId), queryFn: ({ signal }) => api<VendorBillInXero>(standingPath(orderId), { signal }), enabled, ...KEPT });
}

/** Each is one press and one request. A refusal leaves a reason on the bill, so the standing is read again either way. */
export function useBillInXeroActions(orderId: string) {
  const client = useQueryClient();
  const settled = { onSuccess: (view: VendorBillInXero) => client.setQueryData(billInXeroKey(orderId), view), onError: () => void client.invalidateQueries({ queryKey: billInXeroKey(orderId) }) };
  const post = (path: string) => api<VendorBillInXero>(path, { method: 'POST', body: '{}' });
  return {
    send: useMutation({ mutationFn: () => post(standingPath(orderId)), ...settled }),
    sendPayment: useMutation({ mutationFn: () => post(`${standingPath(orderId)}/payment`), ...settled }),
  };
}

export function useXeroBillSettings(tenantId: string, enabled: boolean) {
  return useQuery({ queryKey: xeroBillSettingsKey(tenantId), queryFn: ({ signal }) => api<XeroBillSettingsView>(settingsPath(tenantId), { signal }), enabled, ...KEPT });
}

export function useSaveXeroBillSettings(tenantId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveXeroBillSettingsInput) => api<XeroBillSettingsView>(settingsPath(tenantId), { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: (view) => {
      client.setQueryData(xeroBillSettingsKey(tenantId), view);
      // What a bill waits on may have changed.
      void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'purchasing' && query.queryKey[1] === 'bill-xero' });
    },
  });
}
