'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PurchasingSettings,
  RequisitionChoices,
  RequisitionDecisionInput,
  RequisitionDetail,
  RequisitionList,
  SavePurchasingSettingsInput,
  SaveRequisitionInput,
} from '@texasrenters/shared';

import { api } from './api';

/**
 * Purchasing (2026-11-19, phase 2): read when a page opens, kept a minute, and
 * read again after this page's own saves. Never polled: a requisition waits
 * for a person, and the list is looked at when somebody comes to decide.
 * Nothing it reads is billed.
 */

const BASE = '/api/v1/admin/purchasing';
const KEPT = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

export const purchasingKeys = {
  all: ['purchasing'] as const,
  list: (show: 'open' | 'closed') => ['purchasing', 'list', show] as const,
  detail: (requisitionId: string) => ['purchasing', 'requisition', requisitionId] as const,
  choices: ['purchasing', 'choices'] as const,
};

export function useRequisitions(show: 'open' | 'closed') {
  return useQuery({ queryKey: purchasingKeys.list(show), queryFn: ({ signal }) => api<RequisitionList>(`${BASE}/requisitions?show=${show}`, { signal }), ...KEPT });
}

export function useRequisition(requisitionId: string) {
  return useQuery({
    queryKey: purchasingKeys.detail(requisitionId),
    queryFn: ({ signal }) => api<RequisitionDetail>(`${BASE}/requisitions/${encodeURIComponent(requisitionId)}`, { signal }),
    enabled: Boolean(requisitionId),
    ...KEPT,
  });
}

/** What the form chooses from: read only while a form is open. */
export function useRequisitionChoices(enabled: boolean) {
  return useQuery({ queryKey: purchasingKeys.choices, queryFn: ({ signal }) => api<RequisitionChoices>(`${BASE}/choices`, { signal }), enabled, ...KEPT });
}

export type RequisitionStep = 'submit' | 'cancel' | 'approve' | 'send-back' | 'reject';

export function usePurchasingEdits() {
  const client = useQueryClient();
  /** A save answers with the requisition as it now is: kept as it came, and the lists read again when next looked at. */
  const saved = (detail: RequisitionDetail) => {
    const key = purchasingKeys.detail(detail.id);
    client.setQueryData(key, detail);
    const kept = JSON.stringify(key);
    void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === purchasingKeys.all[0] && query.queryKey[1] !== 'choices' && JSON.stringify(query.queryKey) !== kept });
  };
  const path = (requisitionId: string) => `${BASE}/requisitions/${encodeURIComponent(requisitionId)}`;

  return {
    create: useMutation({ mutationFn: (input: SaveRequisitionInput) => api<RequisitionDetail>(`${BASE}/requisitions`, { method: 'POST', body: JSON.stringify(input) }), onSuccess: saved }),
    update: useMutation({
      mutationFn: ({ requisitionId, input }: { requisitionId: string; input: SaveRequisitionInput }) => api<RequisitionDetail>(path(requisitionId), { method: 'PUT', body: JSON.stringify(input) }),
      onSuccess: saved,
    }),
    /** Submit and cancel are the requester's; approve, send back and reject are the approver's, with a note. */
    step: useMutation({
      mutationFn: ({ requisitionId, step, input = {} }: { requisitionId: string; step: RequisitionStep; input?: RequisitionDecisionInput }) =>
        api<RequisitionDetail>(`${path(requisitionId)}/${step}`, { method: 'POST', body: JSON.stringify(input) }),
      onSuccess: saved,
    }),
    saveSettings: useMutation({
      mutationFn: (input: SavePurchasingSettingsInput) => api<PurchasingSettings>(`${BASE}/settings`, { method: 'PUT', body: JSON.stringify(input) }),
      onSuccess: () => client.invalidateQueries({ queryKey: purchasingKeys.all }),
    }),
  };
}
