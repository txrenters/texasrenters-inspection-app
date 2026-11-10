'use client';

import {
  INVOICE_STATUS_LABEL,
  PAYMENT_METHOD_LABEL,
  TRANSACTION_KIND_LABEL,
  formatMoney,
  type ClientBalanceRow,
  type InvoiceReportDate,
  type ReportCompany,
  type ReportInvoiceRow,
  type ReportRange,
  type TaxBasis,
  type TaxReportRow,
  type TransactionRow,
} from '@texasrenters/shared';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { InvoiceStatusBadge, formatInvoiceDay, formatInvoiceMoment } from '@/components/invoices/invoice-parts';
import { CUSTOM, RangePicker, chosenRange, type RangeChoice } from '@/components/invoices/report-range';
import { ReportCards, ReportTable, type ReportColumn } from '@/components/invoices/report-table';
import { PageHeader } from '@/components/page-header';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TableCell, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { csvMoney } from '@/lib/csv';
import {
  useAgedReceivables,
  useClientBalances,
  useInvoicesReport,
  useProjectedIncome,
  useTaxReport,
  useTransactionsReport,
} from '@/lib/invoice-report-queries';
import { useInvoiceSettings } from '@/lib/invoice-settings-queries';
import { useUrlState } from '@/lib/url-state';

/**
 * The invoice reports (2026-11-09, phase 2 of the invoice gap review), as
 * Jobber's financial reports: projected income, aged receivables, the
 * transaction list, the invoices report and its bad-debt view, taxation, and
 * the client balance summary. Each reads the console's own copy when its tab
 * opens or its days change, and downloads as CSV.
 */

const REPORTS = [
  { key: 'projected', label: 'Projected income' },
  { key: 'aged', label: 'Aged receivables' },
  { key: 'transactions', label: 'Transactions' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'bad_debt', label: 'Bad debt' },
  { key: 'taxes', label: 'Taxation' },
  { key: 'clients', label: 'Client balances' },
] as const;
type ReportKey = (typeof REPORTS)[number]['key'];

/** Every company's books: the Company select's value for no filter. */
const ALL_COMPANIES = 'all';

