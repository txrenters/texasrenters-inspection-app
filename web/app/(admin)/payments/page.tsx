'use client';

import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABEL,
  formatMoney,
  formatMoneyShort,
  type PaymentListItem,
  type PaymentMethod,
} from '@texasrenters/shared';
import Link from 'next/link';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { formatInvoiceDay } from '@/components/invoices/invoice-parts';
import { ListToolbar, SelectFilter } from '@/components/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { EmptyState, ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { usePayments } from '@/lib/invoice-queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useUrlState } from '@/lib/url-state';

/**
 * The payments recorded against the office's invoices, newest first, as
 * Jobber's Payments list: who paid, when, how and how much, and the invoice it
 * went to. Recorded by hand -- here or in Jobber -- once the charge has posted
 * in Propertyware; nothing on this page takes money.
 */

const COLUMNS: Array<Column<PaymentListItem>> = [
  {
    key: 'client',
    header: 'Client',
    primary: true,
    cell: (row) => (
      <div className="min-w-0">
        <div className="truncate">{row.invoice.clientName}</div>
        {row.property?.city ? <div className="text-muted-foreground truncate text-xs">{row.property.city}</div> : null}
      </div>
    ),
  },
  { key: 'date', header: 'Payment date', cell: (row) => formatInvoiceDay(row.paidOn) },
  {
    key: 'invoice',
    header: 'Invoice',
    cell: (row) => (
      <Link className="relative z-10 underline-offset-2 hover:underline" href={`/invoices/${row.invoice.id}`}>
        {row.invoice.number ? `#${row.invoice.number}` : row.invoice.subject}
      </Link>
    ),
  },
  {
    key: 'method',
    header: 'Method',
    hideBelow: 'md',
    cell: (row) => (
      <div className="min-w-0">
        <div>{PAYMENT_METHOD_LABEL[row.method]}</div>
        {row.reference ? <div className="text-muted-foreground truncate text-xs">{row.reference}</div> : null}
      </div>
    ),
  },
  {
    key: 'recorded',
    header: 'Recorded by',
    hideBelow: 'lg',
    cell: (row) => <span className="text-muted-foreground">{row.recordedBy?.displayName ?? 'In Jobber'}</span>,
  },
  { key: 'amount', header: 'Amount', numeric: true, cell: (row) => <span className="font-semibold">{formatMoney(row.amountCents)}</span> },
];

export default function PaymentsPage() {
  const [state, setState, reset] = useUrlState({ page: 1, q: '', method: '' });
  const search = useDebouncedValue(state.q);
  const pending = state.q.trim() !== search.trim();
  const method = (PAYMENT_METHODS as readonly string[]).includes(state.method) ? (state.method as PaymentMethod) : undefined;
  const payments = usePayments({ search, method, page: state.page });
  const data = payments.data;
  const busy = payments.isLoading || pending;

  return (
    <>
      <PageHeader
        info={
          <p>
            Payments are recorded by hand once the charge has posted to the tenant&apos;s ledger in Propertyware, here or
            in Jobber. Nothing on this page takes money.
          </p>
        }
        infoLabel="How payments are recorded"
        title="Payments"
      />

      {data ? (
        <section aria-label="Payments at a glance" className="-mx-1 mb-6 overflow-x-auto px-1 pb-1">
          <div className="flex gap-3">
            <Received caption="Past 30 days" count={data.received.last30.count} title="Received" value={data.received.last30.amountCents} />
            <Received
              caption="The 30 days before"
              count={data.received.previous30.count}
              title="Received before"
              value={data.received.previous30.amountCents}
            />
          </div>
        </section>
      ) : null}

      <ListToolbar
        filters={
          <SelectFilter
            allLabel="All"
            label="Method"
            onChange={(next) => setState({ method: next, page: 1 })}
            options={PAYMENT_METHODS.map((value) => ({ value, label: PAYMENT_METHOD_LABEL[value] }))}
            value={method ?? ''}
          />
        }
        heading="All payments"
        onClear={reset}
        onSearch={(q) => setState({ q, page: 1 })}
        pending={pending}
        resultLabel={busy ? 'Searching payments…' : `${(data?.total ?? 0).toLocaleString('en-US')} payments`}
        search={state.q}
        searchLabel="Search payments by address or invoice number"
        searchPlaceholder="Search payments…"
      />

      {busy && !data ? (
        <DataTableSkeleton columns={COLUMNS} label="Loading payments" rows={8} />
      ) : payments.isError ? (
        <ErrorState error={payments.error} retry={() => void payments.refetch()} />
      ) : !data?.items.length ? (
        <EmptyState
          description={
            state.q.trim() || method
              ? 'No payment matches. Try another method or a shorter search.'
              : 'Payments appear here as they are recorded against an invoice.'
          }
          title="No payments"
        >
          {state.q.trim() || method ? (
            <Button onClick={reset} variant="outline">
              Clear filters
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <>
          <DataTable columns={COLUMNS} label="Payments" rowKey={(row) => row.id} rows={data.items} />
          <Pagination
            onPage={(page) => setState({ page })}
            page={data.page}
            total={data.total}
            totalPages={data.totalPages}
          />
        </>
      )}
    </>
  );
}

function Received({ title, caption, value, count }: { title: string; caption: string; value: number; count: number }) {
  return (
    <div className="bg-card flex min-w-52 flex-1 flex-col rounded-lg border p-4">
      <h2 className="text-heading text-base font-bold">{title}</h2>
      <p className="text-muted-foreground text-xs">{caption}</p>
      <span className="font-display text-heading mt-auto pt-4 text-3xl leading-none font-extrabold tabular-nums">
        {formatMoneyShort(value)}
      </span>
      <p className="text-muted-foreground mt-1 text-sm">
        {count.toLocaleString('en-US')} {count === 1 ? 'payment' : 'payments'}
      </p>
    </div>
  );
}
