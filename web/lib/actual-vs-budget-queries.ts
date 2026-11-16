'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ExcelSyncRun,
  ExcelSyncView,
  RevenueBudgets,
  RevenueColumn,
  RevenueDay,
  RevenueHistoryImport,
  RevenueHistoryList,
  RevenueHistorySheetView,
  RevenueLog,
  RevenueLogTechnicians,
  RevenueMonthReport,
  RevenueProductColumns,
  SaveRevenueBudgetsInput,
  SaveRevenueDayInput,
  SaveRevenueLogEntryInput,
  SaveRevenueMonthInput,
  SaveExcelSyncInput,
  SaveRevenueWeekInput,
} from '@texasrenters/shared';

import { api } from './api';

/**
 * Actual vs Budget (2026-11-17): the office's revenue monitoring. Read when the
 * page opens or its technician or days change, kept a minute, never polled:
 * the log is looked at and typed into, not watched. Nothing it reads is billed.
 */

const BASE = '/api/v1/admin/actual-vs-budget';
const KEPT = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

export const actualVsBudgetKeys = {
  all: ['actual-vs-budget'] as const,
  technicians: ['actual-vs-budget', 'technicians'] as const,
  log: (technicianId: string, from: string, to: string) => ['actual-vs-budget', 'log', technicianId, from, to] as const,
  products: ['actual-vs-budget', 'products'] as const,
};

export function useRevenueTechnicians() {
  return useQuery({
    queryKey: actualVsBudgetKeys.technicians,
    queryFn: ({ signal }) => api<RevenueLogTechnicians>(`${BASE}/technicians`, { signal }),
    ...KEPT,
  });
}

export function useRevenueLog(technicianId: string, from: string, to: string) {
  return useQuery({
    queryKey: actualVsBudgetKeys.log(technicianId, from, to),
    queryFn: ({ signal }) =>
      api<RevenueLog>(`${BASE}/log?${new URLSearchParams({ technicianId, from, to }).toString()}`, { signal }),
    enabled: Boolean(technicianId && from && to),
    ...KEPT,
  });
}

export function useRevenueProducts(enabled: boolean) {
  return useQuery({
    queryKey: actualVsBudgetKeys.products,
    queryFn: ({ signal }) => api<RevenueProductColumns>(`${BASE}/products`, { signal }),
    enabled,
    ...KEPT,
  });
}

/** Where a row is saved: on its visit, on the office's own entry, or as a new row. */
export type RowTarget = { inspectionId: string } | { entryId: string } | { add: true };

export function useRevenueLogEdits() {
  const client = useQueryClient();
  const reread = () => client.invalidateQueries({ queryKey: [...actualVsBudgetKeys.all, 'log'] });
  return {
    save: useMutation({
      mutationFn: ({ target, input }: { target: RowTarget; input: SaveRevenueLogEntryInput }) => {
        const body = JSON.stringify(input);
        if ('inspectionId' in target)
          return api<{ entryId: string }>(`${BASE}/log/visits/${encodeURIComponent(target.inspectionId)}`, { method: 'PUT', body });
        if ('entryId' in target)
          return api<{ entryId: string }>(`${BASE}/log/entries/${encodeURIComponent(target.entryId)}`, { method: 'PATCH', body });
        return api<{ entryId: string }>(`${BASE}/log/entries`, { method: 'POST', body });
      },
      onSuccess: reread,
    }),
    remove: useMutation({
      mutationFn: (entryId: string) => api<{ removed: boolean }>(`${BASE}/log/entries/${encodeURIComponent(entryId)}`, { method: 'DELETE' }),
      onSuccess: reread,
    }),
    saveProductColumn: useMutation({
      mutationFn: ({ productId, column }: { productId: string; column: RevenueColumn }) =>
        api<RevenueProductColumns>(`${BASE}/products/${encodeURIComponent(productId)}`, { method: 'PUT', body: JSON.stringify({ column }) }),
      onSuccess: (products) => {
        client.setQueryData(actualVsBudgetKeys.products, products);
        void reread();
      },
    }),
  };
}

// ── PR 2: the daily sheets ──────────────────────────────────────────────────

const dayKey = (date: string) => [...actualVsBudgetKeys.all, 'day', date] as const;
const budgetsKey = [...actualVsBudgetKeys.all, 'budgets'] as const;

/** One day across the technicians with a budget: what the projection, the daily report and the tracker read. */
export function useRevenueDay(date: string) {
  return useQuery({
    queryKey: dayKey(date),
    queryFn: ({ signal }) => api<RevenueDay>(`${BASE}/day?${new URLSearchParams({ date }).toString()}`, { signal }),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(date),
    ...KEPT,
  });
}

// ── PR 4: past technicians' logs ────────────────────────────────────────────

const historyKey = [...actualVsBudgetKeys.all, 'history'] as const;

