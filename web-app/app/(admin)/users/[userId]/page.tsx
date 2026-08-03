'use client';

import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert } from '@/components/ui/alert';
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
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button
                  className={buttonVariants({ variant: item.isActive ? 'danger' : 'primary' })}
                  disabled={updateUserStatus.isPending}
                >
                  {item.isActive ? 'Deactivate account' : 'Activate account'}
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {item.isActive ? 'Deactivate' : 'Activate'} {item.displayName}?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {item.isActive
                      ? 'They are signed out and lose access to every admin screen. Their roles are kept, so activating later restores the same permissions.'
                      : 'They regain access with the roles already assigned to this account.'}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className={buttonVariants({
                      variant: item.isActive ? 'danger' : 'primary',
                    })}
                    onClick={() => void toggleStatus()}
                  >
                    {item.isActive ? 'Deactivate' : 'Activate'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : undefined
        }
      />

      {updateUserStatus.error ? (
        <Alert variant="destructive" role="alert">
          {updateUserStatus.error.message}
        </Alert>
      ) : null}

      <Card className="p-[22px] max-[560px]:p-4" asChild>
        <section className="section-gap">
        <CardHeader className="p-0 pb-4">
          <div>
            <span className="block text-xs font-semibold text-muted-foreground">Identity</span>
            <CardTitle className="text-[17px]">Account</CardTitle>
          </div>
          <Badge value={item.isActive ? 'ACTIVE' : 'INACTIVE'} />
        </CardHeader>
        <dl className="grid grid-cols-3 gap-4 max-[560px]:grid-cols-1">
          <div className="flex flex-col gap-1.5 rounded-xl bg-background p-4">
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Effective permissions
            </dt>
            <dd>
              <div className="badge-wrap">
                {item.permissions.length ? (
                  item.permissions.map((permission) => (
                    <Badge key={permission} value={formatPermission(permission)} />
                  ))
                ) : (
                  <span className="text-[13px] text-muted-foreground">No permissions — assign a role below.</span>
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
            <span className="block text-xs font-semibold text-muted-foreground">Access control</span>
            <CardTitle className="text-[17px]">Role assignment</CardTitle>
            <CardDescription>
              Access is defined entirely by what you assign here. Changes take effect on the user’s
              next request.
            </CardDescription>
          </div>
        </CardHeader>

        {item.isSystemAdmin ? (
          <Alert variant="warning">
            This is the protected bootstrap administrator. It has every permission and cannot be
            changed through custom role assignment.
          </Alert>
        ) : (
          <fieldset className="permission-group" disabled={!canManage}>
            <legend>Assigned roles</legend>
            <p className="permission-group-hint">
              Effective access is the union of permissions in the selected roles.
            </p>
            {roles.isLoading ? (
              <p className="text-[13px] text-muted-foreground">Loading roles…</p>
            ) : roles.data?.items.length ? (
              <div className="permission-options">
                {roles.data.items.map((role) => (
                  <label key={role.id} className="permission-option">
                    <Checkbox
                      checked={roleIds.has(role.id)}
                      onCheckedChange={() => toggle(roleIds, setRoleIds, role.id)}
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
              <p className="text-[13px] text-muted-foreground">No custom roles exist yet.</p>
            )}
          </fieldset>
        )}

        {setUserRoles.error ? (
          <Alert variant="destructive" role="alert">
            {setUserRoles.error.message}
          </Alert>
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
