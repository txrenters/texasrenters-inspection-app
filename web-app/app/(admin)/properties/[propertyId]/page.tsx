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
        <DataTable headers={['Unit', 'Bedrooms', 'Bathrooms', 'Status', 'Last synchronized']}>
          {item.units?.map((unit) => (
            <tr key={unit.id}>
              <td>{unit.name}</td>
              <td>{unit.bedrooms ?? 'Not provided'}</td>
              <td>{unit.bathrooms ?? 'Not provided'}</td>
              <td>
                <Badge value={unit.isActive ? 'ACTIVE' : 'INACTIVE'} />
              </td>
              <td>{formatDate(unit.lastSyncedAt)}</td>
            </tr>
          ))}
        </DataTable>
      </section>
      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-header">
          <h2>Relevant leases</h2>
        </div>
        {item.leases?.length ? (
          <DataTable headers={['Lease', 'Status', 'Scheduled move-out']}>
            {item.leases.map((lease) => (
              <tr key={lease.id}>
                <td>{lease.leaseName ?? lease.externalId}</td>
                <td>{lease.sourceStatus ?? 'Not provided'}</td>
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
