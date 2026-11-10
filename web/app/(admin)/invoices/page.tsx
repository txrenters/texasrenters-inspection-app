'use client';

import {
  INVOICE_FILTERS,
  INVOICE_FILTER_LABEL,
  formatMoney,
  type InvoiceFilter,
  type InvoiceSummary,
} from '@texasrenters/shared';
import { ChartColumnIcon, SettingsIcon } from 'lucide-react';
import Link from 'next/link';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { InvoiceStatusBadge, InvoicesOverview, formatInvoiceDay } from '@/components/invoices/invoice-parts';
import { RangePicker, chosenRange } from '@/components/invoices/report-range';
import { ListToolbar, SelectFilter } from '@/components/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { EmptyState, ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { usePermissions } from '@/lib/auth';
import { businessToday, shiftDay } from '@/lib/clock';
import { formatRelative } from '@/lib/format';
import { useUninvoicedVisits } from '@/lib/invoice-batch-queries';
import { noInvoicesYet } from '@/lib/invoice-read';
import { useInvoices } from '@/lib/invoice-queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useUrlState } from '@/lib/url-state';

/**
 * The invoices, as Jobber lists them (2026-11-05): the Overview of what is
 * owed and what is not sent, then every invoice with its client, number, due
 * day, subject, status, total and what it still owes, filtered by status and
 * searched by address or number.
 *
 * The console's copy of Jobber's, read from Jobber every few minutes by the
 * server; opening this page asks Jobber nothing.
 */

const COLUMNS: Array<Column<InvoiceSummary>> = [
  {
    key: 'client',
    header: 'Client',
    primary: true,
    cell: (row) => (
      <div className="min-w-0">
        <div className="truncate">{row.clientName}</div>
        {row.property?.city ? <div className="text-muted-foreground truncate text-xs">{row.property.city}</div> : null}
      </div>
    ),
  },
  {
    key: 'number',
    header: 'Invoice #',
    cell: (row) => <span className="tabular-nums">{row.number ? `#${row.number}` : '—'}</span>,
  },
  {
    key: 'due',
    header: 'Due date',
    hideBelow: 'md',
    cell: (row) => <span className="whitespace-nowrap">{formatInvoiceDay(row.dueOn)}</span>,
  },
  { key: 'subject', header: 'Subject', hideBelow: 'lg', cell: (row) => <span className="truncate">{row.subject}</span> },
  { key: 'status', header: 'Status', cell: (row) => <InvoiceStatusBadge status={row.status} /> },
  { key: 'total', header: 'Total', numeric: true, cell: (row) => formatMoney(row.totalCents) },
  {
    key: 'balance',
    header: 'Balance',
    numeric: true,
    cell: (row) => <span className={row.balanceCents > 0 ? 'font-semibold' : 'text-muted-foreground'}>{formatMoney(row.balanceCents)}</span>,
  },
];

