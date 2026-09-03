'use client';

import {
  CheckIcon,
  CircleIcon,
  InfoIcon,
  MoreHorizontalIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { useParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { AreaEvidenceWorkspace } from '@/components/area-evidence/AreaEvidenceWorkspace';
import { ImportReportDialog } from '@/components/inspection-report-import';
import { AssignmentDialog } from '@/components/assignment-dialog';
import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { InspectionChargesPanel } from '@/components/inspection-charges';
import { InspectionCompleteDialog } from '@/components/inspection-complete-dialog';
import { InspectionDeleteDialog } from '@/components/inspection-delete-dialog';
import {
  InspectionCancelDialog,
  InspectionEditDialog,
  InspectionUnassignDialog,
} from '@/components/inspection-actions-dialogs';
import { InspectionTabs } from '@/components/inspection-tabs';
import { ReportClosingNotes } from '@/components/report-closing-notes';
import { InspectionWorkflowPanel } from '@/components/inspection-workflow';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { ReportShareDialog } from '@/components/report-share-dialog';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { usePermissions } from '@/lib/auth';
import { EMPTY, formatDateTime, formatScheduledDate, humanize } from '@/lib/format';
import { attentionBanner, inspectionProgress, primaryAction } from '@/lib/inspection-progress';
import {
  useAssignments,
  useInspection,
  useInspectionAreas,
  useInspectionAudit,
  useInspectionFindings,
} from '@/lib/queries';
import { useUrlState } from '@/lib/url-state';
import { cn } from '@/lib/utils';

/** Spoken state for a step that has no more specific detail. */
const STEP_STATE_LABEL = {
  complete: 'Complete',
  active: 'In progress',
  pending: 'Not started',
  blocked: 'Blocked',
} as const;

type AssignmentRow = NonNullable<ReturnType<typeof useAssignments>['data']>['items'][number];

const ASSIGNMENT_COLUMNS: Array<Column<AssignmentRow>> = [
  {
    key: 'technician',
    header: 'Technician',
    primary: true,
    cell: (row) => row.technician?.displayName ?? row.technicianId ?? EMPTY,
  },
  {
    key: 'assignedBy',
    header: 'Assigned by',
    hideBelow: 'md',
    cell: (row) => row.assignedBy?.displayName ?? row.assignedById ?? EMPTY,
  },
  { key: 'assigned', header: 'Assigned', cell: (row) => formatDateTime(row.assignedAt) },
  { key: 'ended', header: 'Ended', hideBelow: 'lg', cell: (row) => formatDateTime(row.endedAt) },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => <StatusBadge value={row.isCurrent ? 'CURRENT' : row.status} />,
  },
  {
    key: 'reason',
    header: 'Reason',
    hideBelow: 'xl',
    cell: (row) => <span className="text-muted-foreground">{row.reason ?? EMPTY}</span>,
  },
];

function InspectionDetail() {
  const id = useParams<{ inspectionId: string }>().inspectionId;
  const permissions = usePermissions();
  const inspection = useInspection(id);
  const [state, setState] = useUrlState({ assignmentPage: 1, auditPage: 1 });
  const assignments = useAssignments({
    inspectionId: id,
    includeUnassigned: false,
    // This panel is the assignment *history*, so it wants the superseded rows
    // the work lists deliberately hide — who held this inspection before, and
    // when it changed hands.
    includeSuperseded: true,
    page: state.assignmentPage,
    pageSize: 20,
  });
  const audit = useInspectionAudit(id, state.auditPage);
  /**
   * Whether this inspection has any evidence yet, for the import prompt.
   *
   * Up here with the other hooks, not beside the markup that reads it. Two
   * early returns sit below — an error state and a skeleton while the
   * inspection loads — so a hook after them runs on some renders and not
   * others, and React counts a different number each time. That is error #310,
   * and it took the whole page down rather than just the prompt.
   *
   * Shared with AreaEvidenceWorkspace through the same query key, so asking
   * here costs no extra request.
   */
  const areas = useInspectionAreas(id, permissions.has('inspections:read'));
  const [assigning, setAssigning] = useState(false);
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [unassigning, setUnassigning] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Room condition summaries are informational and never gate completion.
  const pendingFindings = useInspectionFindings(
    id,
    1,
    'PENDING_REVIEW',
    'DEFECTS',
    permissions.has('findings:read'),
  );

  if (inspection.isError)
    return <ErrorState error={inspection.error} retry={() => void inspection.refetch()} />;
  /**
   * `!inspection.data`, not `isLoading`.
   *
   * `isLoading` is only true on the *first* fetch, so it is false in every state
   * where the cache has been emptied under a mounted page — a delete removing
   * the query, a mutation patching it, an invalidation racing a navigation.
   * `inspection.data!` asserted those away and turned each one into a crash
   * rather than a frame of skeleton.
   */
  if (!inspection.data) return <PageSkeleton cards={3} />;

  const item = inspection.data;
  /**
   * Defensive `?? []`.
   *
   * A mutation response merged into this cache entry is a *projection* — the
   * unassign endpoint returns an assignment, not an inspection — and the
   * merge in `patchEntityInQueries` can leave a partially-shaped record in the
   * cache between the patch and the refetch that follows it. Reading `.find`
   * off that directly is what threw "Cannot read properties of undefined".
   */
  const current = (item.assignments ?? []).find((assignment) => assignment.isCurrent);
  const finalized = item.status === 'COMPLETED' || item.status === 'CANCELLED';
  const contextualAction = primaryAction(item.status);
  const banner = attentionBanner(item.status, pendingFindings.data?.total ?? 0);
  const baselineLabel =
    item.inspectionType === 'MOVE_IN'
      ? 'This inspection establishes the property baseline'
      : item.baselineInspection
        ? `Move-in inspection · ${formatScheduledDate(item.baselineInspection.scheduledAt)}`
        : 'No move-in baseline is linked';
  /**
   * Deletion is deliberately *not* gated on `finalized`, unlike everything else
   * in this menu. Editing a closed inspection would quietly alter a report that
   * may already have been shared; deleting it removes the report outright,
   * which is a different act — and the permission is the gate on it.
   */
  const canDelete = permissions.has('inspections:delete');
  const canEditOrAssign =
    !finalized &&
    (permissions.has('inspections:manage') || (current && permissions.has('inspections:assign')));
  const canUseMenu = canDelete || canEditOrAssign;

  return (
    <>
      <PageHeader
        actions={
          <>
            {/* One primary action, chosen by where the inspection actually is.
                The bar used to offer Reassign, Share report and More at equal
                weight whatever the state, so nothing indicated what to do next.
                This only ever navigates — finalization stays gated inside the
                workflow panel rather than gaining an ungated twin up here. */}
            {contextualAction ? (
              <Button
                onClick={() => {
                  const target = document.getElementById(contextualAction.target);
                  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  // Focus follows the scroll, so a keyboard user arrives where
                  // the page just moved rather than back at the top.
                  target?.focus?.();
                }}
                type="button"
              >
                {contextualAction.label}
              </Button>
            ) : null}
            {!finalized && permissions.has('inspections:assign') ? (
              <Button onClick={() => setAssigning(true)} variant="outline">
                {current ? 'Reassign' : 'Assign technician'}
              </Button>
            ) : null}
            {permissions.has('reports:share') ? (
              <Button onClick={() => setSharing(true)} variant="outline">
                Share report
              </Button>
            ) : null}
            {canUseMenu ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button aria-label="More actions" size="icon" variant="outline">
                    <MoreHorizontalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  {canEditOrAssign && permissions.has('inspections:manage') ? (
                    <DropdownMenuItem onSelect={() => setEditing(true)}>
                      Edit details
                    </DropdownMenuItem>
                  ) : null}
                  {canEditOrAssign && current && permissions.has('inspections:assign') ? (
                    <DropdownMenuItem onSelect={() => setUnassigning(true)}>
                      Unassign technician
                    </DropdownMenuItem>
                  ) : null}
                  {canEditOrAssign && permissions.has('inspections:manage') ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => setCancelling(true)} variant="destructive">
                        Cancel inspection
                      </DropdownMenuItem>
                    </>
                  ) : null}
                  {canDelete ? (
                    <>
                      {canEditOrAssign ? <DropdownMenuSeparator /> : null}
                      {/* Last, and separated: cancelling is the reversible way
                          to close an inspection, so it stays the neighbour a
                          misfire lands on rather than this. */}
                      <DropdownMenuItem onSelect={() => setDeleting(true)} variant="destructive">
                        Delete permanently…
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        }
        badges={
          <>
            <StatusBadge value={item.status} />
            <StatusBadge value={item.inspectionType} />
            <StatusBadge value={item.priority} />
          </>
        }
        description={`${item.propertywareUnit?.name ?? 'Entire property'} · ${formatScheduledDate(item.scheduledAt)}`}
        title={item.propertywareBuilding?.name ?? 'Inspection'}
      />

      <InspectionTabs active="overview" inspectionId={id} inspectionType={item.inspectionType} />

      {/* No "Inspection overview" heading any more. The card carried a title
          restating the page you are already on, and three status badges that
          have moved up beside the inspection's name where someone scanning back
          to the top actually looks for them. What is left is the two things the
          card is for: where the work has got to, and the facts about it. */}
      <section aria-label="Inspection status" className="mt-3 space-y-4">
        {/* The stepper is the instrument on this page: it answers "where has
              this got to" in four named stages, where the status badge alone
              said "In progress" for capture running, review not started and
              finalization unavailable alike. Each step carries its own label and
              a written state, never colour alone.

              One hairline panel rather than four floating boxes, matching
              StatGroup: four cells, whole rows at both breakpoints. */}
        <ol
          aria-label="Inspection workflow"
          className="bg-border grid grid-cols-2 gap-px overflow-hidden rounded-xl border lg:grid-cols-4"
        >
          {inspectionProgress(item.status).map((step) => (
            <li className="bg-card flex items-start gap-2 p-3" key={step.key}>
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border',
                  // `text-background`, never `text-white`. These fills invert
                  // between modes: in dark mode --success is a light green and
                  // white on it measures 1.95:1, so the tick simply vanished.
                  // The page background is by definition the most contrasting
                  // neutral available in whichever mode is active.
                  step.state === 'complete' && 'bg-success border-success text-background',
                  step.state === 'active' && 'border-primary text-primary',
                  step.state === 'blocked' && 'bg-destructive border-destructive text-background',
                  step.state === 'pending' && 'text-muted-foreground',
                )}
              >
                {step.state === 'complete' ? (
                  <CheckIcon className="size-3" />
                ) : step.state === 'blocked' ? (
                  <XIcon className="size-3" />
                ) : (
                  <CircleIcon className="size-2 fill-current" />
                )}
              </span>
              <span className="grid min-w-0 gap-0.5">
                <span className="text-sm font-medium">{step.label}</span>
                {/* The written state is what a screen reader announces, and
                      what makes the marker meaningful to everyone else. */}
                <span className="text-muted-foreground text-xs">
                  {step.detail || STEP_STATE_LABEL[step.state]}
                </span>
              </span>
            </li>
          ))}
        </ol>

        {/* Four facts, and deliberately not a second panel below the first.
              These are reference, not instrument: giving them the same bordered
              treatment as the stepper would make the page read as two equally
              important rows of boxes. Plain text on the canvas, with the labels
              carrying the only chrome they need. */}
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted-foreground text-xs">Assigned technician</dt>
            <dd className="mt-0.5 text-sm font-medium">
              {current?.technician?.displayName ?? 'Not assigned'}
            </dd>
            {current ? null : (
              <dd className="text-warning mt-0.5 text-xs">Required before field work can start</dd>
            )}
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Scheduled</dt>
            <dd className="mt-0.5 text-sm font-medium">{formatScheduledDate(item.scheduledAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Property scope</dt>
            <dd className="mt-0.5 text-sm font-medium">
              {item.propertywareUnit?.name ?? 'Entire property'}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Comparison baseline</dt>
            <dd className="mt-0.5 text-sm font-medium">{baselineLabel}</dd>
          </div>
        </dl>

        {banner ? (
          <Alert variant={banner.tone === 'warning' ? 'warning' : 'default'}>
            {banner.tone === 'warning' ? <TriangleAlertIcon /> : <InfoIcon />}
            <AlertTitle>{banner.title}</AlertTitle>
            <AlertDescription>{banner.body}</AlertDescription>
          </Alert>
        ) : null}

        {item.internalNotes ? (
          <div className="bg-muted rounded-lg p-3">
            <p className="text-muted-foreground text-xs">Internal notes</p>
            <p className="mt-1 text-sm whitespace-pre-wrap">{item.internalNotes}</p>
          </div>
        ) : null}
      </section>

      {/* Area-first: recordings, photos, condition summaries and findings are
          read through the area they belong to rather than through four
          page-wide, media-type-first sections.

          First thing after the summary. Reviewing evidence is what an
          administrator opens this page to do; finalization used to sit above it
          even while the technician was still capturing, which put an action
          nobody could take yet ahead of the work everybody came for. */}
      <div className="mt-4 space-y-4">
        {/* A move-in Jobber closed with nothing recorded against it: the walk
            happened in Inspect & Cloud, so the record arrived here complete and
            empty. Offered only while it is still empty, because importing into
            an inspection that already has evidence would overwrite somebody's
            walkthrough with a document -- the API refuses that too, and a
            button that only ever errors is worse than no button. */}
        {item.inspectionType === 'MOVE_IN' &&
        permissions.has('inspections:manage') &&
        areas.data?.length === 0 ? (
          <Alert>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>
                This move-in has no evidence recorded against it. Import the report if the
                walkthrough was done outside this app.
              </span>
              <ImportReportDialog inspectionId={id} />
            </AlertDescription>
          </Alert>
        ) : null}

        <AreaEvidenceWorkspace inspectionId={id} />

        {/* The comparison moved to its own page. It was rendered here, below
            the evidence workspace and above the charges, where nothing linked
            to it and a reviewer had to scroll past everything else to find a
            distinct piece of work. See the "Move-in comparison" tab. */}

        {item.inspectionType === 'OCCUPIED' || item.inspectionType === 'MOVE_OUT' ? (
          <InspectionChargesPanel inspectionId={id} inspectionType={item.inspectionType} />
        ) : null}

        {/* Before finalization, in the order the work happens: a reviewer
            writes what the report should say, then decides it is ready. */}
        <ReportClosingNotes inspection={item} readOnly={finalized} />

        {/* Finalization sits after the evidence, in the order the work happens:
            read the areas, then decide. */}
        <InspectionWorkflowPanel inspection={item} onFinalize={() => setCompleting(true)} />

        {/* Assignment history and activity are reference material, not the task.
            Collapsed by default so they stop competing with the review
            workspace for attention; `open` on a details element keeps them one
            click away and keyboard-reachable without any custom disclosure
            logic. */}
        <details className="group">
          <summary className="bg-card hover:bg-accent flex cursor-pointer items-center gap-2 rounded-xl border p-3 text-sm font-medium select-none">
            Additional information
            <span className="text-muted-foreground font-normal">
              Assignment history and activity
            </span>
          </summary>

          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Assignment history</CardTitle>
              </CardHeader>
              <CardContent>
                {assignments.isLoading ? (
                  <DataTableSkeleton
                    columns={ASSIGNMENT_COLUMNS}
                    label="Loading assignment history"
                    rows={3}
                  />
                ) : assignments.isError ? (
                  <ErrorState error={assignments.error} retry={() => void assignments.refetch()} />
                ) : assignments.data?.items.length ? (
                  <>
                    <DataTable
                      columns={ASSIGNMENT_COLUMNS}
                      label="Inspection assignment history"
                      rowKey={(row) => row.id}
                      rows={assignments.data.items}
                    />
                    <Pagination
                      onPage={(assignmentPage) => setState({ assignmentPage })}
                      page={state.assignmentPage}
                      total={assignments.data.total}
                      totalPages={assignments.data.totalPages}
                    />
                  </>
                ) : (
                  <EmptyState title="No assignment history has been recorded." />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recent activity</CardTitle>
              </CardHeader>
              <CardContent>
                {audit.isLoading ? (
                  <PageSkeleton cards={1} />
                ) : audit.isError ? (
                  <ErrorState error={audit.error} retry={() => void audit.refetch()} />
                ) : audit.data?.items.length ? (
                  <>
                    <ol className="divide-y">
                      {audit.data.items.map((event) => (
                        <li
                          className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                          key={event.id}
                        >
                          <span className="text-sm font-medium">{humanize(event.action)}</span>
                          <span className="text-muted-foreground shrink-0 text-xs">
                            {formatDateTime(event.createdAt)}
                          </span>
                        </li>
                      ))}
                    </ol>
                    <Pagination
                      onPage={(auditPage) => setState({ auditPage })}
                      page={state.auditPage}
                      total={audit.data.total}
                      totalPages={audit.data.totalPages}
                    />
                  </>
                ) : (
                  <EmptyState title="No audit activity has been recorded." />
                )}
              </CardContent>
            </Card>
          </div>
        </details>
      </div>

      {assigning ? (
        <AssignmentDialog current={current} inspectionId={id} onClose={() => setAssigning(false)} />
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
          onClose={() => setCompleting(false)}
          pendingFindings={pendingFindings.data?.total ?? 0}
        />
      ) : null}
      {sharing ? <ReportShareDialog inspectionId={id} onClose={() => setSharing(false)} /> : null}
      {deleting ? (
        <InspectionDeleteDialog
          inspection={{
            id: item.id,
            name: item.propertywareBuilding?.name ?? 'Inspection',
            unitName: item.propertywareUnit?.name,
            finalized: Boolean(item.finalizedAt),
          }}
          onClose={() => setDeleting(false)}
          // This page is about the record that just disappeared.
          redirectTo="/inspections"
        />
      ) : null}
    </>
  );
}

export default function InspectionDetailPage() {
  // `useUrlState` and the evidence workspace both read `useSearchParams`, which
  // needs a Suspense boundary or the whole segment opts out of prerendering.
  return (
    <Suspense fallback={<PageSkeleton cards={3} />}>
      <InspectionDetail />
    </Suspense>
  );
}
