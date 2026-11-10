'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  AgedReceivablesReport,
  ClientBalancesReport,
  InvoicesReport,
  InvoicesReportQuery,
  PaymentInsights,
  ProjectedIncomeReport,
  ReportCompany,
  ReportRange,
  TaxBasis,
  TaxReport,
  TransactionsReport,
} from '@texasrenters/shared';

import { api } from './api';
import { invoiceKeys } from './invoice-queries';

/**
 * Jobber's financial reports, from the console's own copy (2026-11-09, phase
 * 2 of the invoice gap review). Each is read when its tab opens or its days
 * change, kept five minutes, and never refetched on focus: a report is a look
 * at a moment, not a live board. Under the invoices' key, so a payment or an
 * edit recorded here reads them again.
 */

const REPORTS = '/api/v1/admin/invoice-reports';
const KEPT = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;

export const reportKeys = {
  all: [...invoiceKeys.all, 'reports'] as const,
  one: (name: string, query?: object) => [...invoiceKeys.all, 'reports', name, query ?? {}] as const,
};

const params = (values: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString();

/** `?company=`, or nothing for every company's (2026-11-10). */
const companyQuery = (company: string | undefined) => (company ? `?${params({ company })}` : '');

export function useProjectedIncome(company?: string, enabled = true) {
  return useQuery({
    queryKey: reportKeys.one('projected-income', company ? { company } : undefined),
    queryFn: ({ signal }) => api<ProjectedIncomeReport>(`${REPORTS}/projected-income${companyQuery(company)}`, { signal }),
    enabled,
    ...KEPT,
  });
}

export function useAgedReceivables(company?: string, enabled = true) {
  return useQuery({
    queryKey: reportKeys.one('aged-receivables', company ? { company } : undefined),
    queryFn: ({ signal }) => api<AgedReceivablesReport>(`${REPORTS}/aged-receivables${companyQuery(company)}`, { signal }),
    enabled,
    ...KEPT,
  });
}

export function useTransactionsReport(range: (ReportRange & ReportCompany) | null) {
  return useQuery({
    queryKey: reportKeys.one('transactions', range ?? undefined),
    queryFn: ({ signal }) =>
      api<TransactionsReport>(`${REPORTS}/transactions?${params({ from: range?.from, to: range?.to, company: range?.company })}`, { signal }),
    enabled: Boolean(range),
    placeholderData: (previous) => previous,
    ...KEPT,
  });
}

export function useInvoicesReport(query: (InvoicesReportQuery & ReportCompany) | null) {
  return useQuery({
    queryKey: reportKeys.one('invoices', query ?? undefined),
    queryFn: ({ signal }) =>
      api<InvoicesReport>(
        `${REPORTS}/invoices?${params({ from: query?.from, to: query?.to, dateField: query?.dateField, status: query?.status, company: query?.company })}`,
        { signal },
      ),
    enabled: Boolean(query),
    placeholderData: (previous) => previous,
    ...KEPT,
  });
}

export function useTaxReport(query: (ReportRange & ReportCompany & { basis: TaxBasis }) | null) {
  return useQuery({
    queryKey: reportKeys.one('taxes', query ?? undefined),
    queryFn: ({ signal }) =>
      api<TaxReport>(`${REPORTS}/taxes?${params({ from: query?.from, to: query?.to, basis: query?.basis, company: query?.company })}`, { signal }),
    enabled: Boolean(query),
    placeholderData: (previous) => previous,
    ...KEPT,
  });
}

export function useClientBalances(company?: string, enabled = true) {
  return useQuery({
    queryKey: reportKeys.one('client-balances', company ? { company } : undefined),
    queryFn: ({ signal }) => api<ClientBalancesReport>(`${REPORTS}/client-balances${companyQuery(company)}`, { signal }),
    enabled,
    ...KEPT,
  });
}

/** Jobber's two cards on the payments page. */
export function usePaymentInsights() {
  return useQuery({
    queryKey: reportKeys.one('payment-insights'),
    queryFn: ({ signal }) => api<PaymentInsights>(`${REPORTS}/payment-insights`, { signal }),
    ...KEPT,
  });
}
