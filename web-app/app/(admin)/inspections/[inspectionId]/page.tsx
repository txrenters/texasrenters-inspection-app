'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { buttonVariants } from '@/components/ui/button';

import { AssignmentDialog } from '@/components/assignment-dialog';
import {
  InspectionCancelDialog,
  InspectionEditDialog,
  InspectionUnassignDialog,
} from '@/components/inspection-actions-dialogs';
import { InspectionCompleteDialog } from '@/components/inspection-review';
import { AreaEvidenceWorkspace } from '@/components/area-evidence/AreaEvidenceWorkspace';
import { InspectionChargesPanel } from '@/components/inspection-charges';
import { InspectionComparisonPanel } from '@/components/inspection-comparison';
import {
  InspectionAreasPanel,
  InspectionWorkflowPanel,
} from '@/components/inspection-workflow';
import { ReportShareDialog } from '@/components/report-share-dialog';
import {
  Badge,
  DataTable,
  ErrorState,
  LoadingState,
  Pagination,
  PageHeader,
  TableLoadingState,
  formatDate,
} from '@/components/shared';
import {
  useAssignments,
  useInspection,
  useInspectionAudit,
  useInspectionFindings,
} from '@/lib/queries';
import { usePermissions } from '@/lib/auth';

export default function InspectionDetailPage() {
  const id = useParams<{ inspectionId: string }>().inspectionId;
  const permissions = usePermissions();
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
  const [completing, setCompleting] = useState(false);
  const [sharing, setSharing] = useState(false);
  // Room condition summaries are informational and never gate completion.
  const pendingFindings = useInspectionFindings(
    id,
    1,
    'PENDING_REVIEW',
    'DEFECTS',
    permissions.has('findings:read'),
  );

  if (inspection.isLoading) return <LoadingState label="Loading inspection…" />;
  if (inspection.isError)
    return <ErrorState error={inspection.error} retry={() => void inspection.refetch()} />;

  const item = inspection.data!;
  const current = item.assignments.find((assignment) => assignment.isCurrent);
  const finalized = item.status === 'COMPLETED' || item.status === 'CANCELLED';
  const baselineLabel =
    item.inspectionType === 'MOVE_IN'
      ? 'This inspection establishes the property baseline'
      : item.baselineInspection
        ? `Move-in inspection · ${formatDate(item.baselineInspection.scheduledAt)}`
        : 'No move-in baseline is linked';

  return (
    <>
      <PageHeader
        title={item.propertywareBuilding?.name ?? 'Inspection'}
        description={`${item.propertywareUnit?.name ?? 'Entire property'} · ${formatDate(item.scheduledAt)}`}
        breadcrumbs={[{ label: 'Inspections', href: '/inspections' }, { label: 'Detail' }]}
        action={
          <div className="inspection-action-bar">
            {!finalized && permissions.has('inspections:assign') ? (
              <button className={buttonVariants({ variant: 'secondary' })} onClick={() => setAssigning(true)}>
                {current ? 'Reassign' : 'Assign technician'}
              </button>
            ) : null}
            {permissions.has('reports:share') ? (
              <button className={buttonVariants({ variant: 'secondary' })} onClick={() => setSharing(true)}>
                Share report
              </button>
            ) : null}
            {!finalized &&
            (permissions.has('inspections:manage') ||
              (current && permissions.has('inspections:assign'))) ? (
              <details className="inspection-action-menu">
                <summary className={buttonVariants({ variant: 'secondary' })}>More actions</summary>
                <div className="inspection-action-menu-content">
                  {permissions.has('inspections:manage') ? (
                    <button type="button" onClick={() => setEditing(true)}>
                      <strong>Edit details</strong>
                      <span>Update schedule, priority, or notes</span>
                    </button>
                  ) : null}
                  {current && permissions.has('inspections:assign') ? (
                    <button type="button" onClick={() => setUnassigning(true)}>
                      <strong>Unassign technician</strong>
                      <span>Return this inspection to the assignment queue</span>
                    </button>
                  ) : null}
                  {permissions.has('inspections:manage') ? (
                    <button
                      className="menu-danger"
                      type="button"
                      onClick={() => setCancelling(true)}
                    >
                      <strong>Cancel inspection</strong>
                      <span>Close the inspection without completion</span>
                    </button>
                  ) : null}
                </div>
              </details>
            ) : null}
          </div>
        }
      />

      <section className="panel inspection-overview" aria-labelledby="inspection-overview-title">
        <div className="inspection-status-row">
          <div>
            <span className="section-kicker">Current state</span>
            <h2 id="inspection-overview-title">Inspection overview</h2>
          </div>
          <div className="inspection-status-badges">
            <Badge value={item.status} />
            <Badge value={item.inspectionType} />
            <Badge value={item.priority} />
          </div>
        </div>

        <dl className="inspection-facts">
          <div className="inspection-fact inspection-fact-primary">
            <dt>Assigned technician</dt>
            <dd>{current?.technician?.displayName ?? 'Not assigned'}</dd>
            <small>
              {current
                ? 'Currently responsible for this inspection'
                : 'Requires assignment before field work'}
            </small>
          </div>
          <div className="inspection-fact">
            <dt>Scheduled</dt>
            <dd>{formatDate(item.scheduledAt)}</dd>
            <small>Created {formatDate(item.createdAt)}</small>
          </div>
          <div className="inspection-fact">
            <dt>Property scope</dt>
            <dd>{item.propertywareUnit?.name ?? 'Entire property'}</dd>
            <small>{item.propertywareLease?.leaseName ?? 'No lease selected'}</small>
          </div>
          <div className="inspection-fact inspection-fact-wide">
            <dt>Comparison baseline</dt>
            <dd>{baselineLabel}</dd>
            <small>Used to identify condition changes across the property lifecycle</small>
          </div>
        </dl>

        {(pendingFindings.data?.total ?? 0) > 0 ? (
          <div className="inspection-attention" role="status">
            <span aria-hidden>!</span>
            <div>
              <strong>Human review required</strong>
              <p>
                {pendingFindings.data?.total} AI finding
                {pendingFindings.data?.total === 1 ? '' : 's'} must be reviewed before completion.
              </p>
            </div>
          </div>
        ) : null}

        {item.internalNotes ? (
          <div className="inspection-notes">
            <span>Internal notes</span>
            <p>{item.internalNotes}</p>
          </div>
        ) : null}
      </section>

      <InspectionWorkflowPanel inspection={item} onFinalize={() => setCompleting(true)} />

      {/* Area-first: recordings, photos, condition summaries and findings are
          read through the area they belong to rather than through four
          page-wide, media-type-first sections. */}
      <AreaEvidenceWorkspace inspectionId={id} />
      {item.inspectionType === 'MOVE_OUT' ? (
        <InspectionComparisonPanel inspectionId={id} />
      ) : null}
      {item.inspectionType === 'OCCUPIED' || item.inspectionType === 'MOVE_OUT' ? (
        <InspectionChargesPanel inspectionId={id} inspectionType={item.inspectionType} />
      ) : null}
      <InspectionAreasPanel inspectionId={id} />

      <div className="inspection-history-layout section-gap">
        <section className="panel inspection-history-panel">
          <div className="panel-header">
            <div>
              <span className="section-kicker">Workforce</span>
              <h2>Assignment history</h2>
              <p className="panel-description">Current and previous technician ownership.</p>
            </div>
          </div>
          {assignments.isLoading ? (
            <TableLoadingState
              headers={['Technician', 'Assigned by', 'Assigned', 'Ended', 'Status', 'Reason']}
              rows={3}
              label="Loading assignment history"
            />
          ) : assignments.isError ? (
            <ErrorState error={assignments.error} retry={() => void assignments.refetch()} />
          ) : assignments.data?.items.length ? (
            <>
              <DataTable
                headers={['Technician', 'Assigned by', 'Assigned', 'Ended', 'Status', 'Reason']}
                label="Inspection assignment history"
              >
                {assignments.data.items.map((assignment) => (
                  <tr key={assignment.id}>
                    <td>
                      <strong>
                        {assignment.technician?.displayName ?? assignment.technicianId}
                      </strong>
                    </td>
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
            <div className="compact-empty-state">No assignment history has been recorded.</div>
          )}
        </section>

        <section className="panel inspection-audit-panel">
          <div className="panel-header">
            <div>
              <span className="section-kicker">Audit trail</span>
              <h2>Recent activity</h2>
              <p className="panel-description">Immutable operational events for this inspection.</p>
            </div>
          </div>
          {audit.isLoading ? (
            <LoadingState label="Loading audit activity…" />
          ) : audit.isError ? (
            <ErrorState error={audit.error} retry={() => void audit.refetch()} />
          ) : audit.data?.items.length ? (
            <>
              <ul className="timeline inspection-timeline">
                {audit.data.items.map((event) => (
                  <li key={event.id}>
                    <strong>{event.action.replaceAll('_', ' ')}</strong>
                    <span>{formatDate(event.createdAt)}</span>
                  </li>
                ))}
              </ul>
              <Pagination
                page={auditPage}
                totalPages={audit.data.totalPages}
                onPage={setAuditPage}
              />
            </>
          ) : (
            <div className="compact-empty-state">No audit activity has been recorded.</div>
          )}
        </section>
      </div>

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
      {completing ? (
        <InspectionCompleteDialog
          inspectionId={id}
          pendingFindings={pendingFindings.data?.total ?? 0}
          onClose={() => setCompleting(false)}
        />
      ) : null}
      {sharing ? <ReportShareDialog inspectionId={id} onClose={() => setSharing(false)} /> : null}
    </>
  );
}
