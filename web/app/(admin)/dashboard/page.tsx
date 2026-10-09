'use client';

import { ArrowRightIcon } from 'lucide-react';
import Link from 'next/link';

import { JobberDayPanel } from '@/components/jobber-day-panel';
import { PageHeader } from '@/components/page-header';
import { Panel, PanelRow } from '@/components/panel';
import {
  Stat,
  StatGroup,
  StatGroupSkeleton,
  StatStrip,
  StatStripItem,
} from '@/components/stat-card';
import { ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { businessToday } from '@/lib/clock';
import { formatCount, formatDateTime, formatRelative, humanize } from '@/lib/format';
import { usePermissions } from '@/lib/auth';
import { useDashboard, useJobberDay } from '@/lib/queries';
import { cn } from '@/lib/utils';

/** Providers in these states need somebody; READY and CONFIGURED do not. */
const PROVIDER_NEEDS_A_PERSON = new Set(['NOT_CONFIGURED', 'DEGRADED', 'UNAVAILABLE', 'ERROR']);

/** "Friday, October 9", for the Texas business day (the office reads from Manila). */
function texasDayLabel() {
  return new Date(`${businessToday()}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function Header() {
  return (
    <PageHeader
      actions={
        <>
          <Button asChild variant="outline">
            <Link href="/inspections">Today&apos;s inspections</Link>
          </Button>
          <Button asChild>
            <Link href="/inspections/new">Create inspection</Link>
          </Button>
        </>
      }
      description={
        <span className="font-mono text-[10.5px] font-medium tracking-[0.12em] uppercase">
          {texasDayLabel()} · Texas
        </span>
      }
      title="Today's operations"
    />
  );
}

export default function DashboardPage() {
  const dashboard = useDashboard();
  const { has } = usePermissions();
  const canReadInspections = has('inspections:read');
  const jobberDay = useJobberDay(businessToday(), canReadInspections);

  if (dashboard.isError)
    return (
      <>
        <Header />
        <ErrorState error={dashboard.error} retry={() => void dashboard.refetch()} />
      </>
    );

  if (dashboard.isLoading || !dashboard.data)
    return (
      <>
        <Header />
        <StatGroupSkeleton columns="grid-cols-2 lg:grid-cols-4" count={4} />
        <Skeleton className="mt-5 h-48 rounded-xl" />
      </>
    );

  const data = dashboard.data;

  // Grouped by code, entity and message: the same failure repeated forty times
  // is one problem, and listing it forty times buries the other three.
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
  const providersNeedingAPerson = data.providerReadiness.filter((provider) =>
    PROVIDER_NEEDS_A_PERSON.has(provider.status),
  );
  const jobberDifferences = jobberDay.data?.rows.filter((row) => row.state !== 'MATCHES').length ?? 0;
  const needsAPerson =
    (data.metrics.unassigned ? 1 : 0) +
    (jobberDifferences ? 1 : 0) +
    groupedErrors.length +
    providersNeedingAPerson.length;

  return (
    <>
      <Header />

      {/* Workflow first: the four figures somebody acts on. Only the queue
          that needs a person carries a mark. */}
      <StatGroup columns="grid-cols-2 lg:grid-cols-4">
        <Stat
          action={
            data.metrics.unassigned ? (
              <Button asChild size="sm" variant="outline">
                {/* Every date: the count is every upcoming visit with
                    nobody on it, not today's. */}
                <Link href="/inspections?tech=unassigned&day=all">Assign now</Link>
              </Button>
            ) : undefined
          }
          detail="Reach nobody until assigned"
          label="Unassigned"
          tone={data.metrics.unassigned ? 'warning' : 'default'}
          value={formatCount(data.metrics.unassigned)}
        />
        <Stat detail="Ready to begin" label="Assigned" value={formatCount(data.metrics.assigned)} />
        <Stat
          detail="In the field now"
          label="In progress"
          value={formatCount(data.metrics.inProgress)}
        />
        <Stat detail="All time" label="Completed" value={formatCount(data.metrics.completed)} />
      </StatGroup>

      <div className="mt-5 grid items-start gap-5 lg:grid-cols-3">
        {canReadInspections ? (
          <JobberDayPanel
            className="lg:col-span-2"
            day={jobberDay.data}
            loading={jobberDay.isLoading}
          />
        ) : null}

        <div className={cn('grid gap-5', !canReadInspections && 'lg:col-span-3 lg:grid-cols-3')}>
        {/* What needs somebody, in one list, in the order it should be done.
            Replaces the "Warnings and errors" card, which listed sync noise
            under its own heading and said nothing about the queue. */}
        <Panel
          className={cn(!canReadInspections && 'lg:col-span-2')}
          count={needsAPerson || undefined}
          countTone="warning"
          title="Needs a person"
        >
          {needsAPerson ? (
            <div className="divide-y">
              {data.metrics.unassigned ? (
                <PanelRow
                  title={
                    <Link className="hover:underline" href="/inspections?tech=unassigned&day=all">
                      {data.metrics.unassigned === 1
                        ? '1 inspection has no technician'
                        : `${formatCount(data.metrics.unassigned)} inspections have no technician`}
                    </Link>
                  }
                  detail="Upcoming, any date"
                  tone="warning"
                />
              ) : null}
              {jobberDifferences ? (
                <PanelRow
                  detail="Today, as of the last Jobber sync"
                  title={
                    <Link className="hover:underline" href={`/schedule?date=${jobberDay.data!.date}`}>
                      {jobberDifferences === 1
                        ? '1 visit differs from Jobber'
                        : `${jobberDifferences} visits differ from Jobber`}
                    </Link>
                  }
                  tone="warning"
                />
              ) : null}
              {groupedErrors.map((error) => (
                <PanelRow
                  detail={
                    <>
                      {error.sanitizedMessage}
                      <span className="block">
                        {error.entityType} · {formatDateTime(error.createdAt)}
                      </span>
                    </>
                  }
                  key={`${error.errorCode}:${error.entityType}:${error.id}`}
                  title={humanize(error.errorCode)}
                  tone="destructive"
                  trailing={
                    error.count > 1 ? (
                      <span className="text-muted-foreground font-mono text-xs tabular-nums">
                        ×{error.count}
                      </span>
                    ) : null
                  }
                />
              ))}
              {providersNeedingAPerson.map((provider) => (
                <PanelRow
                  detail={provider.detail ?? 'Operational configuration check'}
                  key={provider.provider}
                  title={
                    <Link className="hover:underline" href="/integrations/providers">
                      {provider.provider}: {humanize(provider.status).toLowerCase()}
                    </Link>
                  }
                  tone="warning"
                />
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground px-4 py-6 text-sm">
              Nothing needs a person right now.
            </p>
          )}
        </Panel>

        {/* Reference, not work: quiet, one line each. */}
        <Panel
          actions={
            <Button asChild className="h-7 px-2 text-xs" size="sm" variant="ghost">
              <Link href="/integrations/providers">
                All
                <ArrowRightIcon />
              </Link>
            </Button>
          }
          title="Systems"
        >
          <ul className="divide-y">
            <li className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <Link className="block truncate text-sm hover:underline" href="/integrations/propertyware">
                  Propertyware
                </Link>
                <p
                  className="text-muted-foreground truncate text-xs"
                  title={data.lastSync?.completedAt ?? undefined}
                >
                  {data.lastSync
                    ? `${humanize(data.lastSync.syncType)} · ${formatRelative(data.lastSync.completedAt)}`
                    : 'No sync recorded'}
                </p>
              </div>
              {data.lastSync ? <StatusBadge value={data.lastSync.status} /> : null}
            </li>
            {data.providerReadiness
              .filter((provider) => provider.provider !== 'Propertyware')
              .map((provider) => (
                <li
                  className="flex items-center justify-between gap-3 px-4 py-2.5"
                  key={provider.provider}
                >
                  <span className="min-w-0 truncate text-sm" title={provider.detail}>
                    {provider.provider}
                  </span>
                  <StatusBadge value={provider.status} />
                </li>
              ))}
          </ul>
        </Panel>
        </div>
      </div>

      {/* Synchronized overnight and nobody acts on them from here: a strip, not
          a panel of boxes. */}
      <StatStrip
        action={
          <Button asChild className="h-7 px-2 text-xs" size="sm" variant="ghost">
            <Link href="/properties">
              Browse properties
              <ArrowRightIcon />
            </Link>
          </Button>
        }
        className="mt-5"
        title="Portfolio · Propertyware"
      >
        <StatStripItem label="Portfolios" value={formatCount(data.metrics.portfolios)} />
        <StatStripItem label="Properties" value={formatCount(data.metrics.properties)} />
        <StatStripItem label="Units" value={formatCount(data.metrics.units)} />
        <StatStripItem label="Leases" value={formatCount(data.metrics.leases)} />
        <StatStripItem label="Technicians" value={formatCount(data.metrics.technicians)} />
      </StatStrip>
    </>
  );
}
