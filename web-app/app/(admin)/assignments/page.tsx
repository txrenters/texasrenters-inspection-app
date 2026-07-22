'use client';

import Link from 'next/link';
import { useState } from 'react';

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
} from '@/components/ui';
import { useAssignments, useTechnicians } from '@/lib/queries';

const ASSIGNMENT_HEADERS = [
  'Inspection',
  'Property / unit',
  'Technician',
  'Assigned by',
  'Assigned',
  'Ended',
  'Status',
];

export default function AssignmentsPage() {
  const [page, setPage] = useState(1);
  const [technicianId, setTechnicianId] = useState('');
  const [assignmentStatus, setAssignmentStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const assignments = useAssignments({ page, pageSize: 20, technicianId, assignmentStatus });
  const technicians = useTechnicians({ page: 1, pageSize: 100 });
  return (
    <>
      <PageHeader
        title="Assignments"
        description="Current and historical technician assignments. Reassignment never overwrites prior records."
        action={
          <button className="button button-primary" onClick={() => setCreating(true)}>
            Create assignment
          </button>
        }
      />
      <FilterToolbar
        resultLabel={
          assignments.isLoading
            ? 'Loading assignment history…'
            : `${(assignments.data?.total ?? 0).toLocaleString()} assignment records`
        }
        onClear={
          technicianId || assignmentStatus
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
      {assignments.isLoading ? (
        <TableLoadingState headers={ASSIGNMENT_HEADERS} label="Loading assignments" />
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
              : 'Assignment history will appear after an inspection is assigned.'
          }
          action={
            <button className="button button-primary" onClick={() => setCreating(true)}>
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
                  <small className="cell-note">
                    {assignment.inspection?.propertywareUnit?.name ?? 'Entire property'}
                  </small>
                </td>
                <td>
                  {assignment.technician?.displayName ?? assignment.technicianId ?? 'Unassigned'}
                </td>
                <td>{assignment.assignedBy?.displayName ?? assignment.assignedById ?? '—'}</td>
                <td>{assignment.assignedAt ? formatDate(assignment.assignedAt) : '—'}</td>
                <td>{assignment.endedAt ? formatDate(assignment.endedAt) : '—'}</td>
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
