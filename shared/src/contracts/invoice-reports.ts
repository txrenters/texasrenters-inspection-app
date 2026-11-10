/**
 * Where the money stands (2026-11-09, phase 2 of the invoice gap review), as
 * Jobber's financial reports show it: projected income, aged receivables, the
 * transaction list, the invoices report and its bad-debt view, taxation, and
 * the client balance summary. Each is a read of the console's own copy and
 * downloads as CSV; nothing billed is called.
 */

import type { InvoiceBucket, InvoiceStatus, PaymentMethod } from './invoices.js';

/** The longest span one report reads at a time, and the most rows it lists. */
export const MAX_REPORT_DAYS = 366;
export const MAX_REPORT_ROWS = 5000;

export interface ReportRange {
  /** Texas days, `YYYY-MM-DD`, both included. */
  from: string;
  to: string;
}

/**
 * One company's books (2026-11-10): the invoices that go to one Xero
 * organisation -- its tenant id -- or `none` for those of no company, and the
 * payments against them. Left out, every company's.
 */
export interface ReportCompany {
  company?: string;
}

/** Jobber's date options, the custom range aside. */
export const REPORT_RANGE_PRESETS = ['this_week', 'this_month', 'last_30_days', 'last_90_days', 'last_12_months', 'this_year'] as const;
export type ReportRangePreset = (typeof REPORT_RANGE_PRESETS)[number];

export const REPORT_RANGE_LABEL: Record<ReportRangePreset, string> = {
  this_week: 'This week',
  this_month: 'This month',
  last_30_days: 'Last 30 days',
  last_90_days: 'Last 90 days',
  last_12_months: 'Last 12 months',
  this_year: 'This calendar year',
};

const shift = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The days a preset covers, ending today (Texas). A week starts on Sunday, as Jobber's does. */
export function reportRange(preset: ReportRangePreset, today: string): ReportRange {
  switch (preset) {
    case 'this_week':
      return { from: shift(today, -new Date(`${today}T00:00:00.000Z`).getUTCDay()), to: today };
    case 'this_month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'last_30_days':
      return { from: shift(today, -29), to: today };
    case 'last_90_days':
      return { from: shift(today, -89), to: today };
    case 'last_12_months':
      return { from: shift(today, -364), to: today };
    case 'this_year':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

/** What is wrong with a range, in words; null when it can be read. */
export function reportRangeProblem(range: ReportRange): string | null {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(range.from) || !day.test(range.to)) return 'Choose a first and a last day.';
  const span = Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000);
  if (span < 0) return 'The first day comes after the last.';
  if (span >= MAX_REPORT_DAYS) return `Choose at most ${MAX_REPORT_DAYS} days at a time.`;
  return null;
}

/** An invoice as the reports list it. */
export interface ReportInvoiceRow {
  id: string;
  number: string | null;
  clientName: string;
  subject: string;
  /** As it stands today: an unpaid one past its due date is past due. */
  status: InvoiceStatus;
  createdOn: string;
  issuedOn: string | null;
  dueOn: string | null;
  totalCents: number;
  balanceCents: number;
  jobNumber: string | null;
  /** The client's first address and phone, as Jobber's reports show them. */
  email: string | null;
  phone: string | null;
  /** Every address the client has, for the invoices report. */
  emails: string[];
}

/** Jobber's Projected Income: what is owed, by when it falls due. */
export interface ProjectedIncomeReport {
  overview: {
    late: InvoiceBucket;
    dueToday: InvoiceBucket;
    dueWithin7: InvoiceBucket;
    dueWithin30: InvoiceBucket;
    dueLater: InvoiceBucket;
    outstanding: InvoiceBucket;
  };
  rows: ReportInvoiceRow[];
  truncated: boolean;
}

/** Jobber's Aged Receivables: the late invoices, by how late. */
export interface AgedReceivablesReport {
  overview: { under30: InvoiceBucket; from30to60: InvoiceBucket; from60to90: InvoiceBucket; over90: InvoiceBucket; late: InvoiceBucket };
  rows: (ReportInvoiceRow & { daysLate: number })[];
  truncated: boolean;
}

/** Which bucket a late invoice falls in: Jobber's "less than 30", "30 to 60", "60 to 90", "greater than 90". */
export function agedBucket(daysLate: number): keyof AgedReceivablesReport['overview'] {
  if (daysLate < 30) return 'under30';
  if (daysLate < 60) return 'from30to60';
  if (daysLate < 90) return 'from60to90';
  return 'over90';
}