export default function InvoiceReportsPage() {
  const [state, setState] = useUrlState({ report: 'projected', range: 'last_30_days', from: '', to: '', date: 'issued', basis: 'ACCRUAL', company: '' });
  const report: ReportKey = REPORTS.some((item) => item.key === state.report) ? (state.report as ReportKey) : 'projected';
  const choice: RangeChoice = { range: state.range || 'last_30_days', from: state.from, to: state.to };
  const range = chosenRange(choice);
  const ranged = report === 'transactions' || report === 'invoices' || report === 'bad_debt' || report === 'taxes';
  // One company's books (2026-11-10): asked once Xero has an organisation.
  const organisations = useInvoiceSettings().data?.organisations ?? [];
  const company = organisations.length ? state.company || undefined : undefined;
  const scoped = company ? { company } : {};

  return (
    <>
      <PageHeader
        description="Where the money stands, as Jobber's financial reports show it. Each downloads as CSV."
        title="Invoice reports"
      />
      <Tabs onValueChange={(next) => setState({ report: next })} value={report}>
        <TabsList aria-label="Reports">
          {REPORTS.map((item) => (
            <TabsTrigger key={item.key} value={item.key}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {ranged || organisations.length ? (
        <div className="mt-4 mb-4 flex flex-wrap items-center gap-3">
          {organisations.length ? (
            <Select onValueChange={(next) => setState({ company: next === ALL_COMPANIES ? '' : next })} value={company ?? ALL_COMPANIES}>
              <SelectTrigger aria-label="Company" className="w-auto">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_COMPANIES}>Every company</SelectItem>
                {organisations.map((organisation) => (
                  <SelectItem key={organisation.tenantId} value={organisation.tenantId}>
                    {organisation.connected ? organisation.name : `${organisation.name} (not connected)`}
                  </SelectItem>
                ))}
                <SelectItem value="none">No company</SelectItem>
              </SelectContent>
            </Select>
          ) : null}
          {ranged ? (
            <>
              <RangePicker
                choice={choice}
                label={report === 'taxes' ? 'Dates' : report === 'transactions' ? 'Entry date' : state.date === 'created' ? 'Created' : 'Issued'}
                onChange={(next) => setState({ range: next.range, from: next.range === CUSTOM ? next.from : '', to: next.range === CUSTOM ? next.to : '' })}
              />
              {report === 'invoices' || report === 'bad_debt' ? (
                <Select onValueChange={(next) => setState({ date: next })} value={state.date === 'created' ? 'created' : 'issued'}>
                  <SelectTrigger aria-label="Read by" className="w-auto">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="issued">By the day issued</SelectItem>
                    <SelectItem value="created">By the day created</SelectItem>
                  </SelectContent>
                </Select>
              ) : null}
              {report === 'taxes' ? (
                <Select onValueChange={(next) => setState({ basis: next })} value={state.basis === 'CASH' ? 'CASH' : 'ACCRUAL'}>
                  <SelectTrigger aria-label="Basis" className="w-auto">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ACCRUAL">Accrual: what was invoiced</SelectItem>
                    <SelectItem value="CASH">Cash: what was collected</SelectItem>
                  </SelectContent>
                </Select>
              ) : null}
            </>
          ) : null}
        </div>
      ) : (
        <div className="mt-4" />
      )}

      {report === 'projected' ? <ProjectedIncome company={company} /> : null}
      {report === 'aged' ? <AgedReceivables company={company} /> : null}
      {report === 'transactions' ? <Transactions range={range ? { ...range, ...scoped } : null} /> : null}
      {report === 'invoices' || report === 'bad_debt' ? (
        <InvoicesReport
          badDebt={report === 'bad_debt'}
          dateField={state.date === 'created' ? 'created' : 'issued'}
          range={range ? { ...range, ...scoped } : null}
        />
      ) : null}
      {report === 'taxes' ? <Taxation basis={state.basis === 'CASH' ? 'CASH' : 'ACCRUAL'} range={range ? { ...range, ...scoped } : null} /> : null}
      {report === 'clients' ? <ClientBalances company={company} /> : null}
    </>
  );
}

/** Loading, a failure, a custom range not finished, or the report. */
function Loaded<T>({
  query,
  waiting,
  children,
}: {
  query: { isLoading: boolean; isError: boolean; error: unknown; data: T | undefined; refetch: () => unknown };
  waiting?: boolean;
  children: (data: T) => ReactNode;
}) {
  if (waiting) return <p className="text-muted-foreground text-sm">Choose a first and a last day.</p>;
  if (query.isLoading) return <PageSkeleton />;
  if (query.isError || !query.data) return <ErrorState error={query.error as Error} retry={() => void query.refetch()} />;
  return <>{children(query.data)}</>;
}

const days = (range: ReportRange | null) => (range ? `${range.from} to ${range.to}` : '');
const money = (cents: number) => formatMoney(cents);

/** The invoice's client, opening the invoice. */
const clientCell = (row: { id: string; clientName: string }) => (
  <Link className="text-heading font-medium hover:underline" href={`/invoices/${row.id}`}>
    {row.clientName}
  </Link>
);

const invoiceColumns = {
  client: { header: 'Client', cell: clientCell, csv: (row) => row.clientName },
  number: { header: 'Invoice #', cell: (row) => (row.number ? `#${row.number}` : '—'), csv: (row) => row.number },
  total: { header: 'Total', numeric: true, cell: (row) => money(row.totalCents), csv: (row) => csvMoney(row.totalCents) },
  balance: { header: 'Balance', numeric: true, cell: (row) => <span className="font-semibold">{money(row.balanceCents)}</span>, csv: (row) => csvMoney(row.balanceCents) },
  due: { header: 'Due', cell: (row) => formatInvoiceDay(row.dueOn), csv: (row) => row.dueOn },
  issued: { header: 'Issued', cell: (row) => formatInvoiceDay(row.issuedOn), csv: (row) => row.issuedOn },
  email: { header: 'Email', wide: true, cell: (row) => <span className="text-muted-foreground">{row.email ?? '—'}</span>, csv: (row) => row.email },
  phone: { header: 'Phone', wide: true, cell: (row) => <span className="text-muted-foreground">{row.phone ?? '—'}</span>, csv: (row) => row.phone },
} satisfies Record<string, ReportColumn<ReportInvoiceRow>>;

function ProjectedIncome({ company }: { company?: string }) {
  const query = useProjectedIncome(company);
  return (
    <Loaded query={query}>
      {(data) => (
        <>
          <ReportCards
            cards={[
              { label: 'Late', bucket: data.overview.late, tone: 'late' },
              { label: 'Due today', bucket: data.overview.dueToday },
              { label: 'Due in less than 7 days', bucket: data.overview.dueWithin7 },
              { label: 'Due in 7 to 30 days', bucket: data.overview.dueWithin30 },
              { label: 'Due in more than 30 days', bucket: data.overview.dueLater },
              { label: 'Outstanding', bucket: data.overview.outstanding },
            ]}
            label="Projected income at a glance"
          />
          <ReportTable
            columns={[invoiceColumns.client, invoiceColumns.number, invoiceColumns.total, invoiceColumns.balance, invoiceColumns.due, invoiceColumns.issued, invoiceColumns.email]}
            empty="Nothing is owed."
            fileName="Projected income.csv"
            label="Invoices awaiting payment"
            rowKey={(row) => row.id}
            rows={data.rows}
            truncated={data.truncated}
          />
        </>
      )}
    </Loaded>
  );
}

function AgedReceivables({ company }: { company?: string }) {
  const query = useAgedReceivables(company);
  return (
    <Loaded query={query}>
      {(data) => (
        <>
          <ReportCards
            cards={[
              { label: 'Late by less than 30 days', bucket: data.overview.under30 },
              { label: 'Late by 30 to 60 days', bucket: data.overview.from30to60, tone: 'late' },
              { label: 'Late by 60 to 90 days', bucket: data.overview.from60to90, tone: 'late' },
              { label: 'Late by more than 90 days', bucket: data.overview.over90, tone: 'late' },
              { label: 'All late invoices', bucket: data.overview.late, tone: 'late' },
            ]}
            label="Aged receivables at a glance"
          />
          <ReportTable
            columns={[
              invoiceColumns.client,
              invoiceColumns.total,
              invoiceColumns.balance,
              invoiceColumns.due,
              invoiceColumns.issued,
              invoiceColumns.number,
              { header: 'Late by', numeric: true, cell: (row) => `${row.daysLate} ${row.daysLate === 1 ? 'day' : 'days'}`, csv: (row) => row.daysLate },
              invoiceColumns.email,
              invoiceColumns.phone,
            ]}
            empty="No invoice is late."
            fileName="Aged receivables.csv"
            label="Late invoices"
            rowKey={(row) => row.id}
            rows={data.rows}
            truncated={data.truncated}
          />
        </>
      )}
    </Loaded>
  );
}

function Transactions({ range }: { range: (ReportRange & ReportCompany) | null }) {
  const query = useTransactionsReport(range);
  const columns: ReportColumn<TransactionRow>[] = [
    {
      header: 'Client',
      cell: (row) => clientCell({ id: row.invoiceId, clientName: row.clientName }),
      csv: (row) => row.clientName,
    },
    { header: 'Date', cell: (row) => formatInvoiceDay(row.on), csv: (row) => row.on },
    {
      header: 'Type',
      cell: (row) =>
        row.paymentId ? (
          <Link className="hover:underline" href={`/payments/${row.paymentId}`}>
            {TRANSACTION_KIND_LABEL[row.kind]}
          </Link>
        ) : (
          TRANSACTION_KIND_LABEL[row.kind]
        ),
      csv: (row) => TRANSACTION_KIND_LABEL[row.kind],
    },
    { header: 'Invoice #', wide: true, cell: (row) => (row.invoiceNumber ? `#${row.invoiceNumber}` : '—'), csv: (row) => row.invoiceNumber },
    { header: 'Total', numeric: true, cell: (row) => <span className={row.totalCents < 0 ? 'text-destructive' : undefined}>{money(row.totalCents)}</span>, csv: (row) => csvMoney(row.totalCents) },
    { header: 'Reference', wide: true, cell: (row) => row.reference ?? '—', csv: (row) => row.reference },
    { header: 'Method', cell: (row) => (row.method ? PAYMENT_METHOD_LABEL[row.method] : '—'), csv: (row) => (row.method ? PAYMENT_METHOD_LABEL[row.method] : null) },
    { header: 'Job #', wide: true, cell: (row) => row.jobNumber ?? '—', csv: (row) => row.jobNumber },
  ];
  return (
    <Loaded query={query} waiting={!range}>
      {(data) => (
        <>
          <ReportCards
            cards={[
              { label: 'Paid', bucket: data.overview.paid, noun: data.overview.paid.count === 1 ? 'payment' : 'payments' },
              { label: 'Refunded', bucket: data.overview.refunded, noun: data.overview.refunded.count === 1 ? 'refund' : 'refunds' },
              { label: 'Invoiced', bucket: data.overview.invoiced },
              { label: 'Invoiced less paid', bucket: data.overview.balance },
            ]}
            label="Transactions at a glance"
          />
          <ReportTable
            columns={columns}
            empty="Nothing was invoiced or paid in these days."
            fileName={`Transactions ${days(range)}.csv`}
            key={days(range)}
            label="Transactions"
            rowKey={(row) => `${row.kind}:${row.paymentId ?? row.invoiceId}`}
            rows={data.rows}
            truncated={data.truncated}
          />
        </>
      )}
    </Loaded>
  );
}

function InvoicesReport({
  range,
  dateField,
  badDebt,
}: {
  range: (ReportRange & ReportCompany) | null;
  dateField: InvoiceReportDate;
  badDebt: boolean;
}) {
  const query = useInvoicesReport(range ? { ...range, dateField, ...(badDebt ? { status: 'BAD_DEBT' as const } : {}) } : null);
  const columns: ReportColumn<ReportInvoiceRow>[] = [
    invoiceColumns.client,
    invoiceColumns.number,
    { header: 'Created', wide: true, cell: (row) => formatInvoiceDay(row.createdOn), csv: (row) => row.createdOn },
    invoiceColumns.issued,
    { header: 'Subject', wide: true, cell: (row) => row.subject, csv: (row) => row.subject },
    { header: 'Status', cell: (row) => <InvoiceStatusBadge status={row.status} />, csv: (row) => INVOICE_STATUS_LABEL[row.status] },
    invoiceColumns.total,
    invoiceColumns.balance,
    { header: 'Client emails', wide: true, cell: (row) => <span className="text-muted-foreground">{row.emails.join(', ') || '—'}</span>, csv: (row) => row.emails.join(', ') },
  ];
  const name = badDebt ? 'Bad debt' : 'Invoices';
  return (
    <Loaded query={query} waiting={!range}>
      {(data) => (
        <>
          <ReportCards
            cards={
              badDebt
                ? [{ label: 'Bad debt', bucket: data.overview.badDebt, tone: 'late' }]
                : [
                    { label: 'Drafts', bucket: data.overview.draft },
                    { label: 'Awaiting payment', bucket: data.overview.awaiting },
                    { label: 'Paid', bucket: data.overview.paid },
                    { label: 'Bad debt', bucket: data.overview.badDebt, tone: 'late' },
                    { label: 'Total', bucket: data.overview.total },
                  ]
            }
            label={`${name} at a glance`}
          />
          <ReportTable
            columns={columns}
            empty={badDebt ? 'No invoice in these days was marked bad debt.' : 'No invoice in these days.'}
            fileName={`${name} ${days(range)}.csv`}
            key={`${days(range)}:${dateField}`}
            label={name}
            rowKey={(row) => row.id}
            rows={data.rows}
            truncated={data.truncated}
          />
        </>
      )}
    </Loaded>
  );
}

function Taxation({ range, basis }: { range: (ReportRange & ReportCompany) | null; basis: TaxBasis }) {
  const query = useTaxReport(range ? { ...range, basis } : null);
  const columns: ReportColumn<TaxReportRow>[] = [
    { header: 'Tax rate', cell: (row) => row.rateName, csv: (row) => row.rateName },
    { header: 'Rate', numeric: true, cell: (row) => (row.ratePercent === null ? '—' : `${row.ratePercent}%`), csv: (row) => row.ratePercent },
    { header: 'Invoices', numeric: true, cell: (row) => row.invoices.toLocaleString('en-US'), csv: (row) => row.invoices },
    { header: 'Before tax', numeric: true, cell: (row) => money(row.taxableCents), csv: (row) => csvMoney(row.taxableCents) },
    { header: 'Tax', numeric: true, cell: (row) => money(row.taxCents), csv: (row) => csvMoney(row.taxCents) },
    { header: 'Total', numeric: true, cell: (row) => money(row.totalCents), csv: (row) => csvMoney(row.totalCents) },
  ];
  return (
    <Loaded query={query} waiting={!range}>
      {(data) => (
        <>
          <p className="text-muted-foreground mb-3 text-sm">
            {basis === 'ACCRUAL'
              ? 'Every invoice sent in these days, whether or not it is paid yet.'
              : 'Every payment that came in these days, with its share of its invoice’s tax.'}{' '}
            Tax still to collect on invoices sent in these days: <span className="text-heading font-semibold">{money(data.awaitingCollectionCents)}</span>.
          </p>
          <ReportTable
            columns={columns}
            empty="Nothing was invoiced or collected in these days."
            fileName={`Taxation ${basis === 'ACCRUAL' ? 'accrual' : 'cash'} ${days(range)}.csv`}
            footer={
              <TableRow className="font-semibold">
                <TableCell>Total</TableCell>
                <TableCell />
                <TableCell className="text-right tabular-nums">{data.totals.invoices.toLocaleString('en-US')}</TableCell>
                <TableCell className="text-right tabular-nums">{money(data.totals.taxableCents)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(data.totals.taxCents)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(data.totals.totalCents)}</TableCell>
              </TableRow>
            }
            key={`${days(range)}:${basis}`}
            label="Tax by rate"
            rowKey={(row) => `${row.rateName}|${row.ratePercent}`}
            rows={data.rows}
          />
        </>
      )}
    </Loaded>
  );
}

function ClientBalances({ company }: { company?: string }) {
  const query = useClientBalances(company);
  const columns: ReportColumn<ClientBalanceRow>[] = [
    {
      header: 'Name',
      cell: (row) =>
        row.propertyId ? (
          <Link className="text-heading font-medium hover:underline" href={`/properties/${row.propertyId}`}>
            {row.clientName}
          </Link>
        ) : (
          row.clientName
        ),
      csv: (row) => row.clientName,
    },
    { header: 'Email', wide: true, cell: (row) => <span className="text-muted-foreground">{row.email ?? '—'}</span>, csv: (row) => row.email },
    { header: 'Phone', wide: true, cell: (row) => <span className="text-muted-foreground">{row.phone ?? '—'}</span>, csv: (row) => row.phone },
    { header: 'Invoiced', numeric: true, cell: (row) => money(row.invoicedCents), csv: (row) => csvMoney(row.invoicedCents) },
    { header: 'Paid to date', numeric: true, cell: (row) => money(row.paidCents), csv: (row) => csvMoney(row.paidCents) },
    {
      header: 'Balance',
      numeric: true,
      cell: (row) => <span className={row.balanceCents < 0 ? 'text-success font-semibold' : 'font-semibold'}>{money(row.balanceCents)}</span>,
      csv: (row) => csvMoney(row.balanceCents),
    },
    { header: 'Late balance', numeric: true, cell: (row) => money(row.lateBalanceCents), csv: (row) => csvMoney(row.lateBalanceCents) },
    { header: 'Days to pay', numeric: true, wide: true, cell: (row) => row.paymentDays ?? '—', csv: (row) => row.paymentDays },
    {
      header: 'Last emailed',
      wide: true,
      cell: (row) => <span className="text-muted-foreground">{row.lastEmailedAt ? formatInvoiceMoment(row.lastEmailedAt) : '—'}</span>,
      csv: (row) => row.lastEmailedAt,
    },
  ];
  return (
    <Loaded query={query}>
      {(data) => (
        <>
          <ReportCards
            cards={[
              { label: 'Outstanding', bucket: data.overview.outstanding, noun: data.overview.outstanding.count === 1 ? 'client' : 'clients' },
              { label: 'In credit', bucket: data.overview.credit, noun: data.overview.credit.count === 1 ? 'client' : 'clients', tone: 'credit' },
              { label: 'All clients', bucket: data.overview.total, noun: data.overview.total.count === 1 ? 'client' : 'clients' },
            ]}
            label="Client balances at a glance"
          />
          <ReportTable
            columns={columns}
            empty="No invoice has been sent."
            fileName="Client balances.csv"
            label="Client balances"
            rowKey={(row) => row.key}
            rows={data.rows}
            truncated={data.truncated}
          />
        </>
      )}
    </Loaded>
  );
}
