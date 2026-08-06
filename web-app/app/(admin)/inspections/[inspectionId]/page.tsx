'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { TableCell, TableRow } from '@/components/ui/table';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { InspectionWorkflowPanel } from '@/components/inspection-workflow';
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
import { inspectionProgress } from '@/lib/inspection-progress';

/** Spoken state for a step that has no more specific detail. */
const STEP_STATE_LABEL = {
  complete: 'Complete',
  active: 'In progress',
  pending: 'Not started',
  blocked: 'Blocked',
} as const;

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

      <Card className="overflow-visible p-0" asChild>
      <section aria-labelledby="inspection-overview-title">
        <div className="inspection-status-row">
          <div>
            <span className="block text-xs font-semibold text-muted-foreground">Current state</span>
            <h2 id="inspection-overview-title">Inspection overview</h2>
          </div>
          <div className="inspection-status-badges">
            <Badge value={item.status} />
            <Badge value={item.inspectionType} />
            <Badge value={item.priority} />
          </div>
        </div>

        {/* Where the inspection actually is, as four named stages.
            The status badge above says one thing — "In progress" — that stood
            equally for capture running, review not started and finalization
            unavailable, so it appeared in several places meaning something
            different each time. Each step carries its own label and a written
            state, never colour alone. */}
        <ol className="inspection-progress" aria-label="Inspection workflow">
          {inspectionProgress(item.status).map((step) => (
            <li className="inspection-progress-step" data-state={step.state} key={step.key}>
              <span aria-hidden className="inspection-progress-marker">
                {step.state === 'complete' ? '✓' : step.state === 'blocked' ? '×' : '●'}
              </span>
              <div>
                <strong>{step.label}</strong>
                {/* The written state is what a screen reader announces, and
                    what makes the marker meaningful to everyone else. */}
                <span>{step.detail || STEP_STATE_LABEL[step.state]}</span>
              </div>
            </li>
          ))}
        </ol>

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
      </Card>

      {/* Area-first: recordings, photos, condition summaries and findings are
          read through the area they belong to rather than through four
          page-wide, media-type-first sections.

          Now the first thing after the summary. Reviewing evidence is what an
          administrator opens this page to do; finalization used to sit above it
          even while the technician was still capturing, which put an action
          nobody could take yet ahead of the work everybody came for. */}
      <AreaEvidenceWorkspace inspectionId={id} />
      {item.inspectionType === 'MOVE_OUT' ? (
        <InspectionComparisonPanel inspectionId={id} />
      ) : null}
      {item.inspectionType === 'OCCUPIED' || item.inspectionType === 'MOVE_OUT' ? (
        <InspectionChargesPanel inspectionId={id} inspectionType={item.inspectionType} />
      ) : null}
      {/* Finalization sits after the evidence, in the order the work happens:
          read the areas, then decide. */}
      <InspectionWorkflowPanel inspection={item} onFinalize={() => setCompleting(true)} />

      {/* Assignment history and activity are reference material, not the task.
          Collapsed by default so they stop competing with the review workspace
          for attention; `open` on a details element keeps them one click away
          and keyboard-reachable without any custom disclosure logic. */}
      <details className="inspection-secondary section-gap">
        <summary className="cursor-pointer select-none text-[15px] font-semibold text-foreground">
          Additional information
          <span className="ml-2 text-[13px] font-normal text-muted-foreground">
            Assignment history and activity
          </span>
        </summary>

      <div className="inspection-history-layout section-gap">
        <Card className="p-[22px] max-[560px]:p-4 min-w-0" asChild>
        <section>
          <CardHeader className="p-0 pb-4">
            <div>
              <span className="block text-xs font-semibold text-muted-foreground">Workforce</span>
              <CardTitle className="text-[17px]">Assignment history</CardTitle>
              <CardDescription>Current and previous technician ownership.</CardDescription>
            </div>
          </CardHeader>
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
                  <TableRow key={assignment.id}>
                    <TableCell>
                      <strong>
                        {assignment.technician?.displayName ?? assignment.technicianId}
                      </strong>
                    </TableCell>
                    <TableCell>{assignment.assignedBy?.displayName ?? assignment.assignedById}</TableCell>
                    <TableCell>{formatDate(assignment.assignedAt)}</TableCell>
                    <TableCell>{formatDate(assignment.endedAt)}</TableCell>
                    <TableCell>
                      <Badge value={assignment.isCurrent ? 'CURRENT' : assignment.status} />
                    </TableCell>
                    <TableCell>{assignment.reason ?? '—'}</TableCell>
                  </TableRow>
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
        </Card>

        <Card className="p-[22px] max-[560px]:p-4 min-w-0" asChild>
        <section>
          <CardHeader className="p-0 pb-4">
            <div>
              <span className="block text-xs font-semibold text-muted-foreground">Audit trail</span>
              <CardTitle className="text-[17px]">Recent activity</CardTitle>
              <CardDescription>Immutable operational events for this inspection.</CardDescription>
            </div>
          </CardHeader>
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
        </Card>
      </div>
      </details>

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
