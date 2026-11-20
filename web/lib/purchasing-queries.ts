'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddRequisitionLinkInput,
  AddRequisitionNoteInput,
  ApproveVendorBillInput,
  CancelPurchaseOrderInput,
  CloseShortInput,
  PayVendorBillInput,
  PurchaseOrderDecisionInput,
  PurchaseOrderDetail,
  PurchaseOrdersMade,
  PurchaseOrderList,
  PurchaseOrderRow,
  AddPurchasingPersonInput,
  DocumentSeriesKind,
  PurchasingPeople,
  PurchasingRoleKey,
  PurchasingSetup,
  RequisitionChoices,
  RequisitionDecisionInput,
  RequisitionDetail,
  RequisitionFileLink,
  RequisitionList,
  RequisitionRow,
  ReceiveGoodsInput,
  ReverseReceiptInput,
  SavePurchaseOrderInput,
  SaveCodeKeepersInput,
  SaveDocumentSeriesInput,
  SavePurchasingPersonInput,
  SavePurchasingApprovalsInput,
  SaveRequisitionFileRulesInput,
  SaveRequisitionPageInput,
  SaveRequisitionInput,
  SaveVendorBillInput,
  SendPurchaseOrderInput,
  SetRequisitionFileInput,
} from '@texasrenters/shared';

import { api, apiBlob, apiUpload } from './api';

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
  setup: ['purchasing', 'setup'] as const,
  people: ['purchasing', 'setup', 'people'] as const,
  toApprove: (what: 'requisitions' | 'orders') => ['purchasing', 'to-approve', what] as const,
};

/** Purchasing Setup (2026-11-20, part 5a): only a system admin or a Purchasing admin reads it. */
export function usePurchasingSetup(enabled: boolean) {
  return useQuery({ queryKey: purchasingKeys.setup, queryFn: ({ signal }) => api<PurchasingSetup>(`${BASE}/setup`, { signal }), enabled, ...KEPT });
}

/** Setup's roles and who holds them (part 5b, 2026-11-21). */
export function usePurchasingPeople(enabled: boolean) {
  return useQuery({ queryKey: purchasingKeys.people, queryFn: ({ signal }) => api<PurchasingPeople>(`${BASE}/setup/people`, { signal }), enabled, ...KEPT });
}

/** Giving and taking a role, a person's companies and limit, adding a person: each answers with the whole list. */
export function usePurchasingPeopleEdits() {
  const client = useQueryClient();
  const saved = (people: PurchasingPeople) => client.setQueryData(purchasingKeys.people, people);
  const path = (personId: string) => `${BASE}/setup/people/${encodeURIComponent(personId)}`;
  return {
    setRole: useMutation({
      mutationFn: ({ personId, role, held }: { personId: string; role: PurchasingRoleKey; held: boolean }) =>
        api<PurchasingPeople>(`${path(personId)}/roles/${encodeURIComponent(role)}`, { method: 'PUT', body: JSON.stringify({ held }) }),
      onSuccess: saved,
    }),
    savePerson: useMutation({
      mutationFn: ({ personId, input }: { personId: string; input: SavePurchasingPersonInput }) => api<PurchasingPeople>(path(personId), { method: 'PUT', body: JSON.stringify(input) }),
      onSuccess: saved,
    }),
    addPerson: useMutation({
      mutationFn: (input: AddPurchasingPersonInput) => api<PurchasingPeople>(`${BASE}/setup/people`, { method: 'POST', body: JSON.stringify(input) }),
      onSuccess: saved,
    }),
  };
}

/**
 * Each section of Setup saves on its own, as the page saves as it goes. Every
 * save answers with the whole Setup, kept as it came; the requisitions and
 * orders, held to it, are read again when next looked at.
 */
