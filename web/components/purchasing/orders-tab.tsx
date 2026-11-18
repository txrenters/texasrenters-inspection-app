'use client';

import { formatMoney, type PurchaseOrderRow } from '@texasrenters/shared';
import { PackageIcon } from 'lucide-react';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { PurchaseOrderStatusBadge } from '@/components/purchasing/requisition-parts';
import { EmptyState, ErrorState } from '@/components/states';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EMPTY, formatDay } from '@/lib/format';
import { usePurchaseOrders } from '@/lib/purchasing-queries';

/**
 * The purchase orders (2026-11-19, phase 3): one read of the open ones, or of
 * the latest cancelled ones, when the tab is opened; the search works on the
 * rows in hand. An order is made from an approved requisition's own page.
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
          {row.lineCount} item{row.lineCount === 1 ? '' : 's'} · from {row.requisition.number ?? 'a requisition'}
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

export function OrdersTab({ state, setState }: { state: { show: string; q: string }; setState: (next: Partial<{ show: string; q: string }>) => void }) {
  const show = state.show === 'closed' ? 'closed' : 'open';
  const list = usePurchaseOrders(show, true);
  if (list.isLoading) return <DataTableSkeleton columns={COLUMNS} label="Loading orders" rows={5} />;
  if (list.isError || !list.data) return <ErrorState error={list.error} retry={() => void list.refetch()} />;

  const words = state.q.trim().toLowerCase();
  const rows = list.data.orders.filter((row) => !words || `${row.number ?? ''} ${row.vendor?.name ?? ''} ${row.requisition.number ?? ''} ${row.madeBy.name}`.toLowerCase().includes(words));

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
                ? 'An order is made from an approved requisition: open the requisition and choose Make purchase order.'
                : 'No order has been cancelled.'
          }
          icon={PackageIcon}
          title={list.data.orders.length ? 'Nothing to show' : show === 'open' ? 'No open orders' : 'None'}
        />
      )}
    </div>
  );
}
