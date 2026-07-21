'use client';

import { Badge, PageHeader } from '@/components/ui';
import { useAuth } from '@/lib/auth';

export default function ProfilePage() {
  const { profile } = useAuth();
  return (
    <>
      <PageHeader
        title="Profile"
        description="Your authenticated administrator identity and organization memberships."
      />
      <section className="panel">
        <div className="profile-heading">
          <div className="profile-avatar">{profile?.displayName.slice(0, 2).toUpperCase()}</div>
          <div>
            <h2>{profile?.displayName}</h2>
            <p>{profile?.email}</p>
            <Badge value={profile?.isActive ? 'ACTIVE' : 'INACTIVE'} />
          </div>
        </div>
      </section>
      <section className="panel section-gap">
        <div className="panel-header">
          <h2>Memberships</h2>
        </div>
        <div className="stack">
          {profile?.memberships.map((membership) => (
            <div
              className="membership-row"
              key={`${membership.organization.id}-${membership.role}`}
            >
              <div>
                <strong>{membership.organization.name}</strong>
                <small>{membership.organization.id}</small>
              </div>
              <Badge value={membership.role} />
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