export function useRevenueHistoryList() {
  return useQuery({
    queryKey: historyKey,
    queryFn: ({ signal }) => api<RevenueHistoryList>(`${BASE}/history`, { signal }),
    ...KEPT,
  });
}

/** A past technician's log, as the workbook kept it. Kept as long as the page is open: it never changes. */
export function useRevenueHistorySheet(id: string) {
  return useQuery({
    queryKey: [...historyKey, id] as const,
    queryFn: ({ signal }) => api<RevenueHistorySheetView>(`${BASE}/history/${encodeURIComponent(id)}`, { signal }),
    enabled: Boolean(id),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useRevenueHistoryImport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api<RevenueHistoryImport>(`${BASE}/history`, { method: 'POST', body: form });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: historyKey }),
  });
}

/** A month's weekly reports and its monthly report. */
export function useRevenueMonth(month: string) {
  return useQuery({
    queryKey: [...actualVsBudgetKeys.all, 'month', month] as const,
    queryFn: ({ signal }) => api<RevenueMonthReport>(`${BASE}/month?${new URLSearchParams({ month }).toString()}`, { signal }),
    enabled: /^\d{4}-\d{2}$/.test(month),
    ...KEPT,
  });
}

export function useRevenuePeriodEdits() {
  const client = useQueryClient();
  const reread = () => client.invalidateQueries({ queryKey: [...actualVsBudgetKeys.all, 'month'] });
  return {
    saveWeek: useMutation({
      mutationFn: ({ technicianId, weekStart, input }: { technicianId: string; weekStart: string; input: SaveRevenueWeekInput }) =>
        api<{ saved: boolean }>(`${BASE}/week/${encodeURIComponent(technicianId)}/${encodeURIComponent(weekStart)}`, {
          method: 'PUT',
          body: JSON.stringify(input),
        }),
      onSuccess: reread,
    }),
    saveMonth: useMutation({
      mutationFn: ({ technicianId, month, input }: { technicianId: string; month: string; input: SaveRevenueMonthInput }) =>
        api<{ saved: boolean }>(`${BASE}/month/${encodeURIComponent(technicianId)}/${encodeURIComponent(month)}`, {
          method: 'PUT',
          body: JSON.stringify(input),
        }),
      onSuccess: reread,
    }),
  };
}

export function useRevenueBudgets(enabled: boolean) {
  return useQuery({
    queryKey: budgetsKey,
    queryFn: ({ signal }) => api<RevenueBudgets>(`${BASE}/budgets`, { signal }),
    enabled,
    ...KEPT,
  });
}

export function useRevenueDayEdits() {
  const client = useQueryClient();
  const reread = () => client.invalidateQueries({ queryKey: [...actualVsBudgetKeys.all, 'day'] });
  return {
    saveDay: useMutation({
      mutationFn: ({ technicianId, date, input }: { technicianId: string; date: string; input: SaveRevenueDayInput }) =>
        api<{ saved: boolean }>(`${BASE}/day/${encodeURIComponent(technicianId)}/${encodeURIComponent(date)}`, {
          method: 'PUT',
          body: JSON.stringify(input),
        }),
      onSuccess: reread,
    }),
    saveBudgets: useMutation({
      mutationFn: (input: SaveRevenueBudgetsInput) => api<RevenueBudgets>(`${BASE}/budgets`, { method: 'PUT', body: JSON.stringify(input) }),
      onSuccess: (budgets) => {
        client.setQueryData(budgetsKey, budgets);
        void reread();
      },
    }),
  };
}

// ── The office's own workbook in Excel (2026-11-17) ─────────────────────────

const excelKey = [...actualVsBudgetKeys.all, 'excel'] as const;

/** Read when the dialog opens; the dialog is open only while someone looks at it. */
export function useExcelSync(enabled: boolean) {
  return useQuery({
    queryKey: excelKey,
    queryFn: ({ signal }) => api<ExcelSyncView>(`${BASE}/excel`, { signal }),
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

export function useExcelSyncEdits() {
  const client = useQueryClient();
  const keep = (view: ExcelSyncView) => client.setQueryData(excelKey, view);
  const reread = () => client.invalidateQueries({ queryKey: excelKey });
  return {
    connect: useMutation({
      mutationFn: () => api<{ authorizationUrl: string }>(`${BASE}/excel/connect`, { method: 'POST' }),
    }),
    save: useMutation({
      mutationFn: (input: SaveExcelSyncInput) => api<ExcelSyncView>(`${BASE}/excel`, { method: 'PUT', body: JSON.stringify(input) }),
      onSuccess: keep,
    }),
    sync: useMutation({
      mutationFn: () => api<ExcelSyncRun>(`${BASE}/excel/sync`, { method: 'POST' }),
      onSettled: reread,
    }),
    disconnect: useMutation({
      mutationFn: () => api<ExcelSyncView>(`${BASE}/excel/connection`, { method: 'DELETE' }),
      onSuccess: keep,
    }),
  };
}
