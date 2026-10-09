'use client';

import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatPermission } from '@/lib/access';
import { useAuth } from '@/lib/auth';
import { humanize, initials } from '@/lib/format';

export default function ProfilePage() {
  const { profile } = useAuth();

  return (
    <>
      {/* Who you are is the page's title (console-development): a "Profile"
          heading over a card that said the name again was the same fact
          twice. The avatar stays beside the name, in the calm muted tile
          rather than an ink block. */}
      <div className="flex items-start gap-3">
        <Avatar className="mt-0.5 size-9 rounded-lg">
          <AvatarFallback className="bg-muted text-foreground rounded-lg text-sm font-semibold">
            {initials(profile?.displayName ?? '')}
          </AvatarFallback>
        </Avatar>
        <PageHeader
          badges={profile ? <StatusBadge value={profile.isActive ? 'ACTIVE' : 'INACTIVE'} /> : undefined}
          className="min-w-0 flex-1"
          description={profile?.email ?? ''}
          info="Your signed-in administrator identity, the organizations you belong to, and the permissions your roles add up to."
          infoLabel="About your profile"
          title={profile?.displayName || 'Profile'}
        />
      </div>

      <div className="mt-1 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle variant="label">Memberships</CardTitle>
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
                  {/* A role is a name, not a status: no dot (console-development). */}
                  <span className="text-muted-foreground shrink-0 text-sm">{humanize(membership.role)}</span>
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
            <CardTitle variant="label">Effective permissions</CardTitle>
          </CardHeader>
          <CardContent>
            {profile?.permissions.length ? (
              <div className="flex flex-wrap gap-1.5">
                {profile.permissions.map((permission) => (
                  <Badge key={permission} variant="outline">
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
