'use client';

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
} from '@/components/shared';
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
import { buttonVariants } from '@/components/ui/button';
import { TableCell, TableRow } from '@/components/ui/table';
import { Alert } from '@/components/ui/alert';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { usePermissions } from '@/lib/auth';
import {
  useAdminMutations,
  usePropertywareStatus,
  useSyncErrors,
  useSyncRuns,
  useSyncSchedule,
} from '@/lib/queries';

// Turns a cron expression into a short human summary for the common cases we
// document; falls back to the raw expression for anything custom.
function describeCron(cron: string | null): string {
  if (!cron) return 'Not configured';
  const parts = cron.trim().split(/\s+/);
  if (parts.length === 5) {
    const [minute, hour, dom, month, dow] = parts;
    const pad = (value: string) => value.padStart(2, '0');
    if (dom === '*' && month === '*' && dow === '*') {
      if (/^\d+$/.test(minute) && /^\d+$/.test(hour))
        return `Every day at ${pad(hour)}:${pad(minute)}`;
      const everyHours = hour.match(/^\*\/(\d+)$/);
      if (everyHours && minute === '0') return `Every ${everyHours[1]} hours`;
    }
    if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '1' && month === '*' && dow === '*')
      return `Monthly on the 1st at ${pad(hour)}:${pad(minute)}`;
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

// Statuses that represent active, in-progress work — these get the live pulse.
const ACTIVE_STATUSES = new Set(['RUNNING', 'PENDING']);
const isActiveStatus = (status?: string | null) => Boolean(status && ACTIVE_STATUSES.has(status));

const SYNC_RUN_HEADERS = [
  'Type',
  'Status',
  'Started',
  'Completed',
  'Fetched',
  'Created',
  'Updated',
  'Failed',
  'Warnings',
];

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

export default function PropertywarePage() {
  const canManage = usePermissions().has('integrations:manage');
  const [errorPage, setErrorPage] = useState(1);
  const [pendingMode, setPendingMode] = useState<SyncMode | null>(null);
  const status = usePropertywareStatus();
  const schedule = useSyncSchedule();
  const runs = useSyncRuns();
  const lastRunForMode = (mode: string) => runs.data?.find((run) => run.syncType === mode) ?? null;
  const latestRunId = runs.data?.[0]?.id ?? '';
  const errors = useSyncErrors(latestRunId, errorPage);
  const mutation = useAdminMutations().sync;
  const integration = status.data as PropertywareStatus | undefined;
  const latestRun = integration?.lastRun ?? runs.data?.[0];
  const cursors = integration?.cursors ?? [];
  const unresolvedErrors = integration?.unresolvedErrors ?? 0;
  const isRunning = isActiveStatus(latestRun?.status) || mutation.isPending;

  // One controlled dialog serves all three buttons: they differ only by mode, so
  // holding the pending mode in state avoids three near-identical dialogs.
  async function sync() {
    if (!pendingMode) return;
    await mutation.mutateAsync(pendingMode);
    setPendingMode(null);
  }

  return (
    <>
      <PageHeader
        title="Propertyware"
        description="Read-only catalog synchronization and operational health. Credentials are never displayed in the browser."
      />

      <AlertDialog onOpenChange={(open) => !open && setPendingMode(null)} open={pendingMode !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start a {pendingMode} synchronization?</AlertDialogTitle>
            <AlertDialogDescription>{pendingMode ? SYNC_MODE_EFFECT[pendingMode] : ''}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'primary' })}
              onClick={() => void sync()}
            >
              Start sync
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card className="p-[22px] max-[560px]:p-4" asChild>
      <section>
        <CardHeader className="p-0 pb-4">
          <div>
            <span className="block text-xs font-semibold text-muted-foreground">Operational controls</span>
            <CardTitle className="text-[17px]">Synchronization</CardTitle>
            <CardDescription>
              Import active portfolios and properties, retrieve recent changes, or verify that local
              records still match Propertyware.
            </CardDescription>
          </div>
          <Badge
            value={isRunning ? 'RUNNING' : status.isError ? 'ERROR' : 'CONNECTED'}
            pulse={isRunning}
          />
        </CardHeader>
        {/* Ordered by how often you would reach for them, and worded by when to
            use each rather than what each does internally. The everyday one was
            in the middle wearing a filled highlight, which reads as a selected
            option rather than the recommended action — the tag now says which
            it is, so the emphasis means recommended instead of chosen. */}
        <div className="sync-action-grid" aria-label="Manual synchronization actions">
          <button
            className="sync-action sync-action-primary"
            disabled={!canManage || mutation.isPending}
            onClick={() => setPendingMode('incremental')}
          >
            <strong>
              Fetch recent changes
              <span className="sync-action-tag">Everyday</span>
            </strong>
            <span>Picks up what changed in Propertyware since the last sync. Quick.</span>
          </button>
          <button
            className="sync-action"
            disabled={!canManage || mutation.isPending}
            onClick={() => setPendingMode('reconcile')}
          >
            <strong>Check for drift</strong>
            <span>
              Compares every local record against Propertyware. Use when something looks wrong.
            </span>
          </button>
          <button
            className="sync-action"
            disabled={!canManage || mutation.isPending}
            onClick={() => setPendingMode('initial')}
          >
            <strong>Re-import everything</strong>
            <span>Pulls the whole catalog again. Rarely needed, and the slowest.</span>
          </button>
        </div>
        {/* Says so before the click, not after: the confirmation step is the
            reason it is safe to press one of these to find out what it does. */}
        <p className="text-[13px] text-muted-foreground">
          Each asks you to confirm before it starts, and only one sync runs at a time.
        </p>
        {!canManage ? (
          <p className="text-[13px] text-muted-foreground">You have read-only integration access.</p>
        ) : null}
        {mutation.error ? (
          <Alert variant="destructive" role="alert">
            {mutation.error.message}
          </Alert>
        ) : null}
        {mutation.isSuccess ? (
          <Alert variant="success" role="status">
            Synchronization was queued. Status updates automatically.
          </Alert>
        ) : null}
      </section>
      </Card>

      <Card className="p-[22px] max-[560px]:p-4" asChild>
      <section className="section-gap">
        <CardHeader className="p-0 pb-4">
          <div>
            <span className="block text-xs font-semibold text-muted-foreground">Automation</span>
            <CardTitle className="text-[17px]">Automatic schedule</CardTitle>
            <CardDescription>
              When enabled, these syncs run on their own — no manual trigger needed.
            </CardDescription>
          </div>
          {schedule.data ? (
            <Badge value={schedule.data.enabled ? 'AUTOMATIC ON' : 'AUTOMATIC OFF'} />
          ) : null}
        </CardHeader>
        {schedule.isLoading ? (
          <LoadingState label="Checking the automatic schedule…" />
        ) : schedule.isError ? (
          <ErrorState error={schedule.error} retry={() => void schedule.refetch()} />
        ) : schedule.data ? (
          <>
            {schedule.data.enabled && !schedule.data.organizationConfigured ? (
              <Alert variant="warning" role="status">
                Automatic sync is enabled but no organization is configured
                (PROPERTYWARE_LOCAL_ORGANIZATION_ID), so nothing will run yet.
              </Alert>
            ) : null}
            {!schedule.data.enabled ? (
              <Alert variant="warning" role="status">
                Automatic sync is turned off (PROPERTYWARE_SYNC_ENABLED). The cadence below applies
                once it is enabled.
              </Alert>
            ) : null}
            <DataTable
              headers={['Sync', 'Cadence', 'Next run', 'Last run']}
              label="Automatic Propertyware sync schedule"
            >
              {schedule.data.jobs.map((job) => {
                const last = lastRunForMode(job.mode);
                return (
                  <TableRow key={job.mode}>
                    <TableCell>
                      <strong>{MODE_LABELS[job.mode] ?? job.mode}</strong>
                    </TableCell>
                    <TableCell>
                      {describeCron(job.cron)}
                      {job.cron ? <div className="cell-note">{job.cron}</div> : null}
                    </TableCell>
                    <TableCell>
                      {job.scheduled && job.nextRunAt ? (
                        formatDate(job.nextRunAt)
                      ) : (
                        <span className="text-[13px] text-muted-foreground">Not scheduled</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {last ? (
                        <>
                          <Badge value={last.status} pulse={isActiveStatus(last.status)} />
                          <div className="cell-note">
                            {formatDate(last.completedAt ?? last.startedAt)}
                          </div>
                        </>
                      ) : (
                        <span className="text-[13px] text-muted-foreground">No runs yet</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </DataTable>
          </>
        ) : null}
      </section>
      </Card>

      <Card className="p-[22px] max-[560px]:p-4" asChild>
      <section className="section-gap">
        <CardHeader className="p-0 pb-4">
          <div>
            <span className="block text-xs font-semibold text-muted-foreground">Integration health</span>
            <CardTitle className="text-[17px]">Latest source activity</CardTitle>
            <CardDescription>
              A readable summary of the latest synchronization state.
            </CardDescription>
          </div>
          <span className="source-chip">
            {integration?.provider === 'mock' ? 'Mock source' : 'Live API'}
          </span>
        </CardHeader>
        {status.isLoading ? (
          <LoadingState label="Checking Propertyware health…" />
        ) : status.isError ? (
          <ErrorState error={status.error} retry={() => void status.refetch()} />
        ) : (
          <>
            <div className="integration-health-grid">
              <article>
                <span>Last run</span>
                {latestRun?.status ? (
                  <Badge value={latestRun.status} pulse={isActiveStatus(latestRun.status)} />
                ) : (
                  <strong>Not started</strong>
                )}
                <small>
                  {latestRun?.syncType?.replaceAll('_', ' ') ?? 'No synchronization type'}
                </small>
              </article>
              <article>
                <span>Records fetched</span>
                <strong>{(latestRun?.recordsFetched ?? 0).toLocaleString()}</strong>
                <small>{formatDate(latestRun?.completedAt)}</small>
              </article>
              <article>
                <span>Records updated</span>
                <strong>{(latestRun?.recordsUpdated ?? 0).toLocaleString()}</strong>
                <small>{(latestRun?.recordsCreated ?? 0).toLocaleString()} newly created</small>
              </article>
              <article className={unresolvedErrors ? 'health-attention' : undefined}>
                <span>Unresolved errors</span>
                <strong>{unresolvedErrors.toLocaleString()}</strong>
                <small>
                  {(latestRun?.recordsFailed ?? 0).toLocaleString()} failed in latest run
                </small>
              </article>
            </div>

            <div className="cursor-section">
              <div className="subsection-heading">
                <div>
                  <h3>Entity freshness</h3>
                  <p>Last successful source activity by synchronized record type.</p>
                </div>
                <span>{cursors.length} tracked entities</span>
              </div>
              {cursors.length ? (
                <DataTable
                  headers={['Entity', 'Last successful sync', 'Last reconciliation', 'Cursor']}
                  label="Propertyware synchronization cursors"
                >
                  {cursors.map((cursor, index) => (
                    <TableRow key={`${cursor.entityType ?? 'entity'}-${index}`}>
                      <TableCell>
                        <strong className="entity-name">
                          {cursor.entityType ?? 'Unknown entity'}
                        </strong>
                      </TableCell>
                      <TableCell>{formatDate(cursor.lastSuccessfulSyncAt ?? cursor.cursor)}</TableCell>
                      <TableCell>{formatDate(cursor.lastFullReconciliationAt)}</TableCell>
                      <TableCell>
                        <span className="cursor-value">
                          {cursor.lastSuccessfulCursor ?? cursor.cursor ?? 'Not available'}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </DataTable>
              ) : (
                <div className="compact-empty-state">No entity cursors have been recorded yet.</div>
              )}
            </div>
          </>
        )}
      </section>
      </Card>

      <Card className="p-[22px] max-[560px]:p-4" asChild>
      <section className="section-gap">
        <CardHeader className="p-0 pb-4">
          <div>
            <CardTitle className="text-[17px]">Recent sync runs</CardTitle>
            <CardDescription>
              Audit history and record-level outcomes for recent jobs.
            </CardDescription>
          </div>
        </CardHeader>
        {runs.isLoading ? (
          <TableLoadingState headers={SYNC_RUN_HEADERS} rows={5} label="Loading sync history" />
        ) : runs.isError ? (
          <ErrorState error={runs.error} retry={() => void runs.refetch()} />
        ) : runs.data?.length ? (
          <DataTable headers={SYNC_RUN_HEADERS} label="Recent Propertyware synchronization runs">
            {runs.data.map((run) => (
              <TableRow key={run.id}>
                <TableCell>
                  <strong>{run.syncType}</strong>
                </TableCell>
                <TableCell>
                  <Badge value={run.status} pulse={isActiveStatus(run.status)} />
                </TableCell>
                <TableCell>{formatDate(run.startedAt)}</TableCell>
                <TableCell>{formatDate(run.completedAt)}</TableCell>
                <TableCell className="numeric-cell">{run.recordsFetched}</TableCell>
                <TableCell className="numeric-cell">{run.recordsCreated}</TableCell>
                <TableCell className="numeric-cell">{run.recordsUpdated}</TableCell>
                <TableCell className="numeric-cell">{run.recordsFailed}</TableCell>
                <TableCell className="numeric-cell">{run.warnings}</TableCell>
              </TableRow>
            ))}
          </DataTable>
        ) : (
          <div className="compact-empty-state">No synchronization runs have been recorded.</div>
        )}
      </section>
      </Card>

      <Card className="p-[22px] max-[560px]:p-4" asChild>
      <section className="section-gap">
        <CardHeader className="p-0 pb-4">
          <div>
            <CardTitle className="text-[17px]">Latest run errors</CardTitle>
            <CardDescription>
              Sanitized integration failures that may require attention.
            </CardDescription>
          </div>
        </CardHeader>
        {!latestRunId || (runs.isLoading && !runs.data) ? (
          <div className="compact-empty-state">No synchronization run is available.</div>
        ) : errors.isLoading ? (
          <TableLoadingState
            headers={['Entity', 'Code', 'Message', 'Retryable', 'Created', 'Resolved']}
            rows={5}
            label="Loading synchronization errors"
          />
        ) : errors.isError ? (
          <ErrorState error={errors.error} retry={() => void errors.refetch()} />
        ) : errors.data?.items.length ? (
          <>
            <DataTable
              headers={['Entity', 'Code', 'Message', 'Retryable', 'Created', 'Resolved']}
              label="Latest Propertyware synchronization errors"
            >
              {errors.data.items.map((error) => (
                <TableRow key={error.id}>
                  <TableCell>
                    <strong className="entity-name">{error.entityType}</strong>
                  </TableCell>
                  <TableCell>
                    <span className="error-code">{error.errorCode}</span>
                  </TableCell>
                  <TableCell className="message-cell">{error.sanitizedMessage}</TableCell>
                  <TableCell>{error.retryable ? <Badge value="RETRYABLE" /> : 'No'}</TableCell>
                  <TableCell>{formatDate(error.createdAt)}</TableCell>
                  <TableCell>{error.resolvedAt ? formatDate(error.resolvedAt) : 'Unresolved'}</TableCell>
                </TableRow>
              ))}
            </DataTable>
            <Pagination
              page={errorPage}
              totalPages={errors.data.totalPages}
              onPage={setErrorPage}
            />
          </>
        ) : (
          <div className="compact-success-state">
            The latest synchronization run has no recorded errors.
          </div>
        )}
      </section>
      </Card>
    </>
  );
}
