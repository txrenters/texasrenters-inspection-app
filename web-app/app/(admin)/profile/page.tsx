'use client';

import { Badge, PageHeader } from '@/components/shared';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

export default function ProfilePage() {
  const { profile } = useAuth();
  return (
    <>
      <PageHeader
        title="Profile"
        description="Your authenticated administrator identity and organization memberships."
      />
      <Card className="p-[22px] max-[560px]:p-4" asChild>
        <section>
        <div className="profile-heading">
          <div className="profile-avatar">{profile?.displayName.slice(0, 2).toUpperCase()}</div>
          <div>
            <CardTitle className="text-[17px]">{profile?.displayName}</CardTitle>
            <p>{profile?.email}</p>
            <Badge value={profile?.isActive ? 'ACTIVE' : 'INACTIVE'} />
          </div>
        </div>
        </section>
      </Card>
      <Card className="p-[22px] max-[560px]:p-4" asChild>
        <section className="section-gap">
        <CardHeader className="p-0 pb-4">
          <CardTitle className="text-[17px]">Memberships</CardTitle>
        </CardHeader>
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
      </Card>
    </>
  );
}
