'use client';

import { CheckCircle2Icon } from 'lucide-react';
import { useState } from 'react';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { Panel } from '@/components/panel';
import { Stat, StatGroup } from '@/components/stat-card';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EMPTY, formatCount, formatDateTime, formatRelative, humanize } from '@/lib/format';
import { usePermissions } from '@/lib/auth';
import {
  useAdminMutations,
  usePropertywareStatus,
  useSyncErrors,
  useSyncRuns,
  useSyncSchedule,
} from '@/lib/queries';
import { cn } from '@/lib/utils';
import { useUrlState } from '@/lib/url-state';

/**
 * Turns a cron expression into a short human summary for the common cases we
 * document; falls back to the raw expression for anything custom.
 */
function describeCron(cron: string | null): string {
  if (!cron) return 'Not configured';
  const parts = cron.trim().split(/\s+/);
  if (parts.length === 5) {
    const [minute, hour, dom, month, dow] = parts;
    const pad = (value: string) => value.padStart(2, '0');
    if (dom === '*' && month === '*' && dow === '*') {
      if (/^\d+$/.test(minute!) && /^\d+$/.test(hour!))
        return `Every day at ${pad(hour!)}:${pad(minute!)}`;
      const everyHours = hour!.match(/^\*\/(\d+)$/);
      if (everyHours && minute === '0') return `Every ${everyHours[1]} hours`;
    }
    if (
      /^\d+$/.test(minute!) &&
      /^\d+$/.test(hour!) &&
      dom === '1' &&
      month === '*' &&
      dow === '*'
    )
      return `Monthly on the 1st at ${pad(hour!)}:${pad(minute!)}`;
  }
  return cron;
}

type SyncMode = 'initial' | 'incremental' | 'reconcile';

// Each mode touches the catalog differently, so the confirmation says which.
const SYNC_MODE_EFFECT: Record<SyncMode, string> = {
  initial:
    'Imports the complete active catalog from Propertyware. This is the heaviest run and can take a while on a large portfolio.',
  incremental: 'Retrieves only records changed since the last successful sync.',
  reconcile:
    'Compares local records against Propertyware and flags anything that no longer matches. Nothing is written back to Propertyware.',
};

const MODE_LABELS: Record<string, string> = {
  incremental: 'Incremental sync',
  reconciliation: 'Reconcile catalog',
};

/**
 * The three modes as a choice, ordered by how often you would want one.
 *
 * Worded by occasion rather than mechanism — "what changed since last time"
 * rather than "incremental" — because the mechanism is only meaningful to
 * someone who already knows which to pick.
 */
const SYNC_MODE_OPTIONS: Array<{
  mode: SyncMode;
  title: string;
  description: string;
  recommended?: boolean;
}> = [
  {
    mode: 'incremental',
    title: 'Recent changes',
    description: 'Picks up what changed in Propertyware since the last sync. Quick.',
    recommended: true,
  },
  {
    mode: 'reconcile',
    title: 'Check for drift',
    description: 'Compares every local record against Propertyware. Use when something looks wrong.',
  },
  {
    mode: 'initial',
    title: 'Re-import everything',
    description: 'Pulls the whole catalog again. Rarely needed, and the slowest.',
  },
];

// Statuses that represent active, in-progress work.
const ACTIVE_STATUSES = new Set(['RUNNING', 'PENDING']);
const isActiveStatus = (status?: string | null) => Boolean(status && ACTIVE_STATUSES.has(status));

type StatusRun = {
  id?: string;
  syncType?: string;
  status?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  recordsFetched?: number;
  recordsCreated?: number;
  recordsUpdated?: number;
  recordsFailed?: number;
  warnings?: number;
};

type SyncCursor = {
  entityType?: string;
  cursor?: string | null;
  lastSuccessfulCursor?: string | null;
  lastSuccessfulSyncAt?: string | null;
  lastFullReconciliationAt?: string | null;
};

type PropertywareStatus = {
  provider?: string;
  lastRun?: StatusRun | null;
  cursors?: SyncCursor[];
  unresolvedErrors?: number;
};

type SyncRun = NonNullable<ReturnType<typeof useSyncRuns>['data']>[number];
type SyncError = NonNullable<ReturnType<typeof useSyncErrors>['data']>['items'][number];

