'use client';

import { formatMoney, type PurchaseOrderRow } from '@texasrenters/shared';
import { PackageIcon } from 'lucide-react';
import Link from 'next/link';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { PendingProcessing } from '@/components/purchasing/pending-processing';
import { PurchaseOrderStatusBadge } from '@/components/purchasing/requisition-parts';
import { EmptyState, ErrorState } from '@/components/states';
import { buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SegmentedControl } from '@/components/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { usePermissions } from '@/lib/auth';
import { EMPTY, formatDay } from '@/lib/format';
import { usePendingOrderLines, usePurchaseOrders } from '@/lib/purchasing-queries';

/**
 * The purchase orders (2026-11-19, phase 3): one read of the open ones, or of
 * the latest cancelled ones, when the tab is opened; the search works on the
 * rows in hand. Beside them, for a purchaser, Pending Processing (2026-11-23):
 * the approved requisition lines not ordered yet, made into orders there.
 */

const COLUMNS: Array<Column<PurchaseOrderRow>> = [
  { key: 'number', header: 'No.', cell: (row) => row.number ?? 'Draft', className: 'whitespace-nowrap' },
  {
    key: 'vendor',
    header: 'Vendor',
    primary: true,
    cell: (row) => (
      <span className="grid gap-0.5">
        <span className="font-medium">{row.vendor?.name ?? 'No vendor chosen yet'}</span>
        <span className="text-muted-foreground text-xs">
          {row.lineCount} item{row.lineCount === 1 ? '' : 's'} · from {fromRequisitions(row)}
        </span>
      </span>
    ),
  },
  { key: 'company', header: 'Company', hideBelow: 'xl', cell: (row) => row.company?.name ?? EMPTY },
  { key: 'by', header: 'Made by', hideBelow: 'md', cell: (row) => row.madeBy.name },
  { key: 'expected', header: 'Expected', hideBelow: 'lg', cell: (row) => (row.expectedOn ? formatDay(row.expectedOn) : EMPTY), className: 'whitespace-nowrap' },
  { key: 'total', header: 'Total', numeric: true, cell: (row) => formatMoney(row.totalCents) },
  { key: 'status', header: 'Status', cell: (row) => <PurchaseOrderStatusBadge status={row.status} /> },
];

/** "PR-0012", "PR-0012 and PR-0014", "PR-0012 and 2 more" (2026-11-23: an order may carry several). */
function fromRequisitions(row: PurchaseOrderRow): string {
  const numbers = (row.requisitions?.length ? row.requisitions : [row.requisition]).map((one) => one.number ?? 'a requisition');
  return numbers.length <= 2 ? numbers.join(' and ') : `${numbers[0]} and ${numbers.length - 1} more`;
}

type OrdersState = { show: string; q: string; view: string };

export function OrdersTab({ state, setState }: { state: OrdersState; setState: (next: Partial<OrdersState>) => void }) {
  // Pending Processing is a purchaser's: whoever makes orders.
  const { has } = usePermissions();
  const buys = has('purchasing:order');
  const pending = usePendingOrderLines(buys);
  const view = buys && state.view === 'pending' ? 'pending' : 'orders';
  const lineCount = pending.data?.lines.length;

  return (
    <div className="grid gap-4">
      {buys ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <SegmentedControl
            aria-label="Orders, or the lines still to order"
            onChange={(next) => setState({ view: next })}
            options={[
              { value: 'orders', label: 'Orders' },
              { value: 'pending', label: 'Pending Processing', count: lineCount },
            ]}
            value={view}
          />
          {view === 'pending' ? (
            <span className="text-muted-foreground flex-[1_1_22rem] text-sm">
              Every approved requisition line not ordered yet, by company and vendor. Tick lines, or a whole vendor, and make one purchase order for each vendor and company.
            </span>
          ) : null}
        </div>
      ) : null}
      {view === 'pending' ? <PendingProcessing onMade={() => setState({ view: 'orders' })} /> : <OrderList setState={setState} state={state} />}
    </div>
  );
}

function OrderList({ state, setState }: { state: OrdersState; setState: (next: Partial<OrdersState>) => void }) {
  const show = state.show === 'closed' ? 'closed' : 'open';
  const list = usePurchaseOrders(show, true);
  if (list.isLoading) return <DataTableSkeleton columns={COLUMNS} label="Loading orders" rows={5} />;
  if (list.isError || !list.data) return <ErrorState error={list.error} retry={() => void list.refetch()} />;

  const words = state.q.trim().toLowerCase();
  const rows = list.data.orders.filter((row) => !words || `${row.number ?? ''} ${row.vendor?.name ?? ''} ${fromRequisitions(row)} ${row.madeBy.name}`.toLowerCase().includes(words));

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="orders-show">Show</Label>
          <Select onValueChange={(next) => setState({ show: next })} value={show}>
            <SelectTrigger className="w-56" id="orders-show">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Open orders</SelectItem>
              <SelectItem value="closed">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto grid w-full gap-1.5 sm:w-64">
          <Label htmlFor="orders-search">Search orders</Label>
          <Input id="orders-search" onChange={(event) => setState({ q: event.target.value })} placeholder="Number, vendor or person" type="search" value={state.q} />
        </div>
      </div>
      {rows.length ? (
        <DataTable columns={COLUMNS} label="Purchase orders" rowHref={(row) => `/purchasing/orders/${row.id}`} rowKey={(row) => row.id} rows={rows} />
      ) : (
        <EmptyState
          description={
            list.data.orders.length
              ? 'No order matches the search.'
              : show === 'open'
                ? 'An order is made from approved requisitions on Pending Processing, or from one requisition with Make Purchase Order.'
                : 'No order has been cancelled.'
          }
          icon={PackageIcon}
          title={list.data.orders.length ? 'Nothing to show' : show === 'open' ? 'No open orders' : 'None'}
        >
          {!list.data.orders.length && show === 'open' ? (
            <Link className={buttonVariants({ variant: 'outline', size: 'sm' })} href="/purchasing?tab=requisitions&status=PENDING_PROCESSING">
              Requisitions Pending Processing
            </Link>
          ) : null}
        </EmptyState>
      )}
    </div>
  );
}
