'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';

import {
  Badge,
  DataTable,
  ErrorState,
  LoadingState,
  PageHeader,
  address,
  formatDate,
} from '@/components/ui';
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
            <Link className="button button-primary" href={`/inspections/new?propertyId=${item.id}`}>
              Create inspection
            </Link>
          ) : (
            <Badge value="INACTIVE" />
          )
        }
      />
      <section className="panel">
        <div className="detail-grid">
          <div className="detail-item">
            <span>Portfolio</span>
            <strong>{item.portfolio.name}</strong>
          </div>
          <div className="detail-item">
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
          <div className="detail-item">
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
          <div className="detail-item">
            <span>Source status</span>
            <strong>{item.sourceStatus ?? 'Not provided'}</strong>
          </div>
          <div className="detail-item">
            <span>External reference</span>
            <strong>{item.externalId}</strong>
          </div>
          <div className="detail-item">
            <span>Last synchronized</span>
            <strong>{formatDate(item.lastSyncedAt)}</strong>
          </div>
        </div>
      </section>
      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-header">
          <h2>Active units</h2>
        </div>
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
            <tr key={unit.id}>
              <td>{unit.name}</td>
              <td>{unit.bedrooms ?? 'Not provided'}</td>
              <td>{unit.bathrooms ?? 'Not provided'}</td>
              <td>{unit.leaseStatus ?? 'No relevant lease'}</td>
              <td>
                <LeaseEnd endDate={unit.leaseEndDate} />
              </td>
              <td>{unit.scheduledMoveOutDate ? formatDate(unit.scheduledMoveOutDate) : '—'}</td>
              <td>
                <Badge value={unit.isActive ? 'ACTIVE' : 'INACTIVE'} />
              </td>
            </tr>
          ))}
        </DataTable>
      </section>
      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-header">
          <h2>Relevant leases</h2>
        </div>
        {item.leases?.length ? (
          <DataTable headers={['Lease', 'Status', 'Term start', 'Term ends', 'Scheduled move-out']}>
            {item.leases.map((lease) => (
              <tr key={lease.id}>
                <td>{lease.leaseName ?? lease.externalId}</td>
                <td>{lease.sourceStatus ?? 'Not provided'}</td>
                <td>{lease.startDate ? formatDate(lease.startDate) : '—'}</td>
                <td>
                  <LeaseEnd endDate={lease.endDate} />
                </td>
                <td>{formatDate(lease.scheduledMoveOutDate)}</td>
              </tr>
            ))}
          </DataTable>
        ) : (
          <p>No relevant active leases were returned.</p>
        )}
      </section>
      <FloorPlanManager propertyId={item.id} canManage={permissions.has('properties:manage')} />
    </>
  );
}
