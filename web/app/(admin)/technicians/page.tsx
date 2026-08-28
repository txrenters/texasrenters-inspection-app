'use client';

import { UsersRoundIcon } from 'lucide-react';
import { useState } from 'react';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { ListToolbar, SelectFilter } from '@/components/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { Stat, StatGroup } from '@/components/stat-card';
import { EmptyState, ErrorState } from '@/components/states';
import { PresenceIndicator } from '@/components/presence-indicator';
import { StatusBadge } from '@/components/status-badge';
import { TechnicianCreateDialog } from '@/components/technician-create-dialog';
import { Button } from '@/components/ui/button';
import { usePermissions } from '@/lib/auth';
import { useTechnicians } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useUrlState } from '@/lib/url-state';

type TechnicianRow = NonNullable<ReturnType<typeof useTechnicians>['data']>['items'][number];

const STATUS_OPTIONS = [
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Inactive' },
];

const COLUMNS: Array<Column<TechnicianRow>> = [
  { key: 'name', header: 'Technician', primary: true, cell: (row) => row.displayName },
  {
    key: 'email',
    header: 'Email',
    hideBelow: 'md',
    cell: (row) => <span className="text-muted-foreground">{row.email}</span>,
  },
  { key: 'current', header: 'Current', numeric: true, cell: (row) => row.workload?.current ?? 0 },
  {
    key: 'inProgress',
    header: 'In progress',
    numeric: true,
    hideBelow: 'sm',
    cell: (row) => row.workload?.inProgress ?? 0,
  },
  {
    key: 'completed',
    header: 'Completed',
    numeric: true,
    hideBelow: 'sm',
    cell: (row) => row.workload?.completed ?? 0,
  },
  {
    key: 'presence',
    header: 'App',
    cell: (row) => <PresenceIndicator isOnline={row.isOnline} lastSeenAt={row.lastSeenAt} />,
  },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => <StatusBadge value={row.isActive ? 'ACTIVE' : 'INACTIVE'} />,
  },
];

export default function TechniciansPage() {
  const canProvision = usePermissions().has('technicians:provision');
  const [creating, setCreating] = useState(false);
  const [state, setState, reset] = useUrlState({ page: 1, q: '', active: '' });

  const debouncedSearch = useDebouncedValue(state.q);
  const isSearchPending = state.q.trim() !== debouncedSearch.trim();

  const technicians = useTechnicians({
    page: state.page,
    pageSize: 20,
    search: debouncedSearch,
    active: state.active || undefined,
  });

  const busy = technicians.isLoading || isSearchPending || technicians.isPlaceholderData;
  const hasActiveFilters = Boolean(state.q.trim() || state.active);
  const resultLabel = busy
    ? 'Searching technician accounts…'
    : `${(technicians.data?.total ?? 0).toLocaleString()} technician accounts`;

  const workload = technicians.data?.items.reduce(
    (summary, technician) => ({
      current: summary.current + (technician.workload?.current ?? 0),
      inProgress: summary.inProgress + (technician.workload?.inProgress ?? 0),
      completed: summary.completed + (technician.workload?.completed ?? 0),
    }),
    { current: 0, inProgress: 0, completed: 0 },
  );

  return (
    <>
      <PageHeader
        actions={
          canProvision ? (
            <Button onClick={() => setCreating(true)}>Create technician</Button>
          ) : undefined
        }
        description="Provision mobile accounts and manage assigned inspection workloads."
        title="Technicians"
      />

      {creating ? <TechnicianCreateDialog onClose={() => setCreating(false)} /> : null}

      {workload && !busy ? (
        <StatGroup
          aria-label="Visible technician workload"
          className="mb-4"
          columns="grid-cols-1 sm:grid-cols-3"
        >
          <Stat
            detail="Across the accounts on this page"
            label="Current assignments"
            value={workload.current}
          />
          <Stat detail="Active in the field" label="In progress" value={workload.inProgress} />
          <Stat detail="Finished inspections" label="Completed" value={workload.completed} />
        </StatGroup>
      ) : null}

      <ListToolbar
        activeFilters={
          state.active
            ? [
                {
                  label: 'Status',
                  value: state.active === 'true' ? 'Active' : 'Inactive',
                  onRemove: () => setState({ active: '', page: 1 }),
                },
              ]
            : []
        }
        filters={
          <SelectFilter
            allLabel="All accounts"
            label="Account status"
            onChange={(active) => setState({ active, page: 1 })}
            options={STATUS_OPTIONS}
            value={state.active}
          />
        }
        onClear={reset}
        onSearch={(q) => setState({ q, page: 1 })}
        pending={isSearchPending}
        resultLabel={resultLabel}
        search={state.q}
        searchLabel="Search technician name or email"
        searchPlaceholder="Search technicians…"
      />

      {busy ? (
        <DataTableSkeleton columns={COLUMNS} label="Loading technicians" rows={8} />
      ) : technicians.isError ? (
        <ErrorState error={technicians.error} retry={() => void technicians.refetch()} />
      ) : !technicians.data?.items.length ? (
        <EmptyState
          description={
            hasActiveFilters
              ? 'Adjust the search or account status filter to see matching technicians.'
              : 'Create a technician account to prepare mobile access. New accounts have no inspections until an administrator assigns one.'
          }
          icon={UsersRoundIcon}
          title="No technicians found"
        >
          {hasActiveFilters ? (
            <Button onClick={reset} variant="outline">
              Clear filters
            </Button>
          ) : canProvision ? (
            <Button onClick={() => setCreating(true)}>Create technician</Button>
          ) : null}
        </EmptyState>
      ) : (
        <>
          <DataTable
            columns={COLUMNS}
            label="Technician accounts and workloads"
            rowHref={(row) => `/technicians/${row.id}`}
            rowKey={(row) => row.id}
            rows={technicians.data.items}
          />
          <Pagination
            onPage={(page) => setState({ page })}
            page={state.page}
            total={technicians.data.total}
            totalPages={technicians.data.totalPages}
          />
        </>
      )}
    </>
  );
}