const RUN_COLUMNS: Array<Column<SyncRun>> = [
  { key: 'type', header: 'Type', primary: true, cell: (run) => humanize(run.syncType) },
  {
    key: 'status',
    header: 'Status',
    cell: (run) => <StatusBadge value={run.status} />,
  },
  { key: 'started', header: 'Started', hideBelow: 'md', cell: (run) => formatDateTime(run.startedAt) },
  {
    key: 'completed',
    header: 'Completed',
    hideBelow: 'lg',
    cell: (run) => formatDateTime(run.completedAt),
  },
  { key: 'fetched', header: 'Fetched', numeric: true, cell: (run) => formatCount(run.recordsFetched) },
  {
    key: 'created',
    header: 'Created',
    numeric: true,
    hideBelow: 'sm',
    cell: (run) => formatCount(run.recordsCreated),
  },
  {
    key: 'updated',
    header: 'Updated',
    numeric: true,
    hideBelow: 'sm',
    cell: (run) => formatCount(run.recordsUpdated),
  },
  {
    key: 'failed',
    header: 'Failed',
    numeric: true,
    // A neutral figure with a red dot when any failed (console-development): a
    // red number in a column of black ones read as decoration.
    cell: (run) => (
      <span className="inline-flex items-center gap-1.5">
        {run.recordsFailed ? (
          <span aria-hidden className="bg-destructive size-1.5 shrink-0 rounded-full" />
        ) : null}
        {formatCount(run.recordsFailed)}
      </span>
    ),
  },
  {
    key: 'warnings',
    header: 'Warnings',
    numeric: true,
    hideBelow: 'xl',
    cell: (run) => formatCount(run.warnings),
  },
];

const ERROR_COLUMNS: Array<Column<SyncError>> = [
  { key: 'entity', header: 'Entity', primary: true, cell: (error) => error.entityType },
  {
    key: 'code',
    header: 'Code',
    cell: (error) => <code className="text-xs">{error.errorCode}</code>,
  },
  {
    key: 'message',
    header: 'Message',
    cell: (error) => <span className="text-muted-foreground">{error.sanitizedMessage}</span>,
  },
  {
    key: 'retryable',
    header: 'Retryable',
    hideBelow: 'md',
    cell: (error) => (error.retryable ? <Badge variant="info">Retryable</Badge> : 'No'),
  },
  {
    key: 'created',
    header: 'Created',
    hideBelow: 'lg',
    cell: (error) => formatDateTime(error.createdAt),
  },
  {
    key: 'resolved',
    header: 'Resolved',
    hideBelow: 'xl',
    cell: (error) => (error.resolvedAt ? formatDateTime(error.resolvedAt) : 'Unresolved'),
  },
];