export function usePurchasingSetupEdits() {
  const client = useQueryClient();
  const saved = (setup: PurchasingSetup) => {
    client.setQueryData(purchasingKeys.setup, setup);
    void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === purchasingKeys.all[0] && query.queryKey[1] !== 'setup' });
  };
  const put = <Input,>(path: string) => (input: Input) => api<PurchasingSetup>(`${BASE}/setup/${path}`, { method: 'PUT', body: JSON.stringify(input) });
  return {
    approvals: useMutation({ mutationFn: put<SavePurchasingApprovalsInput>('approvals'), onSuccess: saved }),
    files: useMutation({ mutationFn: put<SaveRequisitionFileRulesInput>('files'), onSuccess: saved }),
    // Part 5c (2026-11-21): who keeps each code list, and the requisition page.
    codes: useMutation({ mutationFn: put<SaveCodeKeepersInput>('codes'), onSuccess: saved }),
    page: useMutation({ mutationFn: put<SaveRequisitionPageInput>('page'), onSuccess: saved }),
    series: useMutation({
      mutationFn: ({ kind, input }: { kind: DocumentSeriesKind; input: SaveDocumentSeriesInput }) => put<SaveDocumentSeriesInput>(`numbers/${encodeURIComponent(kind)}`)(input),
      onSuccess: saved,
    }),
  };
}

export function useRequisitions(show: 'open' | 'closed', enabled = true) {
  return useQuery({ queryKey: purchasingKeys.list(show), queryFn: ({ signal }) => api<RequisitionList>(`${BASE}/requisitions?show=${show}`, { signal }), enabled, ...KEPT });
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

/** Requests to Approve (2026-11-21): what waits for the caller's approval -- requisitions for an approver, orders for a purchasing manager. */
export function useRequisitionsToApprove(enabled: boolean) {
  return useQuery({ queryKey: purchasingKeys.toApprove('requisitions'), queryFn: ({ signal }) => api<RequisitionRow[]>(`${BASE}/requisitions/to-approve`, { signal }), enabled, ...KEPT });
}
export function useOrdersToApprove(enabled: boolean) {
  return useQuery({ queryKey: purchasingKeys.toApprove('orders'), queryFn: ({ signal }) => api<PurchaseOrderRow[]>(`${BASE}/orders/to-approve`, { signal }), enabled, ...KEPT });
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
    // One draft order a vendor still without one (2026-11-20): the requisition and the order lists are read again.
    create: useMutation({
      mutationFn: (requisitionId: string) => api<PurchaseOrdersMade>(`${BASE}/requisitions/${encodeURIComponent(requisitionId)}/order`, { method: 'POST', body: '{}' }),
      onSuccess: () => void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === purchasingKeys.all[0] && query.queryKey[1] !== 'choices' }),
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

/** `recall` is "Cancel Approval Request", `reopen` NAV's Reopen (2026-11-20). */
export type RequisitionStep = 'submit' | 'cancel' | 'approve' | 'send-back' | 'reject' | 'recall' | 'reopen';

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
  };
}

/**
 * Files on a requisition (2026-11-20, part 3). Each answers with the
 * requisition as it now is, kept as it came; an order made from it is read
 * again when next looked at, since a tick changes what goes to the vendor.
 * Attaching is one storage write a file; nothing here is billed.
 */
export function useRequisitionFiles(requisitionId: string) {
  const client = useQueryClient();
  const saved = (detail: RequisitionDetail) => {
    const key = purchasingKeys.detail(detail.id);
    client.setQueryData(key, detail);
    void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === purchasingKeys.all[0] && query.queryKey[1] === 'order' });
  };
  const files = `${BASE}/requisitions/${encodeURIComponent(requisitionId)}/files`;
  return {
    attach: useMutation({
      mutationFn: ({ file, onProgress }: { file: File; onProgress?: (fraction: number) => void }) => {
        const form = new FormData();
        form.append('file', file);
        return apiUpload<RequisitionDetail>(files, form, { onProgress });
      },
      onSuccess: saved,
    }),
    setForVendor: useMutation({
      mutationFn: ({ fileId, forVendor }: { fileId: string; forVendor: boolean }) =>
        api<RequisitionDetail>(`${files}/${encodeURIComponent(fileId)}`, { method: 'PATCH', body: JSON.stringify({ forVendor } satisfies SetRequisitionFileInput) }),
      onSuccess: saved,
    }),
    remove: useMutation({
      mutationFn: (fileId: string) => api<RequisitionDetail>(`${files}/${encodeURIComponent(fileId)}`, { method: 'DELETE' }),
      onSuccess: saved,
    }),
  };
}

