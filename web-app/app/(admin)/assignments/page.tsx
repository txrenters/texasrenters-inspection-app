'use client';

import { ClipboardList, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TableCell, TableRow } from '@/components/ui/table';
import { Field, FieldLabel } from '@/components/ui/field';
import { buttonVariants } from '@/components/ui/button';

import { AssignmentCreateDialog } from '@/components/assignment-create-dialog';
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  FilterToolbar,
  PageHeader,
  Pagination,
  RowAction,
  RowActions,
  TableLoadingState,
  formatDate,
} from '@/components/shared';
import { usePermissions } from '@/lib/auth';
import { useAssignments, useTechnicians } from '@/lib/queries';

const ASSIGNMENT_HEADERS = [
  'Property',
  'Unit',
  'Technician',
  'Assigned by',
  'Assigned',
  'Ended',
  'Status',
  '',
];

// Radix Select rejects an empty string as an item value, so the unfiltered
// row carries a sentinel that is translated back to '' for the query.
const ALL = '__all__';

export default function AssignmentsPage() {
  const canAssign = usePermissions().has('inspections:assign');
  const [page, setPage] = useState(1);
  const [technicianId, setTechnicianId] = useState('');
  const [assignmentStatus, setAssignmentStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const hasActiveFilters = Boolean(technicianId || assignmentStatus);
  const assignments = useAssignments({ page, pageSize: 20, technicianId, assignmentStatus });
  const technicians = useTechnicians({ page: 1, pageSize: 100 });
  const isFilterPending = assignments.isPlaceholderData;
  const resultLabel =
    isFilterPending || assignments.isFetching
      ? 'Filtering assignment history...'
      : assignments.isLoading
        ? 'Loading assignment history...'
        : `${(assignments.data?.total ?? 0).toLocaleString()} assignment records`;

  return (
    <>
      <PageHeader
        title="Assignments"
        description="Current and historical technician assignments. Reassignment never overwrites prior records."
        action={
          canAssign ? (
            <button className={buttonVariants({ variant: 'primary' })} onClick={() => setCreating(true)}>
              Create assignment
            </button>
          ) : undefined
        }
      />
      <FilterToolbar
        resultLabel={resultLabel}
        onClear={
          hasActiveFilters
            ? () => {
                setTechnicianId('');
                setAssignmentStatus('');
                setPage(1);
              }
            : undefined
        }
      >
        <Field className="w-[min(280px,100%)]">
          <FieldLabel htmlFor="assignment-technician">Technician</FieldLabel>
          <Select
            disabled={assignmentStatus === 'UNASSIGNED'}
            onValueChange={(next) => {
              setTechnicianId(next === ALL ? '' : next);
              setPage(1);
            }}
            value={technicianId || ALL}
          >
            <SelectTrigger id="assignment-technician">
              <SelectValue placeholder="All technicians" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All technicians</SelectItem>
              {technicians.data?.items.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field className="w-[min(280px,100%)]">
          <FieldLabel htmlFor="assignment-status">Assignment status</FieldLabel>
          <Select
            onValueChange={(next) => {
              const status = next === ALL ? '' : next;
              setAssignmentStatus(status);
              // Unassigned rows have no technician, so the technician filter is
              // cleared rather than left stale behind a disabled control.
              if (status === 'UNASSIGNED') setTechnicianId('');
              setPage(1);
            }}
            value={assignmentStatus || ALL}
          >
            <SelectTrigger id="assignment-status">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {['ASSIGNED', 'REASSIGNED', 'UNASSIGNED'].map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </FilterToolbar>
      {assignments.isLoading || isFilterPending ? (
        <TableLoadingState
          headers={ASSIGNMENT_HEADERS}
          label={isFilterPending ? 'Filtering assignments' : 'Loading assignments'}
          rows={4}
        />
      ) : assignments.isError ? (
        <ErrorState error={assignments.error} retry={() => void assignments.refetch()} />
      ) : !assignments.data?.items.length ? (
        <EmptyState
          title={
            assignmentStatus === 'UNASSIGNED' ? 'No unassigned inspections' : 'No assignments found'
          }
          description={
            assignmentStatus === 'UNASSIGNED'
              ? 'Every inspection currently has a technician assignment.'
              : hasActiveFilters
                ? 'Adjust the filters to see matching assignment history.'
                : 'Assignment history will appear after an inspection is assigned.'
          }
          action={
            <button className={buttonVariants({ variant: 'primary' })} onClick={() => setCreating(true)}>
              Create assignment
            </button>
          }
        />
      ) : (
        <>
          <DataTable headers={ASSIGNMENT_HEADERS} label="Technician assignment history">
            {assignments.data.items.map((assignment) => (
              <TableRow key={assignment.id}>
                <TableCell>
                  {/* The property names the row, the way it does on every other
                      list. It used to sit beside a first column whose entire
                      content was an "Open inspection" link — the actions column
                      carries that now, so the column went with it. */}
                  <Link className="font-semibold text-primary" href={`/inspections/${assignment.inspectionId}`}>
                    {assignment.inspection?.propertywareBuilding?.name ?? 'Property unavailable'}
                  </Link>
                </TableCell>
                <TableCell>{assignment.inspection?.propertywareUnit?.name ?? 'Entire property'}</TableCell>
                <TableCell>
                  {assignment.technician?.displayName ?? assignment.technicianId ?? 'Unassigned'}
                </TableCell>
                <TableCell>{assignment.assignedBy?.displayName ?? assignment.assignedById ?? '-'}</TableCell>
                <TableCell>{assignment.assignedAt ? formatDate(assignment.assignedAt) : '-'}</TableCell>
                <TableCell>{assignment.endedAt ? formatDate(assignment.endedAt) : '-'}</TableCell>
                <TableCell>
                  <Badge
                    value={
                      assignment.recordType === 'UNASSIGNED_INSPECTION'
                        ? 'UNASSIGNED'
                        : assignment.isCurrent
                          ? 'CURRENT'
                          : assignment.status
                    }
                  />
                </TableCell>
                <TableCell>
                  {/* Both ends of the assignment are reachable from the row.
                      This table is the one place the two are shown together, so
                      following either without going back to a list is the whole
                      point of it. */}
                  <RowActions>
                    <RowAction
                      href={`/inspections/${assignment.inspectionId}`}
                      icon={<ClipboardList aria-hidden className="size-4" />}
                      label="Inspection"
                    />
                    {assignment.technician ? (
                      <RowAction
                        href={`/technicians/${assignment.technician.id}`}
                        icon={<UserRound aria-hidden className="size-4" />}
                        label="Technician"
                      />
                    ) : null}
                  </RowActions>
                </TableCell>
              </TableRow>
            ))}
          </DataTable>
          <Pagination page={page} totalPages={assignments.data.totalPages} onPage={setPage} />
        </>
      )}
      {creating ? <AssignmentCreateDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
