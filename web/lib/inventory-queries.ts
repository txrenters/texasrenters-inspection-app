'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  StockImportCheck,
  StockImportDone,
  StockImportInput,
  CancelStockCountInput,
  InventoryMonitoring,
  OpeningBalanceInput,
  PostStockCountInput,
  PostStockSlipInput,
  ReverseMovementInput,
  ReverseStockSlipInput,
  SaveStockCategoryInput,
  SaveStockCountInput,
  SaveStockItemInput,
  SaveStockPlaceInput,
  SaveVendorInput,
  StartStockCountInput,
  StockCountChoices,
  StockCountDetail,
  StockCountList,
  StockItemDetail,
  StockList,
  StockPlaces,
  StockSlipChoices,
  StockSlipList,
  UsagePeriod,
  Vendors,
} from '@texasrenters/shared';

import { api } from './api';

/**
 * Inventory (2026-11-19, phase 1): read when a page or a tab opens, kept a
 * minute, and read again after this page's own saves. Never polled: stock is
 * looked at and entered, not watched. Nothing it reads is billed.
 */

const BASE = '/api/v1/admin/inventory';
const KEPT = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

export const inventoryKeys = {
  all: ['inventory'] as const,
  stock: ['inventory', 'stock'] as const,
  item: (itemId: string) => ['inventory', 'item', itemId] as const,
  places: ['inventory', 'places'] as const,
  vendors: ['inventory', 'vendors'] as const,
  slips: ['inventory', 'slips'] as const,
  slipsOf: (technicianId: string) => ['inventory', 'slips', technicianId] as const,
  monitoring: (period: UsagePeriod) => ['inventory', 'monitoring', period] as const,
  counts: ['inventory', 'counts'] as const,
  countChoices: ['inventory', 'count-choices'] as const,
  count: (countId: string) => ['inventory', 'count', countId] as const,
  slipChoices: (technicianId: string | null) => ['inventory', 'slip-choices', technicianId] as const,
};

export function useStock() {
  return useQuery({ queryKey: inventoryKeys.stock, queryFn: ({ signal }) => api<StockList>(`${BASE}/items`, { signal }), ...KEPT });
}

export function useStockItem(itemId: string) {
  return useQuery({
    queryKey: inventoryKeys.item(itemId),
    queryFn: ({ signal }) => api<StockItemDetail>(`${BASE}/items/${encodeURIComponent(itemId)}`, { signal }),
    enabled: Boolean(itemId),
    ...KEPT,
  });
}

/** Read only once its tab or its dialog is open. */
export function useStockPlaces(enabled: boolean) {
  return useQuery({ queryKey: inventoryKeys.places, queryFn: ({ signal }) => api<StockPlaces>(`${BASE}/places`, { signal }), enabled, ...KEPT });
}

export function useVendors(enabled: boolean) {
  return useQuery({ queryKey: inventoryKeys.vendors, queryFn: ({ signal }) => api<Vendors>(`${BASE}/vendors`, { signal }), enabled, ...KEPT });
}

/** The latest withdrawals, returns and moves: read when the Withdrawals tab opens. */
export function useStockSlips(enabled: boolean, technicianId?: string) {
  return useQuery({
    queryKey: technicianId ? inventoryKeys.slipsOf(technicianId) : inventoryKeys.slips,
    queryFn: ({ signal }) => api<StockSlipList>(`${BASE}/slips${technicianId ? `?technicianId=${encodeURIComponent(technicianId)}` : ''}`, { signal }),
    enabled,
    ...KEPT,
  });
}

/** Reorder and usage: read when its tab opens and when the period changes; the last answer stays on screen meanwhile. */
export function useInventoryMonitoring(enabled: boolean, period: UsagePeriod) {
  return useQuery({
    queryKey: inventoryKeys.monitoring(period),
    queryFn: ({ signal }) => api<InventoryMonitoring>(`${BASE}/monitoring?period=${period}`, { signal }),
    enabled,
    placeholderData: (previous) => previous,
    ...KEPT,
  });
}

/**
 * What the slip form chooses from and what is where, with the chosen
 * technician's visits for today. Read when the form opens and when the
 * technician changes; the last answer stays on screen meanwhile.
 */
