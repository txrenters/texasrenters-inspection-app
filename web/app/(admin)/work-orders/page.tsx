'use client';

import { isUpcomingVisit, visitStateOf } from '@texasrenters/shared';
import { HammerIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { ListToolbar } from '@/components/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { EmptyState, ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { WorkOrderDialog } from '@/components/work-order-dialog';
import { WorkOrderMatchingActions } from '@/components/work-order-matching-actions';
import { EMPTY, formatScheduledDate, humanize } from '@/lib/format';
import { useInspections } from '@/lib/queries';
import { useUrlState } from '@/lib/url-state';
import { useDebouncedValue } from '@/lib/use-debounced-value';

/**
 * The work orders the maintenance app handed over for the in-house crews, by
 * work order.
 *
 * Each one arrived through POST /gateway/work-orders and was filed as a
 * MAINTENANCE or PEST_CONTROL visit with the work order's number on it (see
 * docs/integrations/TX_MAINTENANCE_WORK_ORDERS.md). Only those visits are
 * listed: a visit the office created by hand is not a work order, and a work
 * order the maintenance app is still holding -- over its approval line with no
 * owner approval yet -- has not arrived. Nothing is approved, held or sent from
 * here; that stays with the maintenance app.
 */

type WorkOrderRow = NonNullable<ReturnType<typeof useInspections>['data']>['items'][number];

const PAGE_SIZE = 20;

const currentTechnician = (row: WorkOrderRow) =>
  (row.assignments ?? []).find((assignment) => assignment.isCurrent)?.technician?.displayName ?? null;

const columns: Array<Column<WorkOrderRow>> = [
  {
    key: 'workOrder',
    header: 'Work order',
    primary: true,
    cell: (row) => (
      <span className="font-mono font-medium tabular-nums">
        {row.workOrderNumber ? `#${row.workOrderNumber}` : EMPTY}
      </span>
    ),
  },
  {
    key: 'property',
    header: 'Property',
    cell: (row) => (
      <div className="grid gap-0.5">
        <span>{row.propertywareBuilding?.name ?? EMPTY}</span>
        {row.propertywareUnit?.name ? (
          <span className="text-muted-foreground text-xs">Unit {row.propertywareUnit.name}</span>
        ) : null}
      </div>
    ),
  },
  {
    key: 'type',
    header: 'Crew',
    hideBelow: 'sm',
    cell: (row) => humanize(row.inspectionType),
  },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => <StatusBadge value={visitStateOf(row)} />,
  },
  {
    key: 'scheduled',
    header: 'Scheduled',
    hideBelow: 'md',
    cell: (row) => formatScheduledDate(row.scheduledAt),
  },
  {
    key: 'technician',
    header: 'Technician',
    cell: (row) =>
      currentTechnician(row) ??
      (isUpcomingVisit(visitStateOf(row)) ? (
        <StatusBadge value="UNASSIGNED" />
      ) : (
        <span className="text-muted-foreground text-xs">{EMPTY}</span>
      )),
  },
  {
    key: 'received',
    header: 'Received',
    hideBelow: 'lg',
    cell: (row) => formatScheduledDate(row.createdAt),
  },
];

export default function WorkOrdersPage() {
  const [state, setState] = useUrlState({ page: 1, q: '' });
  const [openId, setOpenId] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(state.q);
  const isSearchPending = state.q.trim() !== debouncedSearch.trim();

  const inspections = useInspections({
    page: state.page,
    pageSize: PAGE_SIZE,
    search: debouncedSearch || undefined,
    // The hand-offs and nothing else; newest first is the list's own order.
    source: 'WORK_ORDER',
  });
  const rows = useMemo(() => inspections.data?.items ?? [], [inspections.data?.items]);
  const total = inspections.data?.total ?? 0;
  const searching = debouncedSearch.trim() !== '';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Work orders"
        actions={<WorkOrderMatchingActions />}
        description="Repair and pest-control work orders handed over by the maintenance app for the in-house crews."
      />

      <ListToolbar
        heading="All work orders"
        onSearch={(q) => setState({ q, page: 1 })}
        pending={isSearchPending}
        resultLabel={total === 1 ? '1 work order' : `${total} work orders`}
        search={state.q}
        searchLabel="Search work orders"
        searchPlaceholder="Work order number or address"
      />

      {inspections.isLoading ? (
        <DataTableSkeleton columns={columns} label="Loading work orders" rows={8} />
      ) : inspections.isError ? (
        <ErrorState error={inspections.error} retry={() => void inspections.refetch()} />
      ) : rows.length === 0 ? (
        searching ? (
          <EmptyState
            description="No handed-over work order has that number or address."
            icon={HammerIcon}
            title="No work orders match"
          />
        ) : (
          <EmptyState
            description="Work orders arrive from the maintenance app the moment one of the in-house crews is assigned, and are filed as Maintenance and Pest control visits. None has arrived yet."
            icon={HammerIcon}
            title="No work orders yet"
          />
        )
      ) : (
        <>
          <DataTable
            columns={columns}
            label="Work orders"
            rowOpen={(row) => () => setOpenId(row.id)}
            rowKey={(row) => row.id}
            rows={rows}
          />
          <Pagination
            onPage={(page) => setState({ page })}
            page={state.page}
            total={total}
            totalPages={inspections.data?.totalPages ?? 1}
          />
        </>
      )}

      {openId ? <WorkOrderDialog inspectionId={openId} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}