export default function PropertywarePage() {
  const canManage = usePermissions().has('integrations:manage');
  const [state, setState] = useUrlState({ tab: 'sync', errorPage: 1 });
  const [pendingMode, setPendingMode] = useState<SyncMode | null>(null);
  // Choose a mode, then press one button — rather than three buttons each of
  // which starts something. The everyday mode is preselected so the common case
  // is a single press, and the rarer two are a deliberate choice away.
  const [selectedMode, setSelectedMode] = useState<SyncMode>('incremental');

  const status = usePropertywareStatus();
  const schedule = useSyncSchedule();
  const runs = useSyncRuns();
  const lastRunForMode = (mode: string) => runs.data?.find((run) => run.syncType === mode) ?? null;
  const latestRunId = runs.data?.[0]?.id ?? '';
  const errors = useSyncErrors(latestRunId, state.errorPage);
  const mutation = useAdminMutations().sync;

  const integration = status.data as PropertywareStatus | undefined;
  const latestRun = integration?.lastRun ?? runs.data?.[0];
  const cursors = integration?.cursors ?? [];
  const unresolvedErrors = integration?.unresolvedErrors ?? 0;
  const isRunning = isActiveStatus(latestRun?.status) || mutation.isPending;

  // One controlled dialog serves all three modes: they differ only by mode, so
  // holding the pending mode in state avoids three near-identical dialogs.
  async function sync() {
    if (!pendingMode) return;
    try {
      await mutation.mutateAsync(pendingMode);
    } finally {
      setPendingMode(null);
    }
  }

  return (
    <>
      <PageHeader
        // By the name, and only once it is known (console-development): it
        // sat in the action row and said "Connected" while the status was
        // still loading.
        badges={
          isRunning || !status.isLoading ? (
            <>
              <StatusBadge value={isRunning ? 'RUNNING' : status.isError ? 'FAILED' : 'CONNECTED'} />
              {integration ? (
                <Badge variant="outline">
                  {integration.provider === 'mock' ? 'Mock source' : 'Live API'}
                </Badge>
              ) : null}
            </>
          ) : undefined
        }
        description="Catalog synchronization from Propertyware, and how healthy it is."
        info={
          <>
            <p>
              Read-only catalog synchronization and operational health. Nothing is written back to
              Propertyware.
            </p>
            <p>Credentials are never displayed in the browser.</p>
            <p>
              Syncs run on their own daily. Each manual run asks you to confirm first, and only one
              sync runs at a time.
            </p>
          </>
        }
        infoLabel="About this integration"
        title="Propertyware"
      />

      <AlertDialog
        onOpenChange={(open) => !open && setPendingMode(null)}
        open={pendingMode !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Start the “{SYNC_MODE_OPTIONS.find((option) => option.mode === pendingMode)?.title}”
              synchronization?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingMode ? SYNC_MODE_EFFECT[pendingMode] : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void sync()}>Start sync</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Health first, above the tabs: it is the answer to "is this working",
          which is why anyone opens this page. The old layout put it third, below
          two cards of controls. */}
      <StatGroup className="mb-6" columns="grid-cols-2 lg:grid-cols-4">
        <Stat
          detail={`${humanize(latestRun?.syncType)} · ${formatRelative(latestRun?.completedAt)}`}
          label="Last run"
          value={
            latestRun?.status ? (
              <StatusBadge value={latestRun.status} />
            ) : (
              <span className="text-muted-foreground text-sm">Not started</span>
            )
          }
        />
        <Stat
          detail={formatDateTime(latestRun?.completedAt)}
          label="Records fetched"
          value={formatCount(latestRun?.recordsFetched)}
        />
        <Stat
          detail={`${formatCount(latestRun?.recordsCreated)} newly created`}
          label="Records updated"
          value={formatCount(latestRun?.recordsUpdated)}
        />
        {/* Every run's unresolved errors, not the latest run's -- which is what
            the Errors tab lists. Said, so the two counts are not read as one
            (console-development). */}
        <Stat
          detail={`Across all runs · ${formatCount(latestRun?.recordsFailed)} failed in the latest`}
          label="Unresolved errors"
          tone={unresolvedErrors ? 'destructive' : 'default'}
          value={formatCount(unresolvedErrors)}
        />
      </StatGroup>

      <Tabs onValueChange={(tab) => setState({ tab })} value={state.tab}>
        <TabsList>
          <TabsTrigger value="sync">Run a sync</TabsTrigger>
          <TabsTrigger value="schedule">Automatic schedule</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="errors">Latest run errors</TabsTrigger>
        </TabsList>

        <TabsContent className="mt-4" value="sync">
          {/* Panels with borderless tables inside, not a card holding a card
              holding a table (console-development). */}
          <Panel bodyClassName="space-y-4 p-4" title="Synchronization">
            <p className="text-muted-foreground text-sm">
              Import active portfolios and properties, retrieve recent changes, or verify that
              local records still match Propertyware.
            </p>
            {/* Options, not actions — which is what these always looked like.
                Choosing one and pressing a single button also removes the
                question the three-button version asked: which of these am I
                allowed to press. */}
            <div aria-label="Synchronization mode" className="grid gap-3 md:grid-cols-3" role="radiogroup">
              {SYNC_MODE_OPTIONS.map((option) => {
                const active = selectedMode === option.mode;
                return (
                  <button
                    aria-checked={active}
                    className={cn(
                      'flex flex-col items-start gap-1.5 rounded-lg border p-4 text-left transition-colors',
                      'focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none',
                      // The highlight marks the choice; ink is for the
                      // button that acts on it (console-development).
                      active ? 'border-highlight bg-highlight/10' : 'hover:bg-accent/50',
                      'disabled:pointer-events-none disabled:opacity-50',
                    )}
                    disabled={!canManage || isRunning}
                    key={option.mode}
                    onClick={() => setSelectedMode(option.mode)}
                    role="radio"
                    type="button"
                  >
                    {/* Wraps, so on a narrow card "Recommended" drops under the
                        title instead of running into the next card (768px). */}
                    <span className="flex w-full flex-wrap items-center gap-x-2 gap-y-1">
                      <span
                        aria-hidden
                        className={cn(
                          'size-4 shrink-0 rounded-full border-2',
                          active ? 'border-highlight bg-highlight' : 'border-muted-foreground/40',
                        )}
                      />
                      <span className="text-sm font-medium">{option.title}</span>
                      {option.recommended ? (
                        <span className="text-muted-foreground ml-auto text-xs">Recommended</span>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground text-xs leading-relaxed">
                      {option.description}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* When it last ran, beside the one control that runs it — so the
                answer to "does this need pressing" is in the same place as the
                button. */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
              <div className="text-muted-foreground text-sm">
                {latestRun?.completedAt
                  ? `Last synchronized ${formatRelative(latestRun.completedAt)}`
                  : 'No synchronization has completed yet'}
              </div>
              <Button
                disabled={!canManage || isRunning}
                onClick={() => setPendingMode(selectedMode)}
                type="button"
              >
                {isRunning ? 'Synchronizing…' : 'Start synchronization'}
              </Button>
            </div>

            {!canManage ? (
              <p className="text-muted-foreground text-sm">
                You have read-only integration access.
              </p>
            ) : null}
            {mutation.error ? (
              <Alert variant="destructive">
                <AlertDescription>{mutation.error.message}</AlertDescription>
              </Alert>
            ) : null}
            {mutation.isSuccess ? (
              <Alert variant="success">
                <CheckCircle2Icon />
                <AlertDescription>
                  Synchronization was queued. Status updates automatically.
                </AlertDescription>
              </Alert>
            ) : null}
          </Panel>

          <Panel className="mt-4" title="Entity freshness">
            <p className="text-muted-foreground border-b px-4 py-2.5 text-xs">
              Last successful source activity by synchronized record type.
            </p>
            {status.isLoading ? (
              <div className="p-4">
                <PageSkeleton cards={1} />
              </div>
            ) : status.isError ? (
              <ErrorState className="rounded-none border-0" error={status.error} retry={() => void status.refetch()} />
            ) : cursors.length ? (
              <DataTable
                className="rounded-none border-0"
                columns={[
                  {
                    key: 'entity',
                    header: 'Entity',
                    primary: true,
                    cell: (cursor: SyncCursor) => cursor.entityType ?? 'Unknown entity',
                  },
                  {
                    key: 'sync',
                    header: 'Last successful sync',
                    cell: (cursor: SyncCursor) =>
                      formatDateTime(cursor.lastSuccessfulSyncAt ?? cursor.cursor),
                  },
                  {
                    key: 'reconcile',
                    header: 'Last reconciliation',
                    hideBelow: 'md',
                    cell: (cursor: SyncCursor) => formatDateTime(cursor.lastFullReconciliationAt),
                  },
                  {
                    key: 'cursor',
                    header: 'Cursor',
                    hideBelow: 'lg',
                    cell: (cursor: SyncCursor) => (
                      <code className="text-muted-foreground text-xs break-all">
                        {cursor.lastSuccessfulCursor ?? cursor.cursor ?? EMPTY}
                      </code>
                    ),
                  },
                ]}
                label="Propertyware synchronization cursors"
                rowKey={(cursor) => cursor.entityType ?? String(cursors.indexOf(cursor))}
                rows={cursors}
              />
            ) : (
              <EmptyState className="rounded-none border-0" title="No entity cursors have been recorded yet." />
            )}
          </Panel>
        </TabsContent>

        <TabsContent className="mt-4" value="schedule">
          <Panel
            actions={
              schedule.data ? (
                <Badge variant={schedule.data.enabled ? 'success' : 'secondary'}>
                  {schedule.data.enabled ? 'Automatic on' : 'Automatic off'}
                </Badge>
              ) : null
            }
            title="Automatic schedule"
          >
            <p className="text-muted-foreground border-b px-4 py-2.5 text-xs">
              When enabled, these syncs run on their own - no manual trigger needed.
            </p>
            {schedule.isLoading ? (
              <div className="p-4">
                <PageSkeleton cards={1} />
              </div>
            ) : schedule.isError ? (
              <ErrorState className="rounded-none border-0" error={schedule.error} retry={() => void schedule.refetch()} />
            ) : schedule.data ? (
              <>
                {schedule.data.enabled && !schedule.data.organizationConfigured ? (
                  <Alert className="m-4 w-auto" variant="warning">
                    <AlertDescription>
                      Automatic sync is enabled but no organization is configured
                      (PROPERTYWARE_LOCAL_ORGANIZATION_ID), so nothing will run yet.
                    </AlertDescription>
                  </Alert>
                ) : null}
                {!schedule.data.enabled ? (
                  <Alert className="m-4 w-auto" variant="warning">
                    <AlertDescription>
                      Automatic sync is turned off (PROPERTYWARE_SYNC_ENABLED). The cadence below
                      applies once it is enabled.
                    </AlertDescription>
                  </Alert>
                ) : null}
                <DataTable
                  className="rounded-none border-0"
                  columns={[
                    {
                      key: 'sync',
                      header: 'Sync',
                      primary: true,
                      cell: (job) => MODE_LABELS[job.mode] ?? job.mode,
                    },
                    {
                      key: 'cadence',
                      header: 'Cadence',
                      cell: (job) => (
                        <span className="grid gap-0.5">
                          {describeCron(job.cron)}
                          {job.cron ? (
                            <code className="text-muted-foreground text-xs">{job.cron}</code>
                          ) : null}
                        </span>
                      ),
                    },
                    {
                      key: 'next',
                      header: 'Next run',
                      hideBelow: 'md',
                      cell: (job) =>
                        job.scheduled && job.nextRunAt ? (
                          formatDateTime(job.nextRunAt)
                        ) : (
                          <span className="text-muted-foreground">Not scheduled</span>
                        ),
                    },
                    {
                      key: 'last',
                      header: 'Last run',
                      cell: (job) => {
                        const last = lastRunForMode(job.mode);
                        return last ? (
                          <span className="grid gap-1">
                            <StatusBadge value={last.status} />
                            <span className="text-muted-foreground text-xs">
                              {formatRelative(last.completedAt ?? last.startedAt)}
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">No runs yet</span>
                        );
                      },
                    },
                  ]}
                  label="Automatic Propertyware sync schedule"
                  rowKey={(job) => job.mode}
                  rows={schedule.data.jobs}
                />
              </>
            ) : null}
          </Panel>
        </TabsContent>

        <TabsContent className="mt-4" value="history">
          <Panel title="Recent sync runs">
            <p className="text-muted-foreground border-b px-4 py-2.5 text-xs">
              Audit history and record-level outcomes for recent jobs.
            </p>
            {runs.isLoading ? (
              <div className="p-4">
                <DataTableSkeleton columns={RUN_COLUMNS} label="Loading sync history" rows={5} />
              </div>
            ) : runs.isError ? (
              <ErrorState className="rounded-none border-0" error={runs.error} retry={() => void runs.refetch()} />
            ) : runs.data?.length ? (
              <DataTable
                className="rounded-none border-0"
                columns={RUN_COLUMNS}
                label="Recent Propertyware synchronization runs"
                rowKey={(run) => run.id}
                rows={runs.data}
              />
            ) : (
              <EmptyState className="rounded-none border-0" title="No synchronization runs have been recorded." />
            )}
          </Panel>
        </TabsContent>

        <TabsContent className="mt-4" value="errors">
          <Panel title="Latest run errors">
            <p className="text-muted-foreground border-b px-4 py-2.5 text-xs">
              Sanitized integration failures from the latest run that may require attention.
            </p>
            {!latestRunId || (runs.isLoading && !runs.data) ? (
              <EmptyState className="rounded-none border-0" title="No synchronization run is available." />
            ) : errors.isLoading ? (
              <div className="p-4">
                <DataTableSkeleton
                  columns={ERROR_COLUMNS}
                  label="Loading synchronization errors"
                  rows={5}
                />
              </div>
            ) : errors.isError ? (
              <ErrorState className="rounded-none border-0" error={errors.error} retry={() => void errors.refetch()} />
            ) : errors.data?.items.length ? (
              <>
                <DataTable
                  className="rounded-none border-0"
                  columns={ERROR_COLUMNS}
                  label="Latest Propertyware synchronization errors"
                  rowKey={(error) => error.id}
                  rows={errors.data.items}
                />
                {errors.data.totalPages > 1 ? (
                  <div className="border-t px-4 pb-3">
                    <Pagination
                      onPage={(errorPage) => setState({ errorPage })}
                      page={state.errorPage}
                      total={errors.data.total}
                      totalPages={errors.data.totalPages}
                    />
                  </div>
                ) : null}
              </>
            ) : (
              <EmptyState
                className="rounded-none border-0"
                description="The latest synchronization run completed without recorded errors."
                icon={CheckCircle2Icon}
                title="No errors"
              />
            )}
          </Panel>
        </TabsContent>
      </Tabs>
    </>
  );
}