export function useStockSlipChoices(enabled: boolean, technicianId: string | null) {
  return useQuery({
    queryKey: inventoryKeys.slipChoices(technicianId),
    queryFn: ({ signal }) => api<StockSlipChoices>(`${BASE}/slips/choices${technicianId ? `?technicianId=${encodeURIComponent(technicianId)}` : ''}`, { signal }),
    enabled,
    placeholderData: (previous) => previous,
    ...KEPT,
  });
}

/** Posting or reversing a slip answers with the list; everything else that shows stock is read again when next looked at. */
export function useStockSlipEdits() {
  const client = useQueryClient();
  const settle = (list: StockSlipList) => {
    client.setQueryData(inventoryKeys.slips, list);
    const saved = JSON.stringify(inventoryKeys.slips);
    void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === inventoryKeys.all[0] && JSON.stringify(query.queryKey) !== saved });
  };
  return {
    post: useMutation({ mutationFn: (input: PostStockSlipInput) => api<StockSlipList>(`${BASE}/slips`, { method: 'POST', body: JSON.stringify(input) }), onSuccess: settle }),
    reverse: useMutation({
      mutationFn: ({ slipId, input }: { slipId: string; input: ReverseStockSlipInput }) =>
        api<StockSlipList>(`${BASE}/slips/${encodeURIComponent(slipId)}/reverse`, { method: 'POST', body: JSON.stringify(input) }),
      onSuccess: settle,
    }),
  };
}

/** The counts and when each kind is next due: read when the Counts tab opens. */
export function useStockCounts(enabled: boolean) {
  return useQuery({ queryKey: inventoryKeys.counts, queryFn: ({ signal }) => api<StockCountList>(`${BASE}/counts`, { signal }), enabled, ...KEPT });
}

/** What "Start a count" chooses from: read only once that form is open. */
export function useStockCountChoices(enabled: boolean) {
  return useQuery({ queryKey: inventoryKeys.countChoices, queryFn: ({ signal }) => api<StockCountChoices>(`${BASE}/counts/choices`, { signal }), enabled, ...KEPT });
}

/** One count, as this person may see it. Read when its page opens; never polled. */
export function useStockCount(countId: string) {
  return useQuery({
    queryKey: inventoryKeys.count(countId),
    queryFn: ({ signal }) => api<StockCountDetail>(`${BASE}/counts/${encodeURIComponent(countId)}`, { signal }),
    enabled: Boolean(countId),
    ...KEPT,
  });
}

/** Every step answers with the count as it now is, which is kept; the rest of the inventory is read again when next looked at. */
export function useStockCountEdits() {
  const client = useQueryClient();
  const settle = <T extends StockCountDetail>(detail: T) => {
    const key = inventoryKeys.count(detail.id);
    client.setQueryData(key, detail);
    const saved = JSON.stringify(key);
    void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === inventoryKeys.all[0] && JSON.stringify(query.queryKey) !== saved });
  };
  const at = (countId: string, step: string) => `${BASE}/counts/${encodeURIComponent(countId)}/${step}`;
  const send = <T,>(path: string, method: 'POST' | 'PUT', input: object) => api<T>(path, { method, body: JSON.stringify(input) });
  type Handed = StockCountDetail & { recounts: number };
  return {
    start: useMutation({ mutationFn: (input: StartStockCountInput) => send<StockCountDetail>(`${BASE}/counts`, 'POST', input), onSuccess: settle }),
    save: useMutation({ mutationFn: ({ countId, input }: { countId: string; input: SaveStockCountInput }) => send<Handed>(at(countId, 'counted'), 'PUT', input), onSuccess: settle }),
    handIn: useMutation({ mutationFn: ({ countId, input }: { countId: string; input: SaveStockCountInput }) => send<Handed>(at(countId, 'hand-in'), 'POST', input), onSuccess: settle }),
    recount: useMutation({ mutationFn: ({ countId, lineId }: { countId: string; lineId: string }) => send<StockCountDetail>(at(countId, `lines/${encodeURIComponent(lineId)}/recount`), 'POST', {}), onSuccess: settle }),
    post: useMutation({ mutationFn: ({ countId, input }: { countId: string; input: PostStockCountInput }) => send<StockCountDetail>(at(countId, 'post'), 'POST', input), onSuccess: settle }),
    cancel: useMutation({ mutationFn: ({ countId, input }: { countId: string; input: CancelStockCountInput }) => send<StockCountDetail>(at(countId, 'cancel'), 'POST', input), onSuccess: settle }),
  };
}

