import { fireEvent, render, screen, within } from '@testing-library/react';
import type {
  AgedReceivablesReport,
  ClientBalancesReport,
  ProjectedIncomeReport,
  ReportInvoiceRow,
  TaxReport,
  TransactionsReport,
} from '@texasrenters/shared';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { chosenRange } from '@/components/invoices/report-range';
import { businessToday, shiftDay } from '@/lib/clock';
import { csvCell, csvText } from '@/lib/csv';

import InvoiceReportsPage from './page';

/**
 * The invoice reports (2026-11-09, phase 2 of the invoice gap review), as
 * Jobber's financial reports. Reads of the console's own copy; each downloads
 * as CSV from the rows on the page. Everything invented.
 */

const reports = vi.hoisted(() => ({
  useProjectedIncome: vi.fn(),
  useAgedReceivables: vi.fn(),
  useTransactionsReport: vi.fn(),
  useInvoicesReport: vi.fn(),
  useTaxReport: vi.fn(),
  useClientBalances: vi.fn(),
}));
vi.mock('@/lib/invoice-report-queries', () => reports);
const csv = vi.hoisted(() => ({ downloadCsv: vi.fn() }));
vi.mock('@/lib/csv', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), downloadCsv: csv.downloadCsv }));
// The page's address as plain state, so a tab or a range can be changed in the test.
vi.mock('@/lib/url-state', () => ({
  useUrlState: <T extends object>(defaults: T) => {
    const [state, setState] = useState(defaults);
    return [state, (patch: Partial<T>) => setState((current) => ({ ...current, ...patch })), vi.fn()];
  },
}));

const ready = (data: unknown) => ({ isLoading: false, isError: false, error: null, data, refetch: vi.fn() });
const idle = { isLoading: false, isError: false, error: null, data: undefined, refetch: vi.fn() };
const bucket = (count: number, amountCents: number) => ({ count, amountCents });

const ROW: ReportInvoiceRow = {
  id: 'inv-1',
  number: '8439',
  clientName: '100 Example Way',
  subject: 'For Services Rendered',
  status: 'PAST_DUE',
  createdOn: '2026-10-21',
  issuedOn: '2026-10-21',
  dueOn: '2026-11-10',
  totalCents: 3999,
  balanceCents: 3999,
  jobNumber: '20600',
  email: 'owner@example.com',
  phone: '555-0100',
  emails: ['owner@example.com', 'manager@example.com'],
};

const PROJECTED: ProjectedIncomeReport = {
  overview: {
    late: bucket(279, 1381118),
    dueToday: bucket(0, 0),
    dueWithin7: bucket(47, 277138),
    dueWithin30: bucket(138, 748594),
    dueLater: bucket(0, 0),
    outstanding: bucket(464, 2406850),
  },
  rows: [ROW, { ...ROW, id: 'inv-2', number: '8440', clientName: '=SUM(A1) Example Rd' }],
  truncated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const hook of Object.values(reports)) hook.mockReturnValue(idle);
  reports.useProjectedIncome.mockReturnValue(ready(PROJECTED));
});

