'use client';

import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import {
  Badge,
  ErrorState,
  LoadingState,
  MetricCard,
  PageHeader,
  formatDate,
} from '@/components/shared';
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
  const catalogMetrics = [
    ['Active portfolios', data.metrics.portfolios, 'Propertyware ownership groups'],
    ['Active properties', data.metrics.properties, 'Available for inspection'],
    ['Active units', data.metrics.units, 'Synchronized rental units'],
    ['Relevant leases', data.metrics.leases, 'Current lifecycle records'],
    ['Active technicians', data.metrics.technicians, 'Mobile workforce accounts'],
  ] as const;
  const operationMetrics = [
    ['Unassigned', data.metrics.unassigned, 'Need a technician', 'warning'],
    ['Assigned', data.metrics.assigned, 'Ready to begin', 'blue'],
    ['In progress', data.metrics.inProgress, 'Active in the field', 'green'],
    ['Completed', data.metrics.completed, 'Finished inspections', 'neutral'],
  ] as const;
  const groupedErrors = Array.from(
    data.recentErrors
      .reduce((groups, error) => {
        const key = `${error.errorCode}:${error.entityType}:${error.sanitizedMessage}`;
        const current = groups.get(key);
        groups.set(key, current ? { ...current, count: current.count + 1 } : { ...error, count: 1 });
        return groups;
      }, new Map<string, (typeof data.recentErrors)[number] & { count: number }>())
      .values(),
  );

  return (
    <>
      <PageHeader
        title="Operations dashboard"
        description="Live inspection, assignment, synchronization, and provider readiness."
        action={
          <Link className={buttonVariants({ variant: 'primary' })} href="/inspections/new">
            Create inspection
          </Link>
        }
      />

      <section className="dashboard-section" aria-labelledby="catalog-overview-title">
        <div className="section-heading-row">
          <div>
            <span className="block text-xs font-semibold text-muted-foreground">Synchronized catalog</span>
            <h2 id="catalog-overview-title">Portfolio coverage</h2>
          </div>
          <Link className="text-action" href="/properties">
            Browse properties <span aria-hidden>→</span>
          </Link>
        </div>
        <div className="metric-grid catalog-metric-grid">
          {catalogMetrics.map(([label, value, detail]) => (
            <MetricCard key={label} label={label} value={value} detail={detail} />
          ))}
        </div>
      </section>

      <section className="dashboard-section" aria-labelledby="inspection-overview-title">
        <div className="section-heading-row">
          <div>
            <span className="block text-xs font-semibold text-muted-foreground">Inspection workflow</span>
            <h2 id="inspection-overview-title">Current operations</h2>
          </div>
          <Link className="text-action" href="/inspections">
            View inspections <span aria-hidden>→</span>
          </Link>
        </div>
        <div className="metric-grid operations-metric-grid">
          {operationMetrics.map(([label, value, detail, tone]) => (
            <MetricCard key={label} label={label} value={value} detail={detail} tone={tone} />
          ))}
        </div>
      </section>

      <div className="dashboard-grid">
        <Card className="p-[22px] max-[560px]:p-4" asChild>
          <section>
          <CardHeader className="p-0 pb-4">
            <CardTitle className="text-[17px]">Propertyware synchronization</CardTitle>
            <Link className="font-semibold text-primary" href="/integrations/propertyware">
              View integration
            </Link>
          </CardHeader>
          {data.lastSync ? (
            <div className="grid grid-cols-3 gap-4 max-[560px]:grid-cols-1">
              <div className="rounded-xl bg-background p-3.5">
                <span>Status</span>
                <Badge value={data.lastSync.status} />
              </div>
              <div className="rounded-xl bg-background p-3.5">
                <span>Type</span>
                <strong>{data.lastSync.syncType}</strong>
              </div>
              <div className="rounded-xl bg-background p-3.5">
                <span>Completed</span>
                <strong>{formatDate(data.lastSync.completedAt)}</strong>
              </div>
            </div>
          ) : (
            <p className="mb-0">No successful synchronization has been recorded.</p>
          )}
          </section>
        </Card>

        <Card className="p-[22px] max-[560px]:p-4" asChild>
          <section>
          <CardHeader className="p-0 pb-4">
            <CardTitle className="text-[17px]">Provider readiness</CardTitle>
            <Link className="font-semibold text-primary" href="/integrations/providers">
              View all
            </Link>
          </CardHeader>
          <div className="readiness-list">
            {data.providerReadiness.map((provider) => (
              <div className="readiness-row" key={provider.provider}>
                <span>
                  <strong>{provider.provider}</strong>
                  <small>{provider.detail ?? 'Operational configuration check'}</small>
                </span>
                <Badge value={provider.status} />
              </div>
            ))}
          </div>
          </section>
        </Card>
      </div>

      <Card className="p-[22px] max-[560px]:p-4" asChild>
        <section className="section-gap">
        <CardHeader className="p-0 pb-4">
          <div>
            <CardTitle className="text-[17px]">Warnings and errors</CardTitle>
            <CardDescription>Grouped by source and error message to reduce repetition.</CardDescription>
          </div>
          {groupedErrors.length ? <span className="issue-total">{groupedErrors.length} issues</span> : null}
        </CardHeader>
        {groupedErrors.length ? (
          <ul className="issue-list">
            {groupedErrors.map((error) => (
              <li key={`${error.errorCode}:${error.entityType}:${error.id}`}>
                <span className="issue-marker" aria-hidden>!</span>
                <span className="issue-copy">
                  <strong>{error.errorCode.replaceAll('_', ' ')}</strong>
                  <span>{error.sanitizedMessage}</span>
                  <small>
                    {error.entityType} · {formatDate(error.createdAt)}
                  </small>
                </span>
                {error.count > 1 ? <span className="issue-count">{error.count} occurrences</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <div className="compact-success-state">No unresolved synchronization errors.</div>
        )}
        </section>
      </Card>
    </>
  );
}