export default function InvoicesPage() {
  const [state, setState, reset] = useUrlState({ page: 1, q: '', filter: '', issued: '', from: '', to: '', company: '' });
  const search = useDebouncedValue(state.q);
  const pending = state.q.trim() !== search.trim();
  const filter = (INVOICE_FILTERS as readonly string[]).includes(state.filter) ? (state.filter as InvoiceFilter) : 'all';
  // Issued in the days chosen, as Jobber's list filters by date (2026-11-09).
  const issuedChoice = { range: state.issued, from: state.from, to: state.to };
  const issued = chosenRange(issuedChoice);
  const invoices = useInvoices({
    filter,
    search,
    page: state.page,
    pageSize: 25,
    issuedFrom: issued?.from,
    issuedTo: issued?.to,
    company: state.company || undefined,
  });
  const filtered = Boolean(state.q.trim()) || filter !== 'all' || Boolean(state.issued) || Boolean(state.company);
  const { has } = usePermissions();

  const data = invoices.data;
  const busy = invoices.isLoading || pending;
  // Made here once the console owns invoicing (2026-11-06); in Jobber until then.
  const mayCreate = has('invoices:manage') && data?.writesEnabled === true;
  const total = (data?.total ?? 0).toLocaleString('en-US');
  const resultLabel = busy ? 'Searching invoices…' : `${total} ${filter === 'all' ? 'invoices' : INVOICE_FILTER_LABEL[filter].toLowerCase()}`;

  return (
    <>
      <PageHeader
        actions={
          <>
            <Button asChild size="sm" variant="outline">
              <Link href="/invoices/settings">
                <SettingsIcon />
                Settings
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/invoices/reports">
                <ChartColumnIcon />
                Reports
              </Link>
            </Button>
            {has('invoices:manage') ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/invoices/deliver">Batch deliver</Link>
              </Button>
            ) : null}
            {mayCreate ? (
              <>
                <Button asChild size="sm" variant="outline">
                  <Link href="/invoices/batch">Batch create</Link>
                </Button>
                <Button asChild size="sm">
                  <Link href="/invoices/new">New invoice</Link>
                </Button>
              </>
            ) : null}
          </>
        }
        info={
          <>
            <p>
              The office&apos;s invoices in Jobber, one for each visit billed: made out to the property, a line for
              each service done.
            </p>
            <p>
              A payment is recorded here once the charge has posted to the tenant&apos;s ledger in Propertyware, and
              the invoice is marked paid in Jobber. No card is charged.
            </p>
          </>
        }
        infoLabel="Where invoices come from"
        title="Invoices"
      />

      {data ? <InvoicesOverview issued={data.issued} overview={data.overview} /> : null}
      {mayCreate ? <VisitsToInvoice /> : null}

      <ListToolbar
        filters={
          <>
            <SelectFilter
              allLabel="All"
              label="Status"
              onChange={(next) => setState({ filter: next, page: 1 })}
              options={INVOICE_FILTERS.filter((key) => key !== 'all').map((key) => ({
                value: key,
                label: `${INVOICE_FILTER_LABEL[key]}${data ? ` (${data.filterCounts[key].toLocaleString('en-US')})` : ''}`,
              }))}
              value={filter === 'all' ? '' : filter}
            />
            <RangePicker
              allowAllDates
              choice={issuedChoice}
              label="Issued"
              onChange={(next) => setState({ issued: next.range, from: next.from, to: next.to, page: 1 })}
            />
            {data?.organisations?.length ? (
              // Each company's books (2026-11-10): once Xero has an organisation.
              <SelectFilter
                allLabel="All"
                label="Company"
                onChange={(next) => setState({ company: next, page: 1 })}
                options={[
                  ...data.organisations.map((organisation) => ({
                    value: organisation.tenantId,
                    label: organisation.connected ? organisation.name : `${organisation.name} (not connected)`,
                  })),
                  { value: 'none', label: 'No company' },
                ]}
                value={state.company}
              />
            ) : null}
          </>
        }
        heading="All invoices"
        onClear={reset}
        onSearch={(q) => setState({ q, page: 1 })}
        pending={pending}
        resultLabel={resultLabel}
        search={state.q}
        searchLabel="Search invoices by address or number"
        searchPlaceholder="Search invoices…"
      />

      {busy && !data ? (
        <DataTableSkeleton columns={COLUMNS} label="Loading invoices" rows={8} />
      ) : invoices.isError ? (
        <ErrorState error={invoices.error} retry={() => void invoices.refetch()} />
      ) : !data?.items.length ? (
        <EmptyState
          description={
            filtered
              ? 'No invoice matches. Try another status, other days, another company or a shorter search.'
              : noInvoicesYet(data?.jobberRead)
          }
          title="No invoices"
        >
          {filtered ? (
            <Button onClick={reset} variant="outline">
              Clear filters
            </Button>
          ) : (
            <Button asChild variant="outline">
              <Link href="/integrations/jobber">Jobber connection</Link>
            </Button>
          )}
        </EmptyState>
      ) : (
        <>
          <DataTable
            columns={COLUMNS}
            label="Invoices"
            rowHref={(row) => `/invoices/${row.id}`}
            rowKey={(row) => row.id}
            rows={data.items}
          />
          <Pagination
            onPage={(page) => setState({ page })}
            page={data.page}
            total={data.total}
            totalPages={data.totalPages}
          />
          {data.jobberRead && !data.jobberRead.firstReadDone ? (
            <p className="text-muted-foreground mt-3 text-xs">
              Still reading Jobber&apos;s invoices for the first time; more appear every few minutes.
            </p>
          ) : data.syncedAt ? (
            <p className="text-muted-foreground mt-3 text-xs">Up to date with Jobber {formatRelative(data.syncedAt)}.</p>
          ) : null}
        </>
      )}
    </>
  );
}

/** How far back the nudge looks: Jobber's "requires invoicing" has no end, but a month is what the office still bills. */
const NUDGE_DAYS = 30;

/**
 * Jobber's "jobs requiring invoicing" (2026-11-09): the finished visits of the
 * past month with no invoice yet, once the console makes invoices. A read of
 * the console's own database, made when the list opens; nothing billed.
 */
function VisitsToInvoice() {
  const today = businessToday();
  const visits = useUninvoicedVisits({ from: shiftDay(today, -NUDGE_DAYS), to: today });
  const count = visits.data?.items.length ?? 0;
  if (!count) return null;
  return (
    <p className="bg-card mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3 text-sm" role="status">
      <span>
        <span className="text-heading font-semibold tabular-nums">
          {count}
          {visits.data?.truncated ? '+' : ''}
        </span>{' '}
        finished {count === 1 ? 'visit has' : 'visits have'} no invoice yet, in the last {NUDGE_DAYS} days.
      </span>
      <Button asChild size="sm" variant="outline">
        <Link href="/invoices/batch">Invoice them</Link>
      </Button>
    </p>
  );
}
