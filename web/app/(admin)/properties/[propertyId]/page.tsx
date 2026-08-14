'use client';

import { leaseExpiryLabel, leaseExpiryStatus } from '@texasrenters/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { DataTable, type Column } from '@/components/data-table';
import { FloorPlanManager } from '@/components/floor-plan-manager';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { usePermissions } from '@/lib/auth';
import { EMPTY, formatAddress, formatCount, formatDate, formatRelative } from '@/lib/format';
import { useProperty } from '@/lib/queries';
import { cn } from '@/lib/utils';

/**
 * A lease the sync has stopped confirming.
 *
 * Leases are exempt from absence-based deactivation, because the published
 * report is a view rather than a full inventory — one dropping out of a run does
 * not mean the tenancy ended. So an absent lease stays active and looks exactly
 * like a confirmed one, and `lastSeenAt` is the only thing that says otherwise.
 *
 * A day and a half, so the daily reconciliation has to miss a lease twice before
 * it is called out. One skipped run is noise; two is worth a look.
 */
const LEASE_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

function isStaleLease(lastSeenAt?: string | null) {
  if (!lastSeenAt) return false;
  const seen = new Date(lastSeenAt).getTime();
  return Number.isFinite(seen) && Date.now() - seen > LEASE_STALE_AFTER_MS;
}

/**
 * A lease's term end, with how near it is. `endDate` answers "when does this
 * lease end" for renewal planning; a scheduled move-out is a separate column
 * because it answers a different question and the two can disagree.
 */
function LeaseEnd({ endDate }: { endDate?: string | null }) {
  if (!endDate) return <>{EMPTY}</>;
  const status = leaseExpiryStatus(endDate);
  return (
    <span className="grid gap-0.5">
      {formatDate(endDate)}
      <span
        className={cn(
          'text-xs',
          status === 'EXPIRED'
            ? 'text-destructive'
            : status === 'EXPIRING_SOON'
              ? 'text-warning'
              : 'text-muted-foreground',
        )}
      >
        {leaseExpiryLabel(endDate)}
      </span>
    </span>
  );
}

type PropertyDetail = NonNullable<ReturnType<typeof useProperty>['data']>;
type UnitRow = NonNullable<PropertyDetail['units']>[number];
type LeaseRow = NonNullable<PropertyDetail['leases']>[number];

const UNIT_COLUMNS: Array<Column<UnitRow>> = [
  { key: 'name', header: 'Unit', primary: true, cell: (unit) => unit.name },
  { key: 'bedrooms', header: 'Bedrooms', numeric: true, cell: (unit) => unit.bedrooms ?? EMPTY },
  {
    key: 'bathrooms',
    header: 'Bathrooms',
    numeric: true,
    cell: (unit) => unit.bathrooms ?? EMPTY,
  },
  {
    key: 'leaseStatus',
    header: 'Lease status',
    hideBelow: 'md',
    cell: (unit) => unit.leaseStatus ?? 'No relevant lease',
  },
  { key: 'leaseEnd', header: 'Lease ends', cell: (unit) => <LeaseEnd endDate={unit.leaseEndDate} /> },
  {
    key: 'moveOut',
    header: 'Scheduled move-out',
    hideBelow: 'lg',
    cell: (unit) => formatDate(unit.scheduledMoveOutDate),
  },
  {
    key: 'status',
    header: 'Status',
    cell: (unit) => <StatusBadge value={unit.isActive ? 'ACTIVE' : 'INACTIVE'} />,
  },
];

