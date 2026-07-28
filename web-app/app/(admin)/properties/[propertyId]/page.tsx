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
          <div className="rounded-xl bg-background p-3.5">
            <span>Portfolio</span>
            <strong>{item.portfolio.name}</strong>
          </div>
          <div className="rounded-xl bg-background p-3.5">
            <span>Total area</span>
            <strong>{item.totalArea?.label ?? 'Not provided'}</strong>
            <small>
              {item.totalArea?.source === 'PROPERTYWARE_BUILDING'
                ? 'From Propertyware'
                : item.totalArea?.source === 'MANUAL'
                  ? 'Entered manually'
                  : item.totalArea?.derived
                    ? 'Derived from units'
                    : 'No reliable value'}
            </small>
          </div>
          <div className="rounded-xl bg-background p-3.5">
            <span>Lease summary</span>
            <strong>{item.leaseSummary?.summary ?? 'Lease data not synchronized'}</strong>
            {item.leaseSummary?.leaseDataAvailable === false ? (
              // Never let missing data read as "this property has no lease".
              <small className="detail-warning">
                No units have synchronized for this property, so lease status is unknown
              </small>
            ) : item.leaseSummary?.nextLeaseEndDate ? (
              <small>
                Next lease ends {formatDate(item.leaseSummary.nextLeaseEndDate)} ·{' '}
                {leaseExpiryLabel(item.leaseSummary.nextLeaseEndDate).toLowerCase()}
              </small>
            ) : (
              <small>No upcoming lease end date</small>
            )}
          </div>
          <div className="rounded-xl bg-background p-3.5">
            <span>Source status</span>
            <strong>{item.sourceStatus ?? 'Not provided'}</strong>
          </div>
          <div className="rounded-xl bg-background p-3.5">
            <span>External reference</span>
            <strong>{item.externalId}</strong>
          </div>
          <div className="rounded-xl bg-background p-3.5">
            <span>Last synchronized</span>
            <strong>{formatDate(item.lastSyncedAt)}</strong>
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
                <TableCell>{lease.leaseName ?? lease.externalId}</TableCell>
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
