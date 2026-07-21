'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';

import { AssignmentDialog } from '@/components/assignment-dialog';
import {
  InspectionCancelDialog,
  InspectionEditDialog,
  InspectionUnassignDialog,
} from '@/components/inspection-actions-dialogs';
import {
  Badge,
  DataTable,
  ErrorState,
  LoadingState,
  Pagination,
  PageHeader,
  TableLoadingState,
  formatDate,
} from '@/components/ui';
import { useAssignments, useInspection, useInspectionAudit } from '@/lib/queries';

export default function InspectionDetailPage() {
  const id = useParams<{ inspectionId: string }>().inspectionId;
  const inspection = useInspection(id);
  const [assignmentPage, setAssignmentPage] = useState(1);
  const [auditPage, setAuditPage] = useState(1);
  const assignments = useAssignments({
    inspectionId: id,
    includeUnassigned: false,
    page: assignmentPage,
    pageSize: 20,
  });
  const audit = useInspectionAudit(id, auditPage);
  const [assigning, setAssigning] = useState(false);
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [unassigning, setUnassigning] = useState(false);
  if (inspection.isLoading) return <LoadingState label="Loading inspection…" />;
  if (inspection.isError)
    return <ErrorState error={inspection.error} retry={() => void inspection.refetch()} />;
  const item = inspection.data!;
  const current = item.assignments.find((assignment) => assignment.isCurrent);
  const finalized = item.status === 'COMPLETED' || item.status === 'CANCELLED';

  return (
    <>
      <PageHeader
        title={item.propertywareBuilding?.name ?? 'Inspection'}
        description={`${item.propertywareUnit?.name ?? 'Entire property'} · ${formatDate(item.scheduledAt)}`}
        breadcrumbs={[{ label: 'Inspections', href: '/inspections' }, { label: 'Detail' }]}
        action={
          <div className="action-row">
            {!finalized ? (
              <button className="button button-secondary" onClick={() => setEditing(true)}>
                Edit
              </button>
            ) : null}
            {!finalized ? (
              <button className="button button-primary" onClick={() => setAssigning(true)}>
                {current ? 'Reassign' : 'Assign technician'}
              </button>
            ) : null}
            {!finalized && current ? (
              <button className="button button-secondary" onClick={() => setUnassigning(true)}>
                Unassign
              </button>
            ) : null}
            {!finalized ? (
              <button className="button button-secondary" onClick={() => setCancelling(true)}>
                Cancel inspection
              </button>
            ) : null}
          </div>
        }
      />
      <section className="panel">
        <div className="detail-grid">
          <div className="detail-item">
            <span>Inspection type</span>
            <Badge value={item.inspectionType} />
          </div>
          <div className="detail-item">
            <span>Status</span>
            <Badge value={item.status} />
          </div>
          <div className="detail-item">
            <span>Priority</span>
            <Badge value={item.priority} />
          </div>
          <div className="detail-item">
            <span>Assignment</span>
            <Badge value={current ? 'ASSIGNED' : 'UNASSIGNED'} />
          </div>
          <div className="detail-item">
            <span>Technician</span>
            <strong>{current?.technician?.displayName ?? 'Not assigned'}</strong>
          </div>
          <div className="detail-item">
            <span>Lease</span>
            <strong>{item.propertywareLease?.leaseName ?? 'No lease selected'}</strong>
          </div>
          <div className="detail-item">
            <span>Created</span>
            <strong>{formatDate(item.createdAt)}</strong>
          </div>
          <div className="detail-item">
            <span>Comparison baseline</span>
            <strong>
              {item.inspectionType === 'MOVE_IN'
                ? 'This inspection establishes the baseline'
                : item.baselineInspection
                  ? `Move-in · ${formatDate(item.baselineInspection.scheduledAt)}`
                  : 'No baseline linked'}
            </strong>
          </div>
        </div>
        {item.internalNotes ? (
          <div className="note-box">
            <strong>Internal notes</strong>
            <p>{item.internalNotes}</p>
          </div>
        ) : null}
      </section>
      <section className="panel section-gap">
        <div className="panel-header">
          <h2>Assignment history</h2>
        </div>
        {assignments.isLoading ? (
          <TableLoadingState
            headers={['Technician', 'Assigned by', 'Assigned', 'Ended', 'Status', 'Reason']}
            rows={5}
            label="Loading assignment history"
          />
        ) : assignments.isError ? (
          <ErrorState error={assignments.error} retry={() => void assignments.refetch()} />
        ) : assignments.data?.items.length ? (
          <>
            <DataTable
              headers={['Technician', 'Assigned by', 'Assigned', 'Ended', 'Status', 'Reason']}
            >
              {assignments.data.items.map((assignment) => (
                <tr key={assignment.id}>
                  <td>{assignment.technician?.displayName ?? assignment.technicianId}</td>
                  <td>{assignment.assignedBy?.displayName ?? assignment.assignedById}</td>
                  <td>{formatDate(assignment.assignedAt)}</td>
                  <td>{formatDate(assignment.endedAt)}</td>
                  <td>
                    <Badge value={assignment.isCurrent ? 'CURRENT' : assignment.status} />
                  </td>
                  <td>{assignment.reason ?? '—'}</td>
                </tr>
              ))}
            </DataTable>
            <Pagination
              page={assignmentPage}
              totalPages={assignments.data.totalPages}
              onPage={setAssignmentPage}
            />
          </>
        ) : (
          <p>No assignment history.</p>
        )}
      </section>
      <section className="panel section-gap">
        <div className="panel-header">
          <h2>Audit activity</h2>
        </div>
        {audit.isLoading ? (
          <LoadingState label="Loading audit activityâ€¦" />
        ) : audit.isError ? (
          <ErrorState error={audit.error} retry={() => void audit.refetch()} />
        ) : audit.data?.items.length ? (
          <>
            <ul className="timeline">
              {audit.data.items.map((event) => (
                <li key={event.id}>
                  <strong>{event.action.replaceAll('_', ' ')}</strong>
                  <span>{formatDate(event.createdAt)}</span>
                </li>
              ))}
            </ul>
            <Pagination page={auditPage} totalPages={audit.data.totalPages} onPage={setAuditPage} />
          </>
        ) : (
          <p>No audit activity has been recorded.</p>
        )}
      </section>
      {assigning ? (
        <AssignmentDialog inspectionId={id} current={current} onClose={() => setAssigning(false)} />
      ) : null}
      {editing ? (
        <InspectionEditDialog inspection={item} onClose={() => setEditing(false)} />
      ) : null}
      {cancelling ? (
        <InspectionCancelDialog inspectionId={id} onClose={() => setCancelling(false)} />
      ) : null}
      {unassigning ? (
        <InspectionUnassignDialog inspectionId={id} onClose={() => setUnassigning(false)} />
      ) : null}
    </>
  );
}
