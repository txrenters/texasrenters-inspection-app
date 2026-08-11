'use client';

import { UserRoundIcon, WorkflowIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { AssignmentCreateDialog } from '@/components/assignment-create-dialog';
import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { ListToolbar, SelectFilter, enumOptions } from '@/components/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { EmptyState, ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { EMPTY, formatDateTime, humanize } from '@/lib/format';
import { usePermissions } from '@/lib/auth';
import { useAssignments, useTechnicians } from '@/lib/queries';
import { useUrlState } from '@/lib/url-state';

type AssignmentRow = NonNullable<ReturnType<typeof useAssignments>['data']>['items'][number];

const ASSIGNMENT_STATUSES = ['ASSIGNED', 'REASSIGNED', 'UNASSIGNED'] as const;

const COLUMNS: Array<Column<AssignmentRow>> = [
  {
    key: 'property',
    header: 'Property',
    primary: true,
    cell: (row) => row.inspection?.propertywareBuilding?.name ?? 'Property unavailable',
  },
  {
    key: 'unit',
    header: 'Unit',
    hideBelow: 'lg',
    cell: (row) => row.inspection?.propertywareUnit?.name ?? 'Entire property',
  },
  {
    key: 'technician',
    header: 'Technician',
    cell: (row) => row.technician?.displayName ?? row.technicianId ?? 'Unassigned',
  },
  {
    key: 'assignedBy',
    header: 'Assigned by',
    hideBelow: 'xl',
    cell: (row) => row.assignedBy?.displayName ?? row.assignedById ?? EMPTY,
  },
  {
    key: 'assignedAt',
    header: 'Assigned',
    hideBelow: 'md',
    cell: (row) => formatDateTime(row.assignedAt),
  },
  { key: 'endedAt', header: 'Ended', hideBelow: 'xl', cell: (row) => formatDateTime(row.endedAt) },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => (
      <StatusBadge
        value={
          row.recordType === 'UNASSIGNED_INSPECTION'
            ? 'UNASSIGNED'
            : row.isCurrent
              ? 'CURRENT'
              : row.status
        }
      />
    ),
  },
];

export default function AssignmentsPage() {
  const canAssign = usePermissions().has('inspections:assign');
  const [creating, setCreating] = useState(false);
  const [state, setState, reset] = useUrlState({ page: 1, technician: '', status: '' });

  const assignments = useAssignments({
    page: state.page,
    pageSize: 20,
    technicianId: state.technician,
    assignmentStatus: state.status,
  });
  const technicians = useTechnicians({ page: 1, pageSize: 100 });

  const busy = assignments.isLoading || assignments.isPlaceholderData;
  const hasActiveFilters = Boolean(state.technician || state.status);
  const resultLabel = busy
    ? 'Filtering assignment history…'
    : `${(assignments.data?.total ?? 0).toLocaleString()} assignment records`;

  const technicianName = technicians.data?.items.find(
    (item) => item.id === state.technician,
  )?.displayName;

  const activeFilters = [
    technicianName
      ? {
          label: 'Technician',
          value: technicianName,
          onRemove: () => setState({ technician: '', page: 1 }),
        }
      : null,
    state.status
      ? {
          label: 'Status',
          value: humanize(state.status),
          onRemove: () => setState({ status: '', page: 1 }),
        }
      : null,
  ].filter((filter) => filter !== null);

  return (
    <>
      <PageHeader
        actions={
          canAssign ? <Button onClick={() => setCreating(true)}>Create assignment</Button> : undefined
        }
        description="Current and historical technician assignments. Reassignment never overwrites prior records."
        title="Assignments"
      />

      <ListToolbar
        activeFilters={activeFilters}
        filters={
          <>
            <SelectFilter
              allLabel="All technicians"
              className="w-[220px]"
              label="Technician"
              onChange={(technician) => setState({ technician, page: 1 })}
              options={(technicians.data?.items ?? []).map((item) => ({
                value: item.id,
                label: item.displayName,
              }))}
              value={state.technician}
            />
            <SelectFilter
              allLabel="All statuses"
              label="Assignment status"
              onChange={(status) =>
                // Unassigned rows have no technician, so the technician filter is
                // cleared rather than left stale behind a control that no longer
                // narrows anything.
                setState({
                  status,
                  page: 1,
                  ...(status === 'UNASSIGNED' ? { technician: '' } : {}),
                })
              }
              options={enumOptions(ASSIGNMENT_STATUSES)}
              value={state.status}
            />
          </>
        }
        onClear={reset}
        // Assignment history has no free-text search on the API, so the search
        // box is omitted rather than shown as a control that does nothing.
        onSearch={() => undefined}
        resultLabel={resultLabel}
        search=""
        searchLabel="Search assignments"
      />

      {busy ? (
        <DataTableSkeleton columns={COLUMNS} hasActions label="Loading assignments" rows={8} />
      ) : assignments.isError ? (
        <ErrorState error={assignments.error} retry={() => void assignments.refetch()} />
      ) : !assignments.data?.items.length ? (
        <EmptyState
          description={
            state.status === 'UNASSIGNED'
              ? 'Every inspection currently has a technician assignment.'
              : hasActiveFilters
                ? 'Adjust the filters to see matching assignment history.'
                : 'Assignment history will appear after an inspection is assigned.'
          }
          icon={WorkflowIcon}
          title={state.status === 'UNASSIGNED' ? 'No unassigned inspections' : 'No assignments found'}
        >
          {hasActiveFilters ? (
            <Button onClick={reset} variant="outline">
              Clear filters
            </Button>
          ) : canAssign ? (
            <Button onClick={() => setCreating(true)}>Create assignment</Button>
          ) : null}
        </EmptyState>
      ) : (
        <>
          <DataTable
            // The row opens the inspection; the technician is the other end of
            // the record, and this table is the one place both are shown
            // together, so it keeps its own control.
            actions={(row) =>
              row.technician ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button asChild size="icon-sm" variant="ghost">
                      <Link
                        aria-label={`Open technician ${row.technician.displayName}`}
                        href={`/technicians/${row.technician.id}`}
                      >
                        <UserRoundIcon />
                      </Link>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Open technician</TooltipContent>
                </Tooltip>
              ) : null
            }
            columns={COLUMNS}
            label="Technician assignment history"
            rowHref={(row) => `/inspections/${row.inspectionId}`}
            rowKey={(row) => row.id}
            rows={assignments.data.items}
          />
          <Pagination
            onPage={(page) => setState({ page })}
            page={state.page}
            total={assignments.data.total}
            totalPages={assignments.data.totalPages}
          />
        </>
      )}

      {creating ? <AssignmentCreateDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
