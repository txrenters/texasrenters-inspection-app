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
} from '@/components/ui';
import {
  useAdminMutations,
  usePropertywareStatus,
  useSyncErrors,
  useSyncRuns,
} from '@/lib/queries';

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

export default function PropertywarePage() {
  const [errorPage, setErrorPage] = useState(1);
  const status = usePropertywareStatus();
  const runs = useSyncRuns();
  const latestRunId = runs.data?.[0]?.id ?? '';
  const errors = useSyncErrors(latestRunId, errorPage);
  const mutation = useAdminMutations().sync;
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
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Synchronization controls</h2>
            <p>
              Initial sync imports active portfolios and buildings; incremental sync fetches their
              changes; reconciliation verifies which source records remain active.
            </p>
          </div>
          <Badge value={status.isError ? 'ERROR' : 'READY'} />
        </div>
        <div className="action-row">
          <button
            className="button button-secondary"
            disabled={mutation.isPending}
            onClick={() => void sync('initial')}
          >
            Initial sync
          </button>
          <button
            className="button button-primary"
            disabled={mutation.isPending}
            onClick={() => void sync('incremental')}
          >
            Incremental sync
          </button>
          <button
            className="button button-secondary"
            disabled={mutation.isPending}
            onClick={() => void sync('reconcile')}
          >
            Reconcile
          </button>
        </div>
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
          <h2>Integration status</h2>
        </div>
        {status.isLoading ? (
          <LoadingState />
        ) : status.isError ? (
          <ErrorState error={status.error} retry={() => void status.refetch()} />
        ) : (
          <div className="code-summary">
            {Object.entries(status.data ?? {}).map(([key, value]) => (
              <div key={key}>
                <span>{key.replaceAll('_', ' ')}</span>
                <strong>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</strong>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="panel section-gap">
        <div className="panel-header">
          <h2>Recent sync runs</h2>
        </div>
        {runs.isLoading ? (
          <TableLoadingState headers={SYNC_RUN_HEADERS} rows={5} label="Loading sync history" />
        ) : runs.isError ? (
          <ErrorState error={runs.error} retry={() => void runs.refetch()} />
        ) : runs.data?.length ? (
          <DataTable headers={SYNC_RUN_HEADERS}>
            {runs.data.map((run) => (
              <tr key={run.id}>
                <td>{run.syncType}</td>
                <td>
                  <Badge value={run.status} />
                </td>
                <td>{formatDate(run.startedAt)}</td>
                <td>{formatDate(run.completedAt)}</td>
                <td>{run.recordsFetched}</td>
                <td>{run.recordsCreated}</td>
                <td>{run.recordsUpdated}</td>
                <td>{run.recordsFailed}</td>
                <td>{run.warnings}</td>
              </tr>
            ))}
          </DataTable>
        ) : (
          <p>No synchronization runs have been recorded.</p>
        )}
      </section>
      <section className="panel section-gap">
        <div className="panel-header">
          <h2>Latest run errors</h2>
        </div>
        {!latestRunId || (runs.isLoading && !runs.data) ? (
          <p>No synchronization run is available.</p>
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
            <DataTable headers={['Entity', 'Code', 'Message', 'Retryable', 'Created', 'Resolved']}>
              {errors.data.items.map((error) => (
                <tr key={error.id}>
                  <td>{error.entityType}</td>
                  <td>{error.errorCode}</td>
                  <td>{error.sanitizedMessage}</td>
                  <td>{error.retryable ? 'Yes' : 'No'}</td>
                  <td>{formatDate(error.createdAt)}</td>
                  <td>{formatDate(error.resolvedAt)}</td>
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
          <p>The latest synchronization run has no recorded errors.</p>
        )}
      </section>
    </>
  );
}
