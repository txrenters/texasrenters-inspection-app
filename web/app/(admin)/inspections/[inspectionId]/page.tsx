'use client';

import { isFinishedStatus } from '@texasrenters/shared';
import { ClipboardCheckIcon, MoreHorizontalIcon, TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Suspense, useState, type ReactNode } from 'react';

import { AreaEvidenceWorkspace } from '@/components/area-evidence/AreaEvidenceWorkspace';
import { AssignmentDialog } from '@/components/assignment-dialog';
import { useConsoleShell } from '@/components/console-shell-context';
import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { InspectionDeleteDialog } from '@/components/inspection-delete-dialog';
import {
  InspectionCancelDialog,
  InspectionEditDialog,
  InspectionUnassignDialog,
} from '@/components/inspection-actions-dialogs';
import { InspectionTabs } from '@/components/inspection-tabs';
import { MarkCompleteDialog } from '@/components/inspection-workflow';
import { JobHeadline } from '@/components/job-headline';
import { JobNotes } from '@/components/job-notes';
import { OpenReportButton } from '@/components/open-report-button';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { Panel } from '@/components/panel';
import { InvoicesCard } from '@/components/invoices/invoice-parts';
import { RecordLayout } from '@/components/record/record-kit';
import { ReportShareDialog } from '@/components/report-share-dialog';
import { Stat, StatGroup } from '@/components/stat-card';
import { ErrorState, PageSkeleton } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { VisitCard } from '@/components/visit-card';
import { usePermissions } from '@/lib/auth';
import { EMPTY, formatDateTime, formatScheduledDate, humanize } from '@/lib/format';
import { typeTitle, typeTone } from '@/lib/inspection-type-tone';
import { reviewComesFirst } from '@/lib/job-page';
import {
  useAreaEvidenceSummary,
  useAssignments,
  useInspection,
  useInspectionAudit,
  useInspectionFindings,
} from '@/lib/queries';
import { useUrlState } from '@/lib/url-state';

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
  const [assigning, setAssigning] = useState(false);
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [unassigning, setUnassigning] = useState(false);
  const [markingComplete, setMarkingComplete] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Jobber's record layout, in the Jobber-style shell only. */
  const jobber = useConsoleShell() === 'jobber';
  // Defects only: room condition summaries are context, never a decision.
  const pendingFindings = useInspectionFindings(
    id,
    1,
    'PENDING_REVIEW',
    'DEFECTS',
    permissions.has('findings:read'),
  );
  // The same read the Areas card makes, for the review summary's count.
  const areaSummary = useAreaEvidenceSummary(id);

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
  /**
   * The visit is over: submitted, or cancelled.
   *
   * Submitted is done (the office, 2026-10-05). Nobody finalizes: the
   * technician's submission ends the visit -- Jobber is told, their paid time
   * stops -- and what is left is the office's review of the findings, which this
   * page is for. So scheduling, assigning and editing the visit stop there, as
   * they used to stop only at a finalize that no longer comes. Reviewing does not.
   */
  const visitOver = isFinishedStatus(item.status) || item.status === 'CANCELLED';
  /**
   * The move-in a move-out is compared against, as the comparison and the AI
   * both choose it. The link written at creation is only the fallback for the
   * other types: on a move-out it said "No move-in baseline is linked" while
   * the comparison was reading a move-in all along (5819 Flower Gate Dr).
   */
  const baseline =
    item.inspectionType === 'MOVE_OUT' && item.comparisonBaseline !== undefined
      ? item.comparisonBaseline
      : item.baselineInspection;
  // Only the types compared against a move-in: a move-in is the record, and an
  // HVAC visit is not compared with anything.
  const comparesToMoveIn =
    item.inspectionType === 'MOVE_OUT' ||
    item.inspectionType === 'OCCUPIED' ||
    item.inspectionType === 'BACK_TO_MARKET';
  const pending = pendingFindings.data?.total ?? 0;
  const showsFindings = permissions.has('findings:read');
  // Whole rows only: a StatGroup draws its hairlines through the gaps, so a
  // column with no figure in it shows as a block of border colour.
  const figureColumns =
    REVIEW_COLUMNS[1 + (showsFindings ? 1 : 0) + (comparesToMoveIn ? 1 : 0)] ?? REVIEW_COLUMNS[1];
  /**
   * Deletion is deliberately *not* gated on the visit being over, unlike
   * everything else in this menu: deleting removes the record outright, which
   * is a different act -- and the permission is the gate on it.
   */
  const canDelete = permissions.has('inspections:delete');
  const canEditOrAssign =
    !visitOver &&
    (permissions.has('inspections:manage') || (current && permissions.has('inspections:assign')));
  // For a walkthrough done outside this app, with nothing here to submit; see
  // `MarkCompleteDialog`. Before a submission only, like the server's rule.
  const canMarkComplete =
    (item.status === 'SCHEDULED' || item.status === 'IN_PROGRESS') &&
    permissions.has('inspections:finalize');
  const canUseMenu = canDelete || canEditOrAssign || canMarkComplete;
  const canEditJob = !visitOver && permissions.has('inspections:manage');

  /** Nothing to review until it has been walked; see `reviewComesFirst`. */
  const reviewing = reviewComesFirst(item);
  const visit = (
      <VisitCard
        key="visit"
        action={
          canEditJob ? (
            <Button onClick={() => setEditing(true)} size="sm" variant="outline">
              Edit job
            </Button>
          ) : null
        }
        inspection={item}
        rescheduleHref={permissions.hasAny('inspections:manage', 'planning:publish') ? '/reschedules' : undefined}
        technicianName={current?.technician?.displayName ?? null}
      />
  );
  const notes = (
      <JobNotes key="notes" inspection={item} />
  );
  /*
   * Area-first: recordings, photos, condition summaries and findings are read
   * through the area they belong to rather than through four page-wide,
   * media-type-first sections.
   *
   * The comparison has its own page: the "Move-in comparison" tab. Three cards
   * used to follow the areas, and are gone (the office, 2026-10-05): "Charges &
   * pet review" (no charge had ever been recorded on any of 326 inspections with
   * evidence), "Report closing notes" (filled on 8 of 1,615, all HVAC, where the
   * technician writes them in the app) and "Finalization & follow-up" with its
   * sticky "Finalize inspection" bar -- the office does not finalize, and its
   * reopen and request-more-evidence both sent the job back to the technician,
   * marking the Jobber visit incomplete and restarting their paid time. Marking
   * a job done survives in the More menu.
   */
  const areas = (
    <div className="mt-4" key="areas">
      <AreaEvidenceWorkspace inspectionId={id} />
    </div>
  );

  return (
    <>
      <PageHeader
        actions={
          <>
            {/* The one thing to do next is the main button, as Jobber's "Show
                Late Visit": assigning while nobody is on a visit to come, sharing
                once it has been walked. Before that there is no report to share. */}
            {!visitOver && permissions.has('inspections:assign') ? (
              <Button onClick={() => setAssigning(true)} variant={current ? 'outline' : 'default'}>
                {current ? 'Reassign' : 'Assign technician'}
              </Button>
            ) : null}
            {reviewing ? <OpenReportButton inspectionId={id} /> : null}
            {reviewing && permissions.has('reports:share') ? (
              <Button onClick={() => setSharing(true)}>Share report</Button>
            ) : null}
            {canUseMenu ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button aria-label="More actions" size="icon" variant="outline">
                    <MoreHorizontalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  {canEditOrAssign && current && permissions.has('inspections:assign') ? (
                    <DropdownMenuItem onSelect={() => setUnassigning(true)}>
                      Unassign technician
                    </DropdownMenuItem>
                  ) : null}
                  {canMarkComplete ? (
                    <DropdownMenuItem onSelect={() => setMarkingComplete(true)}>
                      Mark done outside the app…
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
                      {canEditOrAssign || canMarkComplete ? <DropdownMenuSeparator /> : null}
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
            {/* Priority only when it is an exception, as on the list
                (console-development). What the job is reads under the address. */}
            {item.priority && item.priority !== 'STANDARD' ? <StatusBadge value={item.priority} /> : null}
          </>
        }
        description={<JobHeadline item={item} />}
        record={{
          icon: ClipboardCheckIcon,
          tone: typeTone(item.inspectionType).text,
          label: `${typeTitle(item.inspectionType)} inspection`,
        }}
        title={item.propertywareBuilding?.name ?? 'Inspection'}
        titleHref={item.propertywareBuilding ? `/properties/${item.propertywareBuilding.id}` : undefined}
      />

      <InspectionTabs active="overview" inspectionId={id} inspectionType={item.inspectionType} />

      {/*
        Where the review stands, in three figures -- what this page is for, once
        there is something to review.

        This was a four-step stepper (Capture, Technician submission, Admin
        review, Finalized), a strip of facts and a banner saying findings "must
        be reviewed before this inspection can be completed". The office does
        not finalize (2026-10-05): the technician's submission ends the visit,
        and the maintenance admins review the findings for the reports and the
        comparison. A stepper whose last step never comes, and a banner about a
        completion nobody performs, said nothing true. Who walked it and for how
        long are the visit's facts and moved into its card below.
      */}
      <RecordContent
        billing={
          <InvoicesCard
            createHref={isFinishedStatus(item.status) ? `/invoices/new?inspection=${encodeURIComponent(id)}` : undefined}
            inspectionId={id}
          />
        }
        jobber={jobber}
      >
        {reviewing || item.baselineMissing ? (
          <section aria-label="Review" className="mt-3 space-y-3">
            {reviewing ? (
              /* One instrument, as the dashboard's figures (console-development):
                 three separate bordered tiles left an empty third of the row on
                 every inspection not compared with a move-in. */
              <StatGroup columns={figureColumns}>
                <Stat
                  label="Areas reviewed"
                  value={
                    areaSummary.data
                      ? `${areaSummary.data.totals.areasReviewed} of ${areaSummary.data.totals.areas}`
                      : '—'
                  }
                />
                {showsFindings ? (
                  <Stat
                    label="Findings to review"
                    tone={pending ? 'warning' : 'default'}
                    value={pendingFindings.data ? (pending ? pending : 'None') : '—'}
                  />
                ) : null}
                {comparesToMoveIn ? (
                  <Stat
                    label="Compared with"
                    value={
                      // A record, not a figure: in the body size, so a date does not
                      // wrap in a narrow cell at the figures' size.
                      baseline ? (
                        <Link
                          className="font-sans text-base hover:underline"
                          href={`/inspections/${baseline.id}`}
                        >
                          Move-in · {formatScheduledDate(baseline.scheduledAt)}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground font-sans text-base">No move-in</span>
                      )
                    }
                  />
                ) : null}
              </StatGroup>
            ) : null}

          {/*
            A move-out with nothing to compare against.

            `ComparisonService.generate` refuses this outright with
            MOVE_IN_BASELINE_NOT_FOUND, so the report this inspection exists to
            produce cannot be written. Said here, on the record somebody opens to
            work it -- true of a scheduled move-out as much as a walked one, and it
            is the scheduled ones that are still fixable.
          */}
          {item.baselineMissing ? (
            <Alert variant="warning">
              <TriangleAlertIcon />
              <AlertTitle>No move-in to compare against</AlertTitle>
              <AlertDescription>
                This property has no move-in inspection before this date for the same unit and
                lease, so the move-in comparison cannot be generated. Import the move-in report if
                the walkthrough was done outside this app, or record the move-in first.
              </AlertDescription>
            </Alert>
          ) : null}
          </section>
        ) : null}

        {reviewing ? [areas, notes, visit] : [visit, notes, areas]}
      </RecordContent>

      {/* Assignment history and activity are reference material, not the task.
          Collapsed by default so they stop competing with the review workspace
          for attention; `open` on a details element keeps them one click away
          and keyboard-reachable without any custom disclosure logic. */}
      <div className="mt-4">
        <details className="group">
          <summary className="bg-card hover:bg-accent flex cursor-pointer items-center gap-2 rounded-xl border p-3 text-sm font-medium select-none">
            History
            <span className="text-muted-foreground font-normal">Assignments and activity</span>
          </summary>

          {/* Panels, each one surface: the Card around a table and an empty
              state that each brought their own border drew two boxes, one
              inside the other (console-development). */}
          <div className="mt-4 grid items-start gap-4 xl:grid-cols-2">
            <Panel title="Assignment history">
              {assignments.isLoading ? (
                <DataTableSkeleton
                  className="rounded-none border-0"
                  columns={ASSIGNMENT_COLUMNS}
                  label="Loading assignment history"
                  rows={3}
                />
              ) : assignments.isError ? (
                <ErrorState
                  className="rounded-none border-0"
                  error={assignments.error}
                  retry={() => void assignments.refetch()}
                />
              ) : assignments.data?.items.length ? (
                <>
                  <DataTable
                    className="rounded-none border-0"
                    columns={ASSIGNMENT_COLUMNS}
                    label="Inspection assignment history"
                    rowKey={(row) => row.id}
                    rows={assignments.data.items}
                  />
                  {assignments.data.totalPages > 1 ? (
                    <div className="border-t px-4 pb-3">
                      <Pagination
                        onPage={(assignmentPage) => setState({ assignmentPage })}
                        page={state.assignmentPage}
                        total={assignments.data.total}
                        totalPages={assignments.data.totalPages}
                      />
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-muted-foreground px-4 py-6 text-center text-sm">
                  No assignment history has been recorded.
                </p>
              )}
            </Panel>

            <Panel title="Recent activity">
              {audit.isLoading ? (
                <div className="p-3">
                  <PageSkeleton cards={1} />
                </div>
              ) : audit.isError ? (
                <ErrorState
                  className="rounded-none border-0"
                  error={audit.error}
                  retry={() => void audit.refetch()}
                />
              ) : audit.data?.items.length ? (
                <>
                  <ol className="divide-y">
                    {audit.data.items.map((event) => (
                      <li className="flex items-start justify-between gap-3 px-4 py-2.5" key={event.id}>
                        {/* What, to what, and who: "Finding approved · Leak
                            under the sink -- Ernie". The time alone could not
                            say who approved a finding or reviewed an area. */}
                        <span className="grid min-w-0 gap-0.5">
                          <span className="text-sm font-medium">{humanize(event.action)}</span>
                          {event.detail ? (
                            <span className="text-muted-foreground truncate text-xs">
                              {event.detail}
                            </span>
                          ) : null}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-right text-xs">
                          {event.actorName ? (
                            <span className="text-foreground block">{event.actorName}</span>
                          ) : null}
                          {formatDateTime(event.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {audit.data.totalPages > 1 ? (
                    <div className="border-t px-4 pb-3">
                      <Pagination
                        onPage={(auditPage) => setState({ auditPage })}
                        page={state.auditPage}
                        total={audit.data.total}
                        totalPages={audit.data.totalPages}
                      />
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-muted-foreground px-4 py-6 text-center text-sm">
                  No audit activity has been recorded.
                </p>
              )}
            </Panel>
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
      {markingComplete ? (
        <MarkCompleteDialog inspectionId={id} onClose={() => setMarkingComplete(false)} />
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

/**
 * The page body, with Jobber's side panel beside it in the Jobber-style shell
 * -- from 2xl only, as the area workspace needs the width more than the panel
 * does -- and exactly as it was in the classic console.
 */
function RecordContent({
  billing,
  children,
  jobber,
}: {
  /** The visit's invoices: in the side panel, or under the page in the classic console. */
  billing: ReactNode;
  children: ReactNode;
  jobber: boolean;
}) {
  if (!jobber)
    return (
      <>
        {children}
        <div className="mt-6 max-w-xl">{billing}</div>
      </>
    );
  return (
    <RecordLayout
      aside={billing}
      asideLabel="About this inspection"
      from="2xl"
      panelLabel="Invoices"
    >
      {children}
    </RecordLayout>
  );
}

/** The review figures' columns, by how many figures there are: whole rows only. */
const REVIEW_COLUMNS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-3',
};

export default function InspectionDetailPage() {
  // `useUrlState` and the evidence workspace both read `useSearchParams`, which
  // needs a Suspense boundary or the whole segment opts out of prerendering.
  return (
    <Suspense fallback={<PageSkeleton cards={3} />}>
      <InspectionDetail />
    </Suspense>
  );
}