/**
 * Notes, comments and links on a requisition (2026-11-20, Show Attached). Each
 * answers with the requisition as it now is, kept as it came. Nothing billed.
 */
export function useRequisitionNotes(requisitionId: string) {
  const client = useQueryClient();
  const saved = (detail: RequisitionDetail) => client.setQueryData(purchasingKeys.detail(detail.id), detail);
  const path = `${BASE}/requisitions/${encodeURIComponent(requisitionId)}`;
  const post = (where: string, body: AddRequisitionNoteInput | AddRequisitionLinkInput) => api<RequisitionDetail>(`${path}/${where}`, { method: 'POST', body: JSON.stringify(body) });
  return {
    addNote: useMutation({ mutationFn: (text: string) => post('notes', { text }), onSuccess: saved }),
    removeNote: useMutation({ mutationFn: (noteId: string) => api<RequisitionDetail>(`${path}/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' }), onSuccess: saved }),
    comment: useMutation({ mutationFn: (text: string) => post('comments', { text }), onSuccess: saved }),
    addLink: useMutation({ mutationFn: (link: AddRequisitionLinkInput) => post('links', link), onSuccess: saved }),
    removeLink: useMutation({ mutationFn: (linkId: string) => api<RequisitionDetail>(`${path}/links/${encodeURIComponent(linkId)}`, { method: 'DELETE' }), onSuccess: saved }),
  };
}

/**
 * Previous and Next on the ribbon: the requisition before or after this one,
 * open ones first, newest first, as the list shows them. The lists are read
 * only when one is pressed, and kept a minute like the list page's.
 */
export function useRequisitionSiblings() {
  const client = useQueryClient();
  return async (requisitionId: string, step: 1 | -1): Promise<string | null> => {
    const lists = await Promise.all(
      (['open', 'closed'] as const).map((show) =>
        client.fetchQuery({ queryKey: purchasingKeys.list(show), queryFn: () => api<RequisitionList>(`${BASE}/requisitions?show=${show}`), staleTime: KEPT.staleTime }),
      ),
    );
    const ids = lists.flatMap((list) => list.requisitions.map((row) => row.id));
    const at = ids.indexOf(requisitionId);
    return at < 0 ? null : (ids[at + step] ?? null);
  };
}

/** Another requisition's whole detail, read once on asking: "Copy Document" copies its lines. */
export function readRequisition(requisitionId: string) {
  return api<RequisitionDetail>(`${BASE}/requisitions/${encodeURIComponent(requisitionId)}`);
}

/**
 * Opens one file in a new tab. The tab is opened on the click, before the link
 * is asked for, so the browser does not take it for a pop-up; it is closed
 * again if nothing comes back. Where the console keeps files on its own disk
 * (a developer's machine) there is no link, and the bytes come from the API.
 */
export async function openRequisitionFile(requisitionId: string, fileId: string): Promise<'opened' | 'blocked'> {
  const tab = window.open('', '_blank');
  const file = `${BASE}/requisitions/${encodeURIComponent(requisitionId)}/files/${encodeURIComponent(fileId)}`;
  try {
    const link = await api<RequisitionFileLink>(`${file}/link`);
    if (!tab) return 'blocked';
    tab.opener = null;
    if (link.url) {
      tab.location.href = link.url;
    } else {
      const shown = URL.createObjectURL(await apiBlob(`${file}/content`));
      tab.location.href = shown;
      // Long enough for the tab to read it.
      window.setTimeout(() => URL.revokeObjectURL(shown), 60_000);
    }
    return 'opened';
  } catch (error) {
    tab?.close();
    throw error;
  }
}
