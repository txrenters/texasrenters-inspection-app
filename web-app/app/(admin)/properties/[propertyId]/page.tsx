'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { TableCell, TableRow } from '@/components/ui/table';
import { buttonVariants } from '@/components/ui/button';

import {
  Badge,
  DataTable,
  ErrorState,
  LoadingState,
  PageHeader,
  address,
  formatDate,
} from '@/components/shared';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { useProperty } from '@/lib/queries';
import { FloorPlanManager } from '@/components/floor-plan-manager';
import { usePermissions } from '@/lib/auth';
import { leaseExpiryLabel, leaseExpiryStatus } from '@texasrenters/shared';

/**
 * A lease's term end, with how near it is. `endDate` answers "when does this
 * lease end" for renewal planning; a scheduled move-out is a separate column
 * because it answers a different question and the two can disagree.
 */
/**
 * A lease the sync has stopped confirming.
 *
 * Leases are exempt from absence-based deactivation, because the published
 * report is a view rather than a full inventory — one dropping out of a run
 * does not mean the tenancy ended. So an absent lease stays active and looks
 * exactly like a confirmed one, and `lastSeenAt` is the only thing that says
 * otherwise.
 *
 * A day and a half, so the daily reconciliation has to miss a lease twice
 * before it is called out. One skipped run is noise; two is worth a look.
 */
const LEASE_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

function isStaleLease(lastSeenAt?: string | null) {
  if (!lastSeenAt) return false;
  const seen = new Date(lastSeenAt).getTime();
  return Number.isFinite(seen) && Date.now() - seen > LEASE_STALE_AFTER_MS;
}

function LeaseEnd({ endDate }: { endDate?: string | null }) {
  if (!endDate) return <>—</>;
  const status = leaseExpiryStatus(endDate);
  return (
    <span className={`lease-end is-${status.toLowerCase().replace('_', '-')}`}>
      {formatDate(endDate)}
      <small>{leaseExpiryLabel(endDate)}</small>
    </span>
  );
}