describe('the invoice reports', () => {
  it("opens on projected income: Jobber's cards, then what is owed, each opening its invoice", () => {
    render(<InvoiceReportsPage />);
    const cards = screen.getByRole('region', { name: 'Projected income at a glance' });
    expect(cards).toHaveTextContent('Late$13,811.18279 invoices');
    expect(cards).toHaveTextContent('Outstanding$24,068.50464 invoices');
    const table = screen.getByRole('region', { name: 'Invoices awaiting payment' });
    expect(within(table).getByRole('link', { name: '100 Example Way' })).toHaveAttribute('href', '/invoices/inv-1');
  });

  it('downloads the rows as CSV, money in dollars, a formula shown and never run', () => {
    render(<InvoiceReportsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    const [name, text] = csv.downloadCsv.mock.calls[0]!;
    expect(name).toBe('Projected income.csv');
    const lines = (text as string).split('\r\n');
    expect(lines[0]).toBe('Client,Invoice #,Total,Balance,Due,Issued,Email');
    expect(lines[1]).toBe('100 Example Way,8439,39.99,39.99,2026-11-10,2026-10-21,owner@example.com');
    expect(lines[2]).toMatch(/^'=SUM\(A1\) Example Rd,/);
  });

  it('shows the late invoices by how late, on its tab', () => {
    const aged: AgedReceivablesReport = {
      overview: { under30: bucket(173, 883703), from30to60: bucket(106, 497415), from60to90: bucket(0, 0), over90: bucket(0, 0), late: bucket(279, 1381118) },
      rows: [{ ...ROW, daysLate: 45 }],
      truncated: false,
    };
    reports.useAgedReceivables.mockReturnValue(ready(aged));
    render(<InvoiceReportsPage />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Aged receivables' }));
    expect(screen.getByRole('region', { name: 'Aged receivables at a glance' })).toHaveTextContent('Late by 30 to 60 days$4,974.15106 invoices');
    expect(screen.getByRole('region', { name: 'Late invoices' })).toHaveTextContent('45 days');
  });

  it('reads transactions over the last 30 days to start with, a refund as money out', () => {
    const report: TransactionsReport = {
      range: { from: '2026-10-22', to: '2026-11-20' },
      overview: { paid: bucket(1, 3999), refunded: bucket(1, 1000), invoiced: bucket(1, 3999), balance: bucket(1, 1000) },
      rows: [
        { kind: 'REFUND', on: '2026-11-12', invoiceId: 'inv-1', invoiceNumber: '8439', paymentId: 'pay-2', clientName: '100 Example Way', totalCents: -1000, method: 'CHECK', reference: '1042', jobNumber: null },
        { kind: 'INVOICE', on: '2026-11-02', invoiceId: 'inv-1', invoiceNumber: '8439', paymentId: null, clientName: '100 Example Way', totalCents: 3999, method: null, reference: null, jobNumber: '20600' },
      ],
      truncated: false,
    };
    reports.useTransactionsReport.mockReturnValue(ready(report));
    render(<InvoiceReportsPage />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Transactions' }));

    const today = businessToday();
    expect(reports.useTransactionsReport).toHaveBeenLastCalledWith({ from: shiftDay(today, -29), to: today });
    const table = screen.getByRole('region', { name: 'Transactions' });
    expect(within(table).getByRole('link', { name: 'Refund' })).toHaveAttribute('href', '/payments/pay-2');
    expect(table).toHaveTextContent('-$10.00');
  });

  it('is only bad debt on its tab, read by the day issued', () => {
    reports.useInvoicesReport.mockReturnValue(
      ready({
        range: { from: '2026-10-22', to: '2026-11-20' },
        overview: { draft: bucket(0, 0), awaiting: bucket(0, 0), paid: bucket(0, 0), badDebt: bucket(1, 3999), total: bucket(1, 3999) },
        rows: [{ ...ROW, status: 'BAD_DEBT' }],
        truncated: false,
      }),
    );
    render(<InvoiceReportsPage />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Bad debt' }));
    expect(reports.useInvoicesReport).toHaveBeenLastCalledWith(expect.objectContaining({ dateField: 'issued', status: 'BAD_DEBT' }));
    expect(screen.getByRole('region', { name: 'Bad debt at a glance' })).toHaveTextContent('Bad debt$39.991 invoice');
  });

  it('adds up tax by rate, with the tax still to collect', () => {
    const report: TaxReport = {
      range: { from: '2026-10-22', to: '2026-11-20' },
      basis: 'ACCRUAL',
      rows: [{ rateName: 'No tax', ratePercent: null, invoices: 185, taxableCents: 1025732, taxCents: 0, totalCents: 1025732 }],
      totals: { invoices: 185, taxableCents: 1025732, taxCents: 0, totalCents: 1025732 },
      awaitingCollectionCents: 0,
    };
    reports.useTaxReport.mockReturnValue(ready(report));
    render(<InvoiceReportsPage />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Taxation' }));
    expect(reports.useTaxReport).toHaveBeenLastCalledWith(expect.objectContaining({ basis: 'ACCRUAL' }));
    const rows = within(screen.getByRole('region', { name: 'Tax by rate' })).getAllByRole('row');
    expect(rows.at(-1)).toHaveTextContent('Total185$10,257.32$0.00$10,257.32');
  });

  it("lists each client's balance, a credit as a credit", () => {
    const report: ClientBalancesReport = {
      overview: { outstanding: bucket(374, 2413350), credit: bucket(7, -41950), total: bucket(1483, 2371400) },
      rows: [
        { key: 'c1', clientName: '100 Example Way', propertyId: 'b1', email: null, phone: null, invoicedCents: 88344, paidCents: 69345, balanceCents: 18999, lateBalanceCents: 11499, paymentDays: 163, lastEmailedAt: null },
      ],
      truncated: false,
    };
    reports.useClientBalances.mockReturnValue(ready(report));
    render(<InvoiceReportsPage />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Client balances' }));
    expect(screen.getByRole('region', { name: 'Client balances at a glance' })).toHaveTextContent('In credit-$419.507 clients');
    expect(screen.getByRole('link', { name: '100 Example Way' })).toHaveAttribute('href', '/properties/b1');
  });
});

describe('a span of days', () => {
  it('is a preset, a finished custom range, or every date', () => {
    expect(chosenRange({ range: 'this_month', from: '', to: '' }, '2026-11-20')).toEqual({ from: '2026-11-01', to: '2026-11-20' });
    expect(chosenRange({ range: 'custom', from: '2026-11-01', to: '2026-11-07' }, '2026-11-20')).toEqual({ from: '2026-11-01', to: '2026-11-07' });
    expect(chosenRange({ range: 'custom', from: '2026-11-01', to: '' }, '2026-11-20')).toBeNull();
    expect(chosenRange({ range: '', from: '', to: '' }, '2026-11-20')).toBeNull();
  });
});

describe('a CSV', () => {
  it('quotes what needs quoting and keeps numbers as numbers', () => {
    expect(csvCell('a, "b"')).toBe('"a, ""b"""');
    expect(csvCell(-10)).toBe('-10');
    expect(csvCell('-10 Example St')).toBe("'-10 Example St");
    expect(csvCell(null)).toBe('');
    expect(csvText(['A', 'B'], [[1, 'x']])).toBe('A,B\r\n1,x');
  });
});
