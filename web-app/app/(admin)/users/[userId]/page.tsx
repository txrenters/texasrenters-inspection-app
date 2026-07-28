'use client';

import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { buttonVariants } from '@/components/ui/button';

import { Badge, ErrorState, LoadingState, PageHeader, formatDate } from '@/components/shared';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { usePermissions } from '@/lib/auth';
import { formatPermission } from '@/lib/access';
import { useRoles, useUser, useAccessMutations } from '@/lib/queries';

export default function UserDetailPage() {
  const id = useParams<{ userId: string }>().userId;
  const { has } = usePermissions();
  const canManage = has('users:manage');
  const user = useUser(id);
  const roles = useRoles({ page: 1, pageSize: 100 });
  const { setUserRoles, updateUserStatus } = useAccessMutations();

  const [roleIds, setRoleIds] = useState<Set<string>>(new Set());

  // Seed the editable selection once the account loads.
  useEffect(() => {
    if (user.data) {
      setRoleIds(new Set(user.data.customRoles.map((role) => role.id)));
    }
  }, [user.data]);

  const dirty = useMemo(() => {
    if (!user.data) return false;
    const currentRoleIds = user.data.customRoles.map((role) => role.id);
    const sameCustom =
      roleIds.size === currentRoleIds.length &&
      currentRoleIds.every((roleId) => roleIds.has(roleId));
    return !sameCustom;
  }, [user.data, roleIds]);

  if (user.isLoading) return <LoadingState label="Loading user…" />;
  if (user.isError) return <ErrorState error={user.error} retry={() => void user.refetch()} />;
  const item = user.data!;

  const toggle = (set: Set<string>, apply: (next: Set<string>) => void, value: string) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };

  async function save() {
    try {
      await setUserRoles.mutateAsync({ id, roleIds: [...roleIds] });
    } catch {
      // The mutation surfaces the sanitized API error inline.
    }
  }

  async function toggleStatus() {
    const verb = item.isActive ? 'deactivate' : 'activate';
    if (!window.confirm(`Are you sure you want to ${verb} ${item.displayName}?`)) return;
    try {
      await updateUserStatus.mutateAsync({ id, isActive: !item.isActive });
    } catch {
      // The mutation surfaces the sanitized API error inline.
    }
  }

  return (
    <>
      <PageHeader
        title={item.displayName}
        description={`${item.email} · created ${formatDate(item.createdAt)}`}
        breadcrumbs={[{ label: 'Users', href: '/users' }, { label: 'Detail' }]}
        action={
          canManage && !item.isSystemAdmin ? (
            <button
              className={buttonVariants({ variant: item.isActive ? 'danger' : 'primary' })}
              disabled={updateUserStatus.isPending}
              onClick={() => void toggleStatus()}
            >
              {item.isActive ? 'Deactivate account' : 'Activate account'}
            </button>
          ) : undefined
        }
      />

      {updateUserStatus.error ? (
        <div className="alert alert-danger" role="alert">
          {updateUserStatus.error.message}
        </div>
      ) : null}

      <Card className="p-[22px] max-[560px]:p-4" asChild>
        <section className="section-gap">
        <CardHeader className="p-0 pb-4">
          <div>
            <span className="section-kicker">Identity</span>
            <CardTitle className="text-[17px]">Account</CardTitle>
          </div>
          <Badge value={item.isActive ? 'ACTIVE' : 'INACTIVE'} />
        </CardHeader>
        <dl className="detail-grid">
          <div className="detail-item">
            <dt>Effective permissions</dt>
            <dd>
              <div className="badge-wrap">
                {item.permissions.length ? (
                  item.permissions.map((permission) => (
                    <Badge key={permission} value={formatPermission(permission)} />
                  ))
                ) : (
                  <span className="media-meta">No permissions — assign a role below.</span>
                )}
              </div>
            </dd>
          </div>
        </dl>
        </section>
      </Card>

      <Card className="p-[22px] max-[560px]:p-4" asChild>
        <section className="section-gap">
        <CardHeader className="p-0 pb-4">
          <div>
            <span className="section-kicker">Access control</span>
            <CardTitle className="text-[17px]">Role assignment</CardTitle>
            <CardDescription>
              Access is defined entirely by what you assign here. Changes take effect on the user’s
              next request.
            </CardDescription>
          </div>
        </CardHeader>

        {item.isSystemAdmin ? (
          <div className="alert alert-warning">
            This is the protected bootstrap administrator. It has every permission and cannot be
            changed through custom role assignment.
          </div>
        ) : (
          <fieldset className="permission-group" disabled={!canManage}>
            <legend>Assigned roles</legend>
            <p className="permission-group-hint">
              Effective access is the union of permissions in the selected roles.
            </p>
            {roles.isLoading ? (
              <p className="media-meta">Loading roles…</p>
            ) : roles.data?.items.length ? (
              <div className="permission-options">
                {roles.data.items.map((role) => (
                  <label key={role.id} className="permission-option">
                    <input
                      type="checkbox"
                      checked={roleIds.has(role.id)}
                      onChange={() => toggle(roleIds, setRoleIds, role.id)}
                    />
                    <span>
                      <strong>{role.name}</strong>
                      <small>
                        {role.description ?? `${role.permissions.length} permission(s)`}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="media-meta">No custom roles exist yet.</p>
            )}
          </fieldset>
        )}

        {setUserRoles.error ? (
          <div className="alert alert-danger" role="alert">
            {setUserRoles.error.message}
          </div>
        ) : null}

        {canManage && !item.isSystemAdmin ? (
          <div className="form-actions">
            <button
              className={buttonVariants({ variant: 'primary' })}
              disabled={!dirty || setUserRoles.isPending}
              onClick={() => void save()}
            >
              {setUserRoles.isPending ? 'Saving…' : 'Save role assignment'}
            </button>
          </div>
        ) : null}
        </section>
      </Card>
    </>
  );
}
