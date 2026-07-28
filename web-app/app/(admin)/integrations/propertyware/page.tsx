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

  async function sync(mode: 'initial' | 'incremental' | 'reconcile') {
    if (!window.confirm(`Start a ${mode} Propertyware synchronization?`)) return;
    await mutation.mutateAsync(mode);
  }

  return (
    <>
      <PageHeader
        title="Propertyware"
        description="Read-only catalog synchronization and operational health. Credentials are never displayed in the browser."
      />

      <section className="panel integration-control-panel">
        <div className="panel-header integration-control-heading">
          <div>
            <span className="section-kicker">Operational controls</span>
            <h2>Synchronization</h2>
            <p className="panel-description">
              Import active portfolios and properties, retrieve recent changes, or verify that local
              records still match Propertyware.
            </p>
          </div>
          <Badge
            value={isRunning ? 'RUNNING' : status.isError ? 'ERROR' : 'CONNECTED'}
            pulse={isRunning}
          />
        </div>
        <div className="sync-action-grid" aria-label="Manual synchronization actions">
          <button
            className="sync-action"
            disabled={!canManage || mutation.isPending}
            onClick={() => void sync('initial')}
          >
            <strong>Initial sync</strong>
            <span>Import the complete active catalog</span>
          </button>
          <button
            className="sync-action sync-action-primary"
            disabled={!canManage || mutation.isPending}
            onClick={() => void sync('incremental')}
          >
            <strong>Incremental sync</strong>
            <span>Retrieve only recent source changes</span>
          </button>
          <button
            className="sync-action"
            disabled={!canManage || mutation.isPending}
            onClick={() => void sync('reconcile')}
          >
            <strong>Reconcile catalog</strong>
            <span>Validate active and deactivated records</span>
          </button>
        </div>
        {!canManage ? (
          <p className="panel-description">You have read-only integration access.</p>
        ) : null}
        {mutation.error ? (
          <div className="alert alert-danger" role="alert">
            {mutation.error.message}
          </div>
        ) : null}
        {mutation.isSuccess ? (
          <div className="alert alert-success" role="status">
            Synchronization was queued. Status updates automatically.
          </div>
        ) : null}
      </section>

      <section className="panel section-gap">
        <div className="panel-header">
          <div>
            <span className="section-kicker">Automation</span>
            <h2>Automatic schedule</h2>
            <p className="panel-description">
              When enabled, these syncs run on their own — no manual trigger needed.
            </p>
          </div>
          {schedule.data ? (
            <Badge value={schedule.data.enabled ? 'AUTOMATIC ON' : 'AUTOMATIC OFF'} />
          ) : null}
        </div>
        {schedule.isLoading ? (
          <LoadingState label="Checking the automatic schedule…" />
        ) : schedule.isError ? (
          <ErrorState error={schedule.error} retry={() => void schedule.refetch()} />
        ) : schedule.data ? (
          <>
            {schedule.data.enabled && !schedule.data.organizationConfigured ? (
              <div className="alert alert-warning" role="status">
                Automatic sync is enabled but no organization is configured
                (PROPERTYWARE_LOCAL_ORGANIZATION_ID), so nothing will run yet.
              </div>
            ) : null}
            {!schedule.data.enabled ? (
              <div className="alert alert-warning" role="status">
                Automatic sync is turned off (PROPERTYWARE_SYNC_ENABLED). The cadence below applies
                once it is enabled.
              </div>
            ) : null}
            <DataTable
              headers={['Sync', 'Cadence', 'Next run', 'Last run']}
              label="Automatic Propertyware sync schedule"
            >
              {schedule.data.jobs.map((job) => {
                const last = lastRunForMode(job.mode);
                return (
                  <tr key={job.mode}>
                    <td>
                      <strong>{MODE_LABELS[job.mode] ?? job.mode}</strong>
                    </td>
                    <td>
                      {describeCron(job.cron)}
                      {job.cron ? <div className="cell-note">{job.cron}</div> : null}
                    </td>
                    <td>
                      {job.scheduled && job.nextRunAt ? (
                        formatDate(job.nextRunAt)
                      ) : (
                        <span className="media-meta">Not scheduled</span>
                      )}
                    </td>
                    <td>
                      {last ? (
                        <>
                          <Badge value={last.status} pulse={isActiveStatus(last.status)} />
                          <div className="cell-note">
                            {formatDate(last.completedAt ?? last.startedAt)}
                          </div>
                        </>
                      ) : (
                        <span className="media-meta">No runs yet</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          </>
        ) : null}
      </section>

      <section className="panel section-gap">
        <div className="panel-header">
          <div>
            <span className="section-kicker">Integration health</span>
            <h2>Latest source activity</h2>
            <p className="panel-description">
              A readable summary of the latest synchronization state.
            </p>
          </div>
          <span className="source-chip">
            {integration?.provider === 'mock' ? 'Mock source' : 'Live API'}
          </span>
        </div>
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
                    <tr key={`${cursor.entityType ?? 'entity'}-${index}`}>
                      <td>
                        <strong className="entity-name">
                          {cursor.entityType ?? 'Unknown entity'}
                        </strong>
                      </td>
                      <td>{formatDate(cursor.lastSuccessfulSyncAt ?? cursor.cursor)}</td>
                      <td>{formatDate(cursor.lastFullReconciliationAt)}</td>
                      <td>
                        <span className="cursor-value">
                          {cursor.lastSuccessfulCursor ?? cursor.cursor ?? 'Not available'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </DataTable>
              ) : (
                <div className="compact-empty-state">No entity cursors have been recorded yet.</div>
              )}
            </div>
          </>
        )}
      </section>

      <section className="panel section-gap">
        <div className="panel-header">
          <div>
            <h2>Recent sync runs</h2>
            <p className="panel-description">
              Audit history and record-level outcomes for recent jobs.
            </p>
          </div>
        </div>
        {runs.isLoading ? (
          <TableLoadingState headers={SYNC_RUN_HEADERS} rows={5} label="Loading sync history" />
        ) : runs.isError ? (
          <ErrorState error={runs.error} retry={() => void runs.refetch()} />
        ) : runs.data?.length ? (
          <DataTable headers={SYNC_RUN_HEADERS} label="Recent Propertyware synchronization runs">
            {runs.data.map((run) => (
              <tr key={run.id}>
                <td>
                  <strong>{run.syncType}</strong>
                </td>
                <td>
                  <Badge value={run.status} pulse={isActiveStatus(run.status)} />
                </td>
                <td>{formatDate(run.startedAt)}</td>
                <td>{formatDate(run.completedAt)}</td>
                <td className="numeric-cell">{run.recordsFetched}</td>
                <td className="numeric-cell">{run.recordsCreated}</td>
                <td className="numeric-cell">{run.recordsUpdated}</td>
                <td className="numeric-cell">{run.recordsFailed}</td>
                <td className="numeric-cell">{run.warnings}</td>
              </tr>
            ))}
          </DataTable>
        ) : (
          <div className="compact-empty-state">No synchronization runs have been recorded.</div>
        )}
      </section>

      <section className="panel section-gap">
        <div className="panel-header">
          <div>
            <h2>Latest run errors</h2>
            <p className="panel-description">
              Sanitized integration failures that may require attention.
            </p>
          </div>
        </div>
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
                <tr key={error.id}>
                  <td>
                    <strong className="entity-name">{error.entityType}</strong>
                  </td>
                  <td>
                    <span className="error-code">{error.errorCode}</span>
                  </td>
                  <td className="message-cell">{error.sanitizedMessage}</td>
                  <td>{error.retryable ? <Badge value="RETRYABLE" /> : 'No'}</td>
                  <td>{formatDate(error.createdAt)}</td>
                  <td>{error.resolvedAt ? formatDate(error.resolvedAt) : 'Unresolved'}</td>
                </tr>
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
    </>
  );
}