/** Which bucket an owed invoice falls in by its due date. */
export function projectedBucket(dueOn: string | null, today: string): keyof ProjectedIncomeReport['overview'] {
  if (!dueOn) return 'dueLater';
  const days = Math.round((Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days < 0) return 'late';
  if (days === 0) return 'dueToday';
  if (days < 7) return 'dueWithin7';
  if (days <= 30) return 'dueWithin30';
  return 'dueLater';
}

export type TransactionKind = 'INVOICE' | 'PAYMENT' | 'REFUND';

export const TRANSACTION_KIND_LABEL: Record<TransactionKind, string> = {
  INVOICE: 'Invoice',
  PAYMENT: 'Payment',
  REFUND: 'Refund',
};

/** Jobber's Transaction List: what was invoiced and what came in, day by day. */
export interface TransactionRow {
  kind: TransactionKind;
  /** The invoice's issue day, or the day the money came in. */
  on: string;
  invoiceId: string;
  invoiceNumber: string | null;
  paymentId: string | null;
  clientName: string;
  /** Positive for an invoice and a payment; a refund is money out, shown negative. */
  totalCents: number;
  method: PaymentMethod | null;
  /** A check number, a Propertyware receipt. */
  reference: string | null;
  jobNumber: string | null;
}

export interface TransactionsReport {
  range: ReportRange;
  overview: { paid: InvoiceBucket; refunded: InvoiceBucket; invoiced: InvoiceBucket; balance: InvoiceBucket };
  rows: TransactionRow[];
  truncated: boolean;
}

/** Which day the invoices report reads by: Jobber's "Created within" and "Issued within". */
export type InvoiceReportDate = 'created' | 'issued';

export interface InvoicesReportQuery extends ReportRange {
  dateField: InvoiceReportDate;
  /** Bad debt is this report with only bad debt in it, as Jobber's is. */
  status?: InvoiceStatus;
}

/** Jobber's Invoices report: every invoice in the days chosen, with its client's addresses. */
export interface InvoicesReport {
  range: ReportRange;
  overview: { draft: InvoiceBucket; awaiting: InvoiceBucket; paid: InvoiceBucket; badDebt: InvoiceBucket; total: InvoiceBucket };
  rows: ReportInvoiceRow[];
  truncated: boolean;
}

/**
 * Jobber's Taxation report, two ways: accrual, what was invoiced (every invoice
 * sent in the days chosen); cash, what was collected (each payment's share of
 * its invoice's tax).
 */
export type TaxBasis = 'ACCRUAL' | 'CASH';

export interface TaxReportRow {
  /** "No tax" when the invoice carries none. */
  rateName: string;
  ratePercent: number | null;
  invoices: number;
  /** Before tax, the tax, and with it. */
  taxableCents: number;
  taxCents: number;
  totalCents: number;
}

export interface TaxReport {
  range: ReportRange;
  basis: TaxBasis;
  rows: TaxReportRow[];
  totals: { invoices: number; taxableCents: number; taxCents: number; totalCents: number };
  /** Tax on invoices sent and still owed: Jobber's "total awaiting collection". */
  awaitingCollectionCents: number;
}

/** A payment's share of its invoice's tax, in cents. */
export function taxShareCents(paymentCents: number, invoice: { taxCents: number; totalCents: number }): number {
  if (!invoice.totalCents || !invoice.taxCents) return 0;
  return Math.round((paymentCents * invoice.taxCents) / invoice.totalCents);
}

/** Jobber's Client Balance Summary: what each client was invoiced, paid and still owes. */
export interface ClientBalanceRow {
  /** Jobber's client, which for the office is the property. */
  key: string;
  clientName: string;
  propertyId: string | null;
  email: string | null;
  phone: string | null;
  invoicedCents: number;
  paidCents: number;
  /** What is owed now; below zero when the client paid more than was invoiced. */
  balanceCents: number;
  /** What is owed on invoices past their due date. */
  lateBalanceCents: number;
  /** On average, days from issuing an invoice to its being paid in full; null when none was. */
  paymentDays: number | null;
  /** The last time the console emailed this client about an invoice. */
  lastEmailedAt: string | null;
}

export interface ClientBalancesReport {
  overview: { outstanding: InvoiceBucket; credit: InvoiceBucket; total: InvoiceBucket };
  rows: ClientBalanceRow[];
  truncated: boolean;
}

/** Jobber's two cards on its payments page. */
export interface PaymentInsights {
  /** Invoices paid in full in the past 30 days: on average, days from issued to paid. */
  paymentDays: { days: number | null; invoices: number };
  /** Invoices paid in full in the last 60 days: how many by their due date. */
  paidOnTime: { onTime: number; invoices: number };
}

/** "84%", or a dash when nothing was paid. */
export const shareWords = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');
