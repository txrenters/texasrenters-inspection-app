'use client';

import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatPermission } from '@/lib/access';
import { useAuth } from '@/lib/auth';
import { initials } from '@/lib/format';

export default function ProfilePage() {
  const { profile } = useAuth();

  return (
    <>
      <PageHeader
        description="Your authenticated administrator identity and organization memberships."
        title="Profile"
      />

      <Card>
        <CardContent className="flex flex-wrap items-center gap-4">
          <Avatar className="size-14 rounded-lg">
            <AvatarFallback className="bg-primary text-primary-foreground rounded-lg text-lg font-semibold">
              {initials(profile?.displayName ?? '')}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 space-y-1">
            <p className="text-lg font-semibold tracking-tight">{profile?.displayName}</p>
            <p className="text-muted-foreground text-sm break-all">{profile?.email}</p>
          </div>
          <div className="ml-auto">
            <StatusBadge value={profile?.isActive ? 'ACTIVE' : 'INACTIVE'} />
          </div>
        </CardContent>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Memberships</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {profile?.memberships.map((membership) => (
                <li
                  className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  key={`${membership.organization.id}-${membership.role}`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{membership.organization.name}</p>
                    <p className="text-muted-foreground truncate font-mono text-xs">
                      {membership.organization.id}
                    </p>
                  </div>
                  <StatusBadge value={membership.role} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {/* New here. The old profile screen showed memberships but never the
            permissions they resolve to, so "why can I not see Charges?" had no
            answer anywhere in the app. */}
        <Card>
          <CardHeader>
            <CardTitle>Effective permissions</CardTitle>
          </CardHeader>
          <CardContent>
            {profile?.permissions.length ? (
              <div className="flex flex-wrap gap-1.5">
                {profile.permissions.map((permission) => (
                  <Badge key={permission} variant="secondary">
                    {formatPermission(permission)}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                No custom permissions. Everything you can reach comes from a built-in role.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
