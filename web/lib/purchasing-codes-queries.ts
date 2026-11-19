'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PurchasingCodes, SavePurchaserCodeInput, SavePurchasingCodeInput } from '@texasrenters/shared';

import { api } from './api';
import { inventoryKeys } from './inventory-queries';

/**
 * Purchasing codes (2026-11-20): read when the Codes tab opens, kept a minute,
 * and replaced by what each save answers. Never polled. The Xero tracking
 * options come from the catalog the console already keeps: nothing billed.
 */

const BASE = '/api/v1/admin/purchasing';
const KEPT = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

export const purchasingCodeKeys = { codes: ['purchasing-codes'] as const };

export function usePurchasingCodes(enabled = true) {
  return useQuery({ queryKey: purchasingCodeKeys.codes, queryFn: ({ signal }) => api<PurchasingCodes>(`${BASE}/codes`, { signal }), enabled, ...KEPT });
}

export function usePurchasingCodeEdits() {
  const client = useQueryClient();
  const saved = (codes: PurchasingCodes) => {
    client.setQueryData(purchasingCodeKeys.codes, codes);
    // A line type's name shows on the Item codes tab.
    void client.invalidateQueries({ queryKey: inventoryKeys.stock });
  };
  return {
    create: useMutation({ mutationFn: (input: SavePurchasingCodeInput) => api<PurchasingCodes>(`${BASE}/codes`, { method: 'POST', body: JSON.stringify(input) }), onSuccess: saved }),
    update: useMutation({
      mutationFn: ({ codeId, input }: { codeId: string; input: SavePurchasingCodeInput }) => api<PurchasingCodes>(`${BASE}/codes/${encodeURIComponent(codeId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
      onSuccess: saved,
    }),
    setPurchaserCode: useMutation({
      mutationFn: ({ xeroTenantId, input }: { xeroTenantId: string; input: SavePurchaserCodeInput }) =>
        api<PurchasingCodes>(`${BASE}/companies/${encodeURIComponent(xeroTenantId)}/purchaser-code`, { method: 'PUT', body: JSON.stringify(input) }),
      onSuccess: saved,
    }),
  };
}