export default function PropertyDetailPage() {
  const permissions = usePermissions();
  const id = useParams<{ propertyId: string }>().propertyId;
  const property = useProperty(id);
  if (property.isLoading) return <LoadingState />;
  if (property.isError)
    return <ErrorState error={property.error} retry={() => void property.refetch()} />;
  const item = property.data!;
  return (
    <>
      <PageHeader
        title={item.name}
        description={address(item)}
        breadcrumbs={[{ label: 'Properties', href: '/properties' }, { label: item.name }]}
        action={
          item.isActive && permissions.has('inspections:manage') ? (
            <Link className={buttonVariants({ variant: 'primary' })} href={`/inspections/new?propertyId=${item.id}`}>
              Create inspection
            </Link>
          ) : (
            <Badge value="INACTIVE" />
          )
        }
      />
      <Card className="p-[22px] max-[560px]:p-4" asChild>
        <section>
        <div className="grid grid-cols-3 gap-4 max-[560px]:grid-cols-1">
          <div className="flex flex-col gap-1.5 rounded-xl bg-background p-4">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Portfolio</span>
            <strong className="text-base font-semibold leading-tight text-foreground">{item.portfolio?.name ?? 'Unassigned'}</strong>
            {!item.portfolio ? (
              <small className="text-xs leading-snug text-muted-foreground/80">
                Propertyware holds no portfolio for this property
              </small>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5 rounded-xl bg-background p-4">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Total area</span>
            <strong className="text-base font-semibold leading-tight text-foreground">{item.totalArea?.label ?? 'Not provided'}</strong>
            <small className="text-xs leading-snug text-muted-foreground/80">
              {item.totalArea?.source === 'PROPERTYWARE_BUILDING'
                ? 'From Propertyware'
                : item.totalArea?.source === 'MANUAL'
                  ? 'Entered manually'
                  : item.totalArea?.derived
                    ? 'Derived from units'
                    : 'No reliable value'}
            </small>
          </div>
          <div className="flex flex-col gap-1.5 rounded-xl bg-background p-4">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Lease summary</span>
            <strong className="text-base font-semibold leading-tight text-foreground">{item.leaseSummary?.summary ?? 'Lease data not synchronized'}</strong>
            {item.leaseSummary?.leaseDataAvailable === false ? (
              // Never let missing data read as "this property has no lease".
              <small className="detail-warning text-xs leading-snug">
                No units have synchronized for this property, so lease status is unknown
              </small>
            ) : item.leaseSummary?.nextLeaseEndDate ? (
              <small className="text-xs leading-snug text-muted-foreground/80">
                Next lease ends {formatDate(item.leaseSummary.nextLeaseEndDate)} ·{' '}
                {leaseExpiryLabel(item.leaseSummary.nextLeaseEndDate).toLowerCase()}
              </small>
            ) : (
              <small>No upcoming lease end date</small>
            )}
          </div>
          <div className="flex flex-col gap-1.5 rounded-xl bg-background p-4">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Source status</span>
            <strong className="text-base font-semibold leading-tight text-foreground">{item.sourceStatus ?? 'Not provided'}</strong>
          </div>
          <div className="flex flex-col gap-1.5 rounded-xl bg-background p-4">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">External reference</span>
            <strong className="text-base font-semibold leading-tight text-foreground">{item.externalId}</strong>
          </div>
          <div className="flex flex-col gap-1.5 rounded-xl bg-background p-4">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Last synchronized</span>
            <strong className="text-base font-semibold leading-tight text-foreground">{formatDate(item.lastSyncedAt)}</strong>
          </div>
        </div>
        </section>
      </Card>
      <Card className="p-[22px] max-[560px]:p-4" asChild>
        <section style={{ marginTop: 20 }}>
        <CardHeader className="p-0 pb-4">
          <CardTitle className="text-[17px]">Active units</CardTitle>
        </CardHeader>
        <DataTable
          headers={[
            'Unit',
            'Bedrooms',
            'Bathrooms',
            'Lease status',
            'Lease ends',
            'Scheduled move-out',
            'Status',
          ]}
        >
          {item.units?.map((unit) => (
            <TableRow key={unit.id}>
              <TableCell>{unit.name}</TableCell>
              <TableCell>{unit.bedrooms ?? 'Not provided'}</TableCell>
              <TableCell>{unit.bathrooms ?? 'Not provided'}</TableCell>
              <TableCell>{unit.leaseStatus ?? 'No relevant lease'}</TableCell>
              <TableCell>
                <LeaseEnd endDate={unit.leaseEndDate} />
              </TableCell>
              <TableCell>{unit.scheduledMoveOutDate ? formatDate(unit.scheduledMoveOutDate) : '—'}</TableCell>
              <TableCell>
                <Badge value={unit.isActive ? 'ACTIVE' : 'INACTIVE'} />
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
        </section>
      </Card>
      <Card className="p-[22px] max-[560px]:p-4" asChild>
        <section style={{ marginTop: 20 }}>
        <CardHeader className="p-0 pb-4">
          <CardTitle className="text-[17px]">Relevant leases</CardTitle>
        </CardHeader>
        {item.leases?.length ? (
          <DataTable headers={['Lease', 'Status', 'Term start', 'Term ends', 'Scheduled move-out']}>
            {item.leases.map((lease) => (
              <TableRow key={lease.id}>
                <TableCell>
                  {lease.leaseName ?? lease.externalId}
                  {/* Only when it has actually gone stale. A lease confirmed by
                      the last run needs no annotation, and marking every row
                      with a date would bury the two that matter. */}
                  {isStaleLease(lease.lastSeenAt) ? (
                    <span className="cell-note is-warning">
                      Not in the last sync · seen {formatDate(lease.lastSeenAt)}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>{lease.sourceStatus ?? 'Not provided'}</TableCell>
                <TableCell>{lease.startDate ? formatDate(lease.startDate) : '—'}</TableCell>
                <TableCell>
                  <LeaseEnd endDate={lease.endDate} />
                </TableCell>
                <TableCell>{formatDate(lease.scheduledMoveOutDate)}</TableCell>
              </TableRow>
            ))}
          </DataTable>
        ) : (
          <p>No relevant active leases were returned.</p>
        )}
        </section>
      </Card>
      <FloorPlanManager propertyId={item.id} canManage={permissions.has('properties:manage')} />
    </>
  );
}
