'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

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
import { useAdminMutations, useAssignments, useTechnician } from '@/lib/queries';

export default function TechnicianDetailPage() {
  const id = useParams<{ technicianId: string }>().technicianId;
  const [assignmentPage, setAssignmentPage] = useState(1);
  const technician = useTechnician(id);
  const assignments = useAssignments({ technicianId: id, page: assignmentPage, pageSize: 20 });
  const mutation = useAdminMutations().updateTechnician;
  if (technician.isLoading) return <LoadingState label="Loading technician…" />;
  if (technician.isError)
    return <ErrorState error={technician.error} retry={() => void technician.refetch()} />;
  const item = technician.data!;
  async function toggle() {
    const verb = item.isActive ? 'deactivate' : 'activate';
    if (!window.confirm(`Are you sure you want to ${verb} ${item.displayName}?`)) return;
    await mutation.mutateAsync({ id, isActive: !item.isActive });
  }
  return (
    <>
      <PageHeader
        title={item.displayName}
        description={item.email}
        breadcrumbs={[{ label: 'Technicians', href: '/technicians' }, { label: item.displayName }]}
        action={
          <button
            className={`button ${item.isActive ? 'button-danger' : 'button-primary'}`}
            onClick={() => void toggle()}
            disabled={mutation.isPending}
          >
            {item.isActive ? 'Deactivate' : 'Activate'}
          </button>
        }
      />
      {mutation.error ? (
        <div className="alert alert-danger" role="alert">
          {mutation.error.message}
        </div>
      ) : null}
      <section className="panel">
        <div className="detail-grid">
          <div className="detail-item">
            <span>Status</span>
            <Badge value={item.isActive ? 'ACTIVE' : 'INACTIVE'} />
          </div>
          <div className="detail-item">
            <span>Current assignments</span>
            <strong>{item.workload?.current ?? 0}</strong>
          </div>
          <div className="detail-item">
            <span>Account created</span>
            <strong>{formatDate(item.createdAt)}</strong>
          </div>
        </div>
      </section>
      <section className="panel section-gap">
        <div className="panel-header">
          <h2>Assignment history</h2>
        </div>
        {assignments.isLoading ? (
          <TableLoadingState
            headers={['Inspection', 'Assigned', 'Ended', 'Status', 'Reason']}
            rows={5}
            label="Loading assignment history"
          />
        ) : assignments.isError ? (
          <ErrorState error={assignments.error} retry={() => void assignments.refetch()} />
        ) : assignments.data?.items.length ? (
          <>
            <DataTable headers={['Inspection', 'Assigned', 'Ended', 'Status', 'Reason']}>
              {assignments.data.items.map((assignment) => (
                <tr key={assignment.id}>
                  <td>
                    <Link className="table-link" href={`/inspections/${assignment.inspectionId}`}>
                      {assignment.inspection?.propertywareBuilding?.name ?? 'Open inspection'}
                    </Link>
                  </td>
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
    </>
  );
}
