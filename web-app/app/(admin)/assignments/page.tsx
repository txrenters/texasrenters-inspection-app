'use client';

import Link from 'next/link';
import { useState } from 'react';
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
  TableLoadingState,
  formatDate,
} from '@/components/shared';
import { usePermissions } from '@/lib/auth';
import { useAssignments, useTechnicians } from '@/lib/queries';

const ASSIGNMENT_HEADERS = [
  'Inspection',
  'Property',
  'Unit',
  'Technician',
  'Assigned by',
  'Assigned',
  'Ended',
  'Status',
];

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
        <div className="field field-medium">
          <label htmlFor="assignment-technician">Technician</label>
          <select
            id="assignment-technician"
            value={technicianId}
            disabled={assignmentStatus === 'UNASSIGNED'}
            onChange={(event) => {
              setTechnicianId(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All technicians</option>
            {technicians.data?.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="field field-medium">
          <label htmlFor="assignment-status">Assignment status</label>
          <select
            id="assignment-status"
            value={assignmentStatus}
            onChange={(event) => {
              const status = event.target.value;
              setAssignmentStatus(status);
              if (status === 'UNASSIGNED') setTechnicianId('');
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {['ASSIGNED', 'REASSIGNED', 'UNASSIGNED'].map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </div>
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
              <tr key={assignment.id}>
                <td>
                  <Link className="table-link" href={`/inspections/${assignment.inspectionId}`}>
                    Open inspection
                  </Link>
                </td>
                <td>
                  {assignment.inspection?.propertywareBuilding?.name ?? 'Property unavailable'}
                </td>
                <td>{assignment.inspection?.propertywareUnit?.name ?? 'Entire property'}</td>
                <td>
                  {assignment.technician?.displayName ?? assignment.technicianId ?? 'Unassigned'}
                </td>
                <td>{assignment.assignedBy?.displayName ?? assignment.assignedById ?? '-'}</td>
                <td>{assignment.assignedAt ? formatDate(assignment.assignedAt) : '-'}</td>
                <td>{assignment.endedAt ? formatDate(assignment.endedAt) : '-'}</td>
                <td>
                  <Badge
                    value={
                      assignment.recordType === 'UNASSIGNED_INSPECTION'
                        ? 'UNASSIGNED'
                        : assignment.isCurrent
                          ? 'CURRENT'
                          : assignment.status
                    }
                  />
                </td>
              </tr>
            ))}
          </DataTable>
          <Pagination page={page} totalPages={assignments.data.totalPages} onPage={setPage} />
        </>
      )}
      {creating ? <AssignmentCreateDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
