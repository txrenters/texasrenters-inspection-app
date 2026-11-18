'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApproveVendorBillInput,
  CancelPurchaseOrderInput,
  CloseShortInput,
  PayVendorBillInput,
  PurchaseOrderDecisionInput,
  PurchaseOrderDetail,
  PurchaseOrderList,
  PurchasingSettings,
  RequisitionChoices,
  RequisitionDecisionInput,
  RequisitionDetail,
  RequisitionList,
  ReceiveGoodsInput,
  ReverseReceiptInput,
  SavePurchaseOrderInput,
  SavePurchasingSettingsInput,
  SaveRequisitionInput,
  SaveVendorBillInput,
  SendPurchaseOrderInput,
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
  orders: (show: 'open' | 'closed') => ['purchasing', 'orders', show] as const,
  order: (orderId: string) => ['purchasing', 'order', orderId] as const,
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

export function usePurchaseOrders(show: 'open' | 'closed', enabled: boolean) {
  return useQuery({ queryKey: purchasingKeys.orders(show), queryFn: ({ signal }) => api<PurchaseOrderList>(`${BASE}/orders?show=${show}`, { signal }), enabled, ...KEPT });
}

export function usePurchaseOrder(orderId: string) {
  return useQuery({
    queryKey: purchasingKeys.order(orderId),
    queryFn: ({ signal }) => api<PurchaseOrderDetail>(`${BASE}/orders/${encodeURIComponent(orderId)}`, { signal }),
    enabled: Boolean(orderId),
    ...KEPT,
  });
}

export type PurchaseOrderStep = 'submit' | 'approve' | 'send-back' | 'cancel';

/**
 * An order's saves. Each answers with the order as it now is, which is kept
 * as it came; the lists, and the requisition it was made from, are read again
 * when next looked at. Sending is the one that costs: one email a press.
 */
export function usePurchaseOrderEdits() {
  const client = useQueryClient();
  const saved = (detail: PurchaseOrderDetail) => {
    const key = purchasingKeys.order(detail.id);
    client.setQueryData(key, detail);
    const kept = JSON.stringify(key);
    void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === purchasingKeys.all[0] && query.queryKey[1] !== 'choices' && JSON.stringify(query.queryKey) !== kept });
  };
  const path = (orderId: string) => `${BASE}/orders/${encodeURIComponent(orderId)}`;
  return {
    create: useMutation({
      mutationFn: (requisitionId: string) => api<PurchaseOrderDetail>(`${BASE}/requisitions/${encodeURIComponent(requisitionId)}/order`, { method: 'POST', body: '{}' }),
      onSuccess: saved,
    }),
    update: useMutation({
      mutationFn: ({ orderId, input }: { orderId: string; input: SavePurchaseOrderInput }) => api<PurchaseOrderDetail>(path(orderId), { method: 'PUT', body: JSON.stringify(input) }),
      onSuccess: saved,
    }),
    step: useMutation({
      mutationFn: ({ orderId, step, input = {} }: { orderId: string; step: PurchaseOrderStep; input?: PurchaseOrderDecisionInput | CancelPurchaseOrderInput }) =>
        api<PurchaseOrderDetail>(`${path(orderId)}/${step}`, { method: 'POST', body: JSON.stringify(input) }),
      onSuccess: saved,
    }),
    send: useMutation({
      mutationFn: ({ orderId, input }: { orderId: string; input: SendPurchaseOrderInput }) => api<PurchaseOrderDetail>(`${path(orderId)}/send`, { method: 'POST', body: JSON.stringify(input) }),
      onSuccess: saved,
    }),
  };
}

/**
 * Receiving and the vendor's bill (phase 4). Each save answers with the order
 * as it now is. Posting or reversing a receipt changes stock, so what the
 * Inventory pages hold is read again when next looked at.
 */
export function usePurchaseReceivingEdits() {
  const client = useQueryClient();
  const saved = (stock: boolean) => (detail: PurchaseOrderDetail) => {
    const key = purchasingKeys.order(detail.id);
    client.setQueryData(key, detail);
    const kept = JSON.stringify(key);
    void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === purchasingKeys.all[0] && query.queryKey[1] !== 'choices' && JSON.stringify(query.queryKey) !== kept });
    if (stock) void client.invalidateQueries({ queryKey: ['inventory'] });
  };
  const order = (orderId: string) => `${BASE}/orders/${encodeURIComponent(orderId)}`;
  const post = (path: string, input: object = {}) => api<PurchaseOrderDetail>(path, { method: 'POST', body: JSON.stringify(input) });
  return {
    receive: useMutation({ mutationFn: ({ orderId, input }: { orderId: string; input: ReceiveGoodsInput }) => post(`${order(orderId)}/receipts`, input), onSuccess: saved(true) }),
    reverseReceipt: useMutation({
      mutationFn: ({ receiptId, input }: { receiptId: string; input: ReverseReceiptInput }) => post(`${BASE}/receipts/${encodeURIComponent(receiptId)}/reverse`, input),
      onSuccess: saved(true),
    }),
    closeShort: useMutation({ mutationFn: ({ orderId, input }: { orderId: string; input: CloseShortInput }) => post(`${order(orderId)}/close-short`, input), onSuccess: saved(false) }),
    saveBill: useMutation({
      mutationFn: ({ orderId, input }: { orderId: string; input: SaveVendorBillInput }) => api<PurchaseOrderDetail>(`${order(orderId)}/bill`, { method: 'PUT', body: JSON.stringify(input) }),
      onSuccess: saved(false),
    }),
    approveBill: useMutation({ mutationFn: (orderId: string) => post(`${order(orderId)}/bill/approve`), onSuccess: saved(false) }),
    approveBillAnyway: useMutation({ mutationFn: ({ orderId, input }: { orderId: string; input: ApproveVendorBillInput }) => post(`${order(orderId)}/bill/approve-anyway`, input), onSuccess: saved(false) }),
    payBill: useMutation({ mutationFn: ({ orderId, input }: { orderId: string; input: PayVendorBillInput }) => post(`${order(orderId)}/bill/pay`, input), onSuccess: saved(false) }),
  };
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
