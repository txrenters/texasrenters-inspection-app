'use client';

import { formatMoney, type PurchaseOrderRow, type RequisitionRow } from '@texasrenters/shared';
import { CheckCircle2Icon } from 'lucide-react';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { PurchaseOrderStatusBadge, RequisitionStageBadge } from '@/components/purchasing/requisition-parts';
import { EmptyState, ErrorState } from '@/components/states';
import { EMPTY, formatCount, formatDay } from '@/lib/format';
import { useOrdersToApprove, useRequisitionsToApprove } from '@/lib/purchasing-queries';

/**
 * Requests to Approve (the office, 2026-11-21), as NAV's: what waits for the
 * caller's approval now, the longest waiting first. A requisition is an
 * approver's of its department and company; an order is the purchasing
 * manager's, before the purchaser sends it. Each opens where it is decided.
 */

const REQUISITION_COLUMNS: Array<Column<RequisitionRow>> = [
  { key: 'number', header: 'No.', cell: (row) => row.number ?? 'Draft', className: 'whitespace-nowrap' },
  {
    key: 'what',
    header: 'What',
    primary: true,
    cell: (row) => (
      <span className="grid gap-0.5">
        <span className="font-medium">{row.summary || 'Nothing asked for yet'}</span>
        <span className="text-muted-foreground text-xs">
          {formatCount(row.lineCount)} item{row.lineCount === 1 ? '' : 's'} · asked by {row.requestedBy.name}
        </span>
      </span>
    ),
  },
  { key: 'department', header: 'Department', hideBelow: 'md', cell: (row) => row.department?.code ?? (row.lineDepartments?.join(', ') || EMPTY) },
  { key: 'company', header: 'Company', hideBelow: 'lg', cell: (row) => row.company?.purchaserCode ?? row.company?.name ?? EMPTY },
  { key: 'sent', header: 'Sent', hideBelow: 'lg', cell: (row) => formatDay(row.submittedAt ?? row.createdAt), className: 'whitespace-nowrap' },
  { key: 'total', header: 'Est. total', numeric: true, cell: (row) => formatMoney(row.estimatedTotalCents) },
  { key: 'status', header: 'Status', cell: (row) => <RequisitionStageBadge stage={row.stage} /> },
];

const ORDER_COLUMNS: Array<Column<PurchaseOrderRow>> = [
  { key: 'number', header: 'No.', cell: (row) => row.number ?? 'Draft', className: 'whitespace-nowrap' },
  {
    key: 'vendor',
    header: 'Vendor',
    primary: true,
    cell: (row) => (
      <span className="grid gap-0.5">
        <span className="font-medium">{row.vendor?.name ?? 'No vendor chosen yet'}</span>
        <span className="text-muted-foreground text-xs">
          {formatCount(row.lineCount)} item{row.lineCount === 1 ? '' : 's'} · from {row.requisition.number ?? 'a requisition'} · made by {row.madeBy.name}
        </span>
      </span>
    ),
  },
  { key: 'company', header: 'Company', hideBelow: 'lg', cell: (row) => row.company?.name ?? EMPTY },
  { key: 'total', header: 'Total', numeric: true, cell: (row) => formatMoney(row.totalCents) },
  { key: 'status', header: 'Status', cell: (row) => <PurchaseOrderStatusBadge status={row.status} /> },
];

export function ApprovalsTab({ requisitions: approvesRequisitions, orders: approvesOrders }: { requisitions: boolean; orders: boolean }) {
  const requisitions = useRequisitionsToApprove(approvesRequisitions);
  const orders = useOrdersToApprove(approvesOrders);
  const loading = (approvesRequisitions && requisitions.isLoading) || (approvesOrders && orders.isLoading);
  if (loading) return <DataTableSkeleton columns={REQUISITION_COLUMNS} label="Loading what waits for your approval" rows={4} />;
  const failed = (approvesRequisitions && requisitions.isError ? requisitions : null) ?? (approvesOrders && orders.isError ? orders : null);
  if (failed) return <ErrorState error={failed.error} retry={() => void failed.refetch()} />;

  const waitingRequisitions = approvesRequisitions ? (requisitions.data ?? []) : [];
  const waitingOrders = approvesOrders ? (orders.data ?? []) : [];
  if (!waitingRequisitions.length && !waitingOrders.length)
    return <EmptyState description="Requisitions of your departments and purchase orders for you to approve show here as soon as they are sent." icon={CheckCircle2Icon} title="Nothing waits for your approval" />;

  return (
    <div className="grid gap-6">
      {approvesRequisitions ? (
        <section aria-labelledby="to-approve-requisitions" className="grid gap-2">
          <h2 className="text-heading text-base font-semibold" id="to-approve-requisitions">
            Purchase requisitions <span className="text-muted-foreground text-sm font-normal">· {formatCount(waitingRequisitions.length)}</span>
          </h2>
          {waitingRequisitions.length ? (
            <DataTable columns={REQUISITION_COLUMNS} label="Requisitions to approve" rowHref={(row) => `/purchasing/requisitions/${row.id}`} rowKey={(row) => row.id} rows={waitingRequisitions} />
          ) : (
            <p className="text-muted-foreground text-sm">No requisition waits for you.</p>
          )}
        </section>
      ) : null}
      {approvesOrders ? (
        <section aria-labelledby="to-approve-orders" className="grid gap-2">
          <h2 className="text-heading text-base font-semibold" id="to-approve-orders">
            Purchase orders <span className="text-muted-foreground text-sm font-normal">· {formatCount(waitingOrders.length)}</span>
          </h2>
          {waitingOrders.length ? (
            <DataTable columns={ORDER_COLUMNS} label="Purchase orders to approve" rowHref={(row) => `/purchasing/orders/${row.id}`} rowKey={(row) => row.id} rows={waitingOrders} />
          ) : (
            <p className="text-muted-foreground text-sm">No purchase order waits for you.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