const LEASE_COLUMNS: Array<Column<LeaseRow>> = [
  {
    key: 'lease',
    header: 'Lease',
    primary: true,
    cell: (lease) => (
      <span className="grid gap-0.5">
        {lease.leaseName ?? lease.externalId}
        {/* Only when it has actually gone stale. A lease confirmed by the last
            run needs no annotation, and marking every row with a date would bury
            the two that matter. */}
        {isStaleLease(lease.lastSeenAt) ? (
          <span className="text-warning text-xs">
            Not in the last sync · seen {formatDate(lease.lastSeenAt)}
          </span>
        ) : null}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    cell: (lease) => lease.sourceStatus ?? EMPTY,
  },
  { key: 'start', header: 'Term start', hideBelow: 'md', cell: (lease) => formatDate(lease.startDate) },
  { key: 'end', header: 'Term ends', cell: (lease) => <LeaseEnd endDate={lease.endDate} /> },
  {
    key: 'moveOut',
    header: 'Scheduled move-out',
    hideBelow: 'lg',
    cell: (lease) => formatDate(lease.scheduledMoveOutDate),
  },
];

export default function PropertyDetailPage() {
  const permissions = usePermissions();
  const id = useParams<{ propertyId: string }>().propertyId;
  const property = useProperty(id);

  // isError first: a failed fetch has no data either, and checking `!data`
  // ahead of it would show a skeleton forever instead of the error.
  if (property.isError)
    return <ErrorState error={property.error} retry={() => void property.refetch()} />;
  if (!property.data) return <PageSkeleton cards={3} />;
  const item = property.data;

  const areaSource =
    item.totalArea?.source === 'PROPERTYWARE_BUILDING'
      ? 'From Propertyware'
      : item.totalArea?.source === 'MANUAL'
        ? 'Entered manually'
        : item.totalArea?.derived
          ? 'Derived from units'
          : 'No reliable value';

  return (
    <>
      <PageHeader
        actions={
          item.isActive && permissions.has('inspections:manage') ? (
            <Button asChild>
              <Link href={`/inspections/new?propertyId=${item.id}`}>Create inspection</Link>
            </Button>
          ) : (
            <StatusBadge value="INACTIVE" />
          )
        }
        description={formatAddress(item)}
        title={item.name}
      />

      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Card className="gap-0 p-4">
          <dt className="text-muted-foreground text-xs font-medium">Portfolio</dt>
          <dd className="mt-1 text-sm font-medium">{item.portfolio?.name ?? 'Unassigned'}</dd>
          {!item.portfolio ? (
            <dd className="text-muted-foreground mt-0.5 text-xs">
              Propertyware holds no portfolio for this property
            </dd>
          ) : null}
        </Card>

        <Card className="gap-0 p-4">
          <dt className="text-muted-foreground text-xs font-medium">Total area</dt>
          <dd className="mt-1 text-sm font-medium">{item.totalArea?.label ?? EMPTY}</dd>
          <dd className="text-muted-foreground mt-0.5 text-xs">{areaSource}</dd>
        </Card>

        <Card className="gap-0 p-4">
          <dt className="text-muted-foreground text-xs font-medium">Lease summary</dt>
          <dd className="mt-1 text-sm font-medium">
            {item.leaseSummary?.summary ?? 'Lease data not synchronized'}
          </dd>
          {item.leaseSummary?.leaseDataAvailable === false ? (
            // Never let missing data read as "this property has no lease".
            <dd className="text-warning mt-0.5 text-xs">
              No units have synchronized for this property, so lease status is unknown
            </dd>
          ) : item.leaseSummary?.nextLeaseEndDate ? (
            <dd className="text-muted-foreground mt-0.5 text-xs">
              Next lease ends {formatDate(item.leaseSummary.nextLeaseEndDate)} ·{' '}
              {leaseExpiryLabel(item.leaseSummary.nextLeaseEndDate).toLowerCase()}
            </dd>
          ) : (
            <dd className="text-muted-foreground mt-0.5 text-xs">No upcoming lease end date</dd>
          )}
        </Card>

        <Card className="gap-0 p-4">
          <dt className="text-muted-foreground text-xs font-medium">Source status</dt>
          <dd className="mt-1 text-sm font-medium">{item.sourceStatus ?? EMPTY}</dd>
        </Card>

        <Card className="gap-0 p-4">
          <dt className="text-muted-foreground text-xs font-medium">External reference</dt>
          <dd className="mt-1 font-mono text-sm break-all">{item.externalId}</dd>
        </Card>

        <Card className="gap-0 p-4">
          <dt className="text-muted-foreground text-xs font-medium">Last synchronized</dt>
          <dd className="mt-1 text-sm font-medium" title={item.lastSyncedAt ?? undefined}>
            {formatRelative(item.lastSyncedAt)}
          </dd>
        </Card>
      </dl>

      <Card className="mt-4">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Active units</CardTitle>
          <Badge variant="secondary">{formatCount(item.units?.length ?? 0)}</Badge>
        </CardHeader>
        <CardContent>
          {item.units?.length ? (
            <DataTable
              columns={UNIT_COLUMNS}
              label="Active units"
              rowKey={(unit) => unit.id}
              rows={item.units}
            />
          ) : (
            <EmptyState
              description="No active units have synchronized for this property."
              title="No units"
            />
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Relevant leases</CardTitle>
          <Badge variant="secondary">{formatCount(item.leases?.length ?? 0)}</Badge>
        </CardHeader>
        <CardContent>
          {item.leases?.length ? (
            <DataTable
              columns={LEASE_COLUMNS}
              label="Relevant leases"
              rowKey={(lease) => lease.id}
              rows={item.leases}
            />
          ) : (
            <EmptyState
              description="No relevant active leases were returned by the last synchronization."
              title="No leases"
            />
          )}
        </CardContent>
      </Card>

      <div className="mt-6">
        <FloorPlanManager canManage={permissions.has('properties:manage')} propertyId={item.id} />
      </div>
    </>
  );
}
