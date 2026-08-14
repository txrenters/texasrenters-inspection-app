'use client';

import {
  ArrowRightIcon,
  Building2Icon,
  CheckCircle2Icon,
  ClipboardCheckIcon,
  FileTextIcon,
  LayersIcon,
  PlayCircleIcon,
  TriangleAlertIcon,
  UsersRoundIcon,
} from 'lucide-react';
import Link from 'next/link';

import { PageHeader, SectionHeader } from '@/components/page-header';
import { StatCard, StatCardSkeleton } from '@/components/stat-card';
import { ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCount, formatDateTime, formatRelative, humanize } from '@/lib/format';
import { useDashboard } from '@/lib/queries';

export default function DashboardPage() {
  const dashboard = useDashboard();

  if (dashboard.isError)
    return (
      <>
        <PageHeader title="Operations dashboard" />
        <ErrorState error={dashboard.error} retry={() => void dashboard.refetch()} />
      </>
    );

  if (dashboard.isLoading || !dashboard.data)
    return (
      <>
        <PageHeader
          description="Live inspection, assignment, synchronization, and provider readiness."
          title="Operations dashboard"
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <StatCardSkeleton key={index} />
          ))}
        </div>
        <Skeleton className="mt-6 h-48 rounded-xl" />
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

  return (
    <>
      <PageHeader
        actions={
          <Button asChild>
            <Link href="/inspections/new">Create inspection</Link>
          </Button>
        }
        description="Live inspection, assignment, synchronization, and provider readiness."
        title="Operations dashboard"
      />

      {/* Workflow first. The old dashboard led with five catalog counts that
          change once a night, and put the number needing action fourth. */}
      <section aria-labelledby="operations-title" className="space-y-3">
        <SectionHeader
          actions={
            <Button asChild size="sm" variant="ghost">
              <Link href="/inspections">
                View inspections
                <ArrowRightIcon />
              </Link>
            </Button>
          }
          title="Current operations"
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            action={
              data.metrics.unassigned ? (
                <Button asChild size="sm" variant="outline">
                  <Link href="/inspections?unassigned=true">Assign now</Link>
                </Button>
              ) : undefined
            }
            detail="Reach nobody until assigned"
            icon={TriangleAlertIcon}
            label="Unassigned"
            tone={data.metrics.unassigned ? 'warning' : 'default'}
            value={formatCount(data.metrics.unassigned)}
          />
          <StatCard
            detail="Ready to begin"
            icon={ClipboardCheckIcon}
            label="Assigned"
            value={formatCount(data.metrics.assigned)}
          />
          <StatCard
            detail="Active in the field"
            icon={PlayCircleIcon}
            label="In progress"
            value={formatCount(data.metrics.inProgress)}
          />
          <StatCard
            detail="Finished inspections"
            icon={CheckCircle2Icon}
            label="Completed"
            tone="success"
            value={formatCount(data.metrics.completed)}
          />
        </div>
      </section>

      <section aria-labelledby="catalog-title" className="mt-6 space-y-3">
        <SectionHeader
          actions={
            <Button asChild size="sm" variant="ghost">
              <Link href="/properties">
                Browse properties
                <ArrowRightIcon />
              </Link>
            </Button>
          }
          description="Synchronized from Propertyware."
          title="Portfolio coverage"
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard icon={LayersIcon} label="Portfolios" value={formatCount(data.metrics.portfolios)} />
          <StatCard
            icon={Building2Icon}
            label="Properties"
            value={formatCount(data.metrics.properties)}
          />
          <StatCard icon={Building2Icon} label="Units" value={formatCount(data.metrics.units)} />
          <StatCard icon={FileTextIcon} label="Leases" value={formatCount(data.metrics.leases)} />
          <StatCard
            icon={UsersRoundIcon}
            label="Technicians"
            value={formatCount(data.metrics.technicians)}
          />
        </div>
      </section>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Propertyware synchronization</CardTitle>
            <Button asChild size="sm" variant="ghost">
              <Link href="/integrations/propertyware">
                View
                <ArrowRightIcon />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {data.lastSync ? (
              <dl className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <dt className="text-muted-foreground text-xs font-medium">Status</dt>
                  <dd>
                    <StatusBadge value={data.lastSync.status} />
                  </dd>
                </div>
                <div className="space-y-1.5">
                  <dt className="text-muted-foreground text-xs font-medium">Type</dt>
                  <dd className="text-sm font-medium">{humanize(data.lastSync.syncType)}</dd>
                </div>
                <div className="space-y-1.5">
                  <dt className="text-muted-foreground text-xs font-medium">Completed</dt>
                  <dd className="text-sm font-medium" title={data.lastSync.completedAt ?? undefined}>
                    {formatRelative(data.lastSync.completedAt)}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="text-muted-foreground text-sm">
                No successful synchronization has been recorded.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Provider readiness</CardTitle>
            <Button asChild size="sm" variant="ghost">
              <Link href="/integrations/providers">
                View all
                <ArrowRightIcon />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {data.providerReadiness.map((provider) => (
                <li className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0" key={provider.provider}>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{provider.provider}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      {provider.detail ?? 'Operational configuration check'}
                    </p>
                  </div>
                  <StatusBadge value={provider.status} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader className="flex-row items-start justify-between">
          <div className="space-y-1">
            <CardTitle>Warnings and errors</CardTitle>
            <p className="text-muted-foreground text-sm">
              Grouped by source and message to reduce repetition.
            </p>
          </div>
          {groupedErrors.length ? (
            <Badge variant="warning">
              {groupedErrors.length === 1 ? '1 issue' : `${groupedErrors.length} issues`}
            </Badge>
          ) : null}
        </CardHeader>
        <CardContent>
          {groupedErrors.length ? (
            <ul className="divide-y">
              {groupedErrors.map((error) => (
                <li
                  className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
                  key={`${error.errorCode}:${error.entityType}:${error.id}`}
                >
                  <TriangleAlertIcon
                    aria-hidden
                    className="text-warning mt-0.5 size-4 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{humanize(error.errorCode)}</p>
                    <p className="text-muted-foreground text-sm break-words">
                      {error.sanitizedMessage}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {error.entityType} · {formatDateTime(error.createdAt)}
                    </p>
                  </div>
                  {error.count > 1 ? (
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      ×{error.count}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-success flex items-center gap-2 text-sm">
              <CheckCircle2Icon aria-hidden className="size-4" />
              No unresolved synchronization errors.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
