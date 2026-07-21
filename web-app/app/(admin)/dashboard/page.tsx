'use client';

import Link from 'next/link';

import {
  Badge,
  ErrorState,
  LoadingState,
  MetricCard,
  PageHeader,
  formatDate,
} from '@/components/ui';
import { useDashboard } from '@/lib/queries';

export default function DashboardPage() {
  const dashboard = useDashboard();
  if (dashboard.isLoading)
    return (
      <>
        <PageHeader title="Dashboard" />
        <LoadingState label="Loading operational metrics…" />
      </>
    );
  if (dashboard.isError)
    return (
      <>
        <PageHeader title="Dashboard" />
        <ErrorState error={dashboard.error} retry={() => void dashboard.refetch()} />
      </>
    );
  const data = dashboard.data!;
  const metrics = [
    ['Active portfolios', data.metrics.portfolios],
    ['Active properties', data.metrics.properties],
    ['Active units', data.metrics.units],
    ['Relevant leases', data.metrics.leases],
    ['Active technicians', data.metrics.technicians],
    ['Unassigned', data.metrics.unassigned],
    ['Assigned', data.metrics.assigned],
    ['In progress', data.metrics.inProgress],
    ['Completed', data.metrics.completed],
  ] as const;
  return (
    <>
      <PageHeader
        title="Operations dashboard"
        description="Live inspection, assignment, synchronization, and provider readiness."
        action={
          <Link className="button button-primary" href="/inspections/new">
            Create inspection
          </Link>
        }
      />
      <section className="metric-grid" aria-label="Summary metrics">
        {metrics.map(([label, value]) => (
          <MetricCard key={label} label={label} value={value} />
        ))}
      </section>
      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-header">
            <h2>Propertyware synchronization</h2>
            <Link className="table-link" href="/integrations/propertyware">
              View integration
            </Link>
          </div>
          {data.lastSync ? (
            <div className="detail-grid">
              <div className="detail-item">
                <span>Status</span>
                <Badge value={data.lastSync.status} />
              </div>
              <div className="detail-item">
                <span>Type</span>
                <strong>{data.lastSync.syncType}</strong>
              </div>
              <div className="detail-item">
                <span>Completed</span>
                <strong>{formatDate(data.lastSync.completedAt)}</strong>
              </div>
            </div>
          ) : (
            <p>No successful synchronization has been recorded.</p>
          )}
        </section>
        <section className="panel">
          <div className="panel-header">
            <h2>Provider readiness</h2>
            <Link className="table-link" href="/integrations/providers">
              View all
            </Link>
          </div>
          <div className="stack">
            {data.providerReadiness.map((provider) => (
              <div className="panel-header" key={provider.provider}>
                <span>{provider.provider}</span>
                <Badge value={provider.status} />
              </div>
            ))}
          </div>
        </section>
      </div>
      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-header">
          <h2>Recent warnings and errors</h2>
        </div>
        {data.recentErrors.length ? (
          <ul className="timeline">
            {data.recentErrors.map((error) => (
              <li key={error.id}>
                <strong>
                  {error.errorCode} · {error.entityType}
                </strong>
                <span>{error.sanitizedMessage}</span>
                <span>{formatDate(error.createdAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No unresolved synchronization errors.</p>
        )}
      </section>
    </>
  );
}