export function useInventoryEdits() {
  const client = useQueryClient();
  /**
   * A save answers with what it changed, so that is kept as it came and not
   * asked for again; everything else that shows stock is read again when next
   * looked at.
   */
  const settle = <T,>(key: readonly unknown[]) => (data: T) => {
    client.setQueryData(key, data);
    const saved = JSON.stringify(key);
    void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === inventoryKeys.all[0] && JSON.stringify(query.queryKey) !== saved });
  };
  const itemSaved = (detail: StockItemDetail) => settle<StockItemDetail>(inventoryKeys.item(detail.item.id))(detail);
  const send = <T,>(path: string, method: 'POST' | 'PATCH', input: object) => api<T>(`${BASE}${path}`, { method, body: JSON.stringify(input) });

  return {
    createItem: useMutation({ mutationFn: (input: SaveStockItemInput) => send<StockItemDetail>('/items', 'POST', input), onSuccess: itemSaved }),
    updateItem: useMutation({
      mutationFn: ({ itemId, input }: { itemId: string; input: SaveStockItemInput }) => send<StockItemDetail>(`/items/${encodeURIComponent(itemId)}`, 'PATCH', input),
      onSuccess: itemSaved,
    }),
    enterOpeningBalance: useMutation({
      mutationFn: ({ itemId, input }: { itemId: string; input: OpeningBalanceInput }) =>
        send<StockItemDetail>(`/items/${encodeURIComponent(itemId)}/opening-balance`, 'POST', input),
      onSuccess: itemSaved,
    }),
    reverseMovement: useMutation({
      mutationFn: ({ movementId, input }: { movementId: string; input: ReverseMovementInput }) =>
        send<StockItemDetail>(`/movements/${encodeURIComponent(movementId)}/reverse`, 'POST', input),
      onSuccess: itemSaved,
    }),
    createCategory: useMutation({ mutationFn: (input: SaveStockCategoryInput) => send<StockList>('/categories', 'POST', input), onSuccess: settle<StockList>(inventoryKeys.stock) }),
    updateCategory: useMutation({
      mutationFn: ({ categoryId, input }: { categoryId: string; input: SaveStockCategoryInput }) => send<StockList>(`/categories/${encodeURIComponent(categoryId)}`, 'PATCH', input),
      onSuccess: settle<StockList>(inventoryKeys.stock),
    }),
    createPlace: useMutation({ mutationFn: (input: SaveStockPlaceInput) => send<StockPlaces>('/places', 'POST', input), onSuccess: settle<StockPlaces>(inventoryKeys.places) }),
    updatePlace: useMutation({
      mutationFn: ({ placeId, input }: { placeId: string; input: SaveStockPlaceInput }) => send<StockPlaces>(`/places/${encodeURIComponent(placeId)}`, 'PATCH', input),
      onSuccess: settle<StockPlaces>(inventoryKeys.places),
    }),
    createVendor: useMutation({ mutationFn: (input: SaveVendorInput) => send<Vendors>('/vendors', 'POST', input), onSuccess: settle<Vendors>(inventoryKeys.vendors) }),
    updateVendor: useMutation({
      mutationFn: ({ vendorId, input }: { vendorId: string; input: SaveVendorInput }) => send<Vendors>(`/vendors/${encodeURIComponent(vendorId)}`, 'PATCH', input),
      onSuccess: settle<Vendors>(inventoryKeys.vendors),
    }),
  };
}

/**
 * The stock import (2026-11-23): Check reads the file against the office and
 * writes nothing; Import writes it all, and everything that shows stock is
 * read again when next looked at.
 */
export function useStockImport() {
  const client = useQueryClient();
  const send = <T,>(path: string, input: StockImportInput) => api<T>(`${BASE}/import${path}`, { method: 'POST', body: JSON.stringify(input) });
  return {
    check: useMutation({ mutationFn: (input: StockImportInput) => send<StockImportCheck>('/check', input) }),
    run: useMutation({
      mutationFn: (input: StockImportInput) => send<StockImportDone>('', input),
      onSuccess: () => void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === inventoryKeys.all[0] }),
    }),
  };
}
