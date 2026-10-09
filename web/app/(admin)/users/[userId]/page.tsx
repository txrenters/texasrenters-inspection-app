'use client';

import { MoreHorizontalIcon } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { CheckboxCard } from '@/components/checkbox-card';
import { DeleteAccountDialog } from '@/components/delete-account-dialog';
import { PageHeader } from '@/components/page-header';
import { ErrorState, PageSkeleton } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { formatPermission } from '@/lib/access';
import { usePermissions } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { useAccessMutations, useRoles, useUser } from '@/lib/queries';

export default function UserDetailPage() {
  const id = useParams<{ userId: string }>().userId;
  const router = useRouter();
  const permissions = usePermissions();
  const canManage = permissions.has('users:manage');
  // Provisioning a technician, done from the user page. The permission follows
  // the act rather than the screen, so this is the same grant that guards
  // creating one from scratch.
  const canProvisionTechnician = permissions.has('technicians:provision');
  const user = useUser(id);
  const roles = useRoles({ page: 1, pageSize: 100 });
  const { setUserRoles, updateUserStatus, deleteUser, grantTechnicianAccess } =
    useAccessMutations();

  const [roleIds, setRoleIds] = useState<Set<string>>(new Set());
  // Which confirmation the "More actions" menu opened. Held here because a
  // menu item closes its menu, and a dialog rendered inside it would go too.
  const [dialog, setDialog] = useState<'mobile' | 'delete' | null>(null);

  // Seed the editable selection once the account loads.
  useEffect(() => {
    if (user.data) setRoleIds(new Set(user.data.customRoles.map((role) => role.id)));
  }, [user.data]);

  const dirty = useMemo(() => {
    if (!user.data) return false;
    const currentRoleIds = user.data.customRoles.map((role) => role.id);
    return !(
      roleIds.size === currentRoleIds.length && currentRoleIds.every((roleId) => roleIds.has(roleId))
    );
  }, [user.data, roleIds]);

  // isError first: a failed fetch has no data either.
  if (user.isError) return <ErrorState error={user.error} retry={() => void user.refetch()} />;
  if (!user.data) return <PageSkeleton cards={2} />;
  const item = user.data;

  function toggleRole(roleId: string) {
    setRoleIds((current) => {
      const next = new Set(current);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  }

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

  async function remove() {
    try {
      await deleteUser.mutateAsync(id);
      // This page is about a record that no longer exists.
      router.push('/users');
    } catch {
      // The dialog renders the sanitized API error, including the reason the
      // account could not be deleted, so the confirmation stays open.
    }
  }

  async function grantHandsetAccess() {
    try {
      await grantTechnicianAccess.mutateAsync(id);
    } catch {
      // Rendered inline below, alongside the other mutation errors.
    }
  }

  return (
    <>
      <PageHeader
        actions={
          (canManage || canProvisionTechnician) && !item.isSystemAdmin ? (
            <>
              {/* One visible button, the rest one menu away, as on a
                  technician (console-development): Deactivate and Delete were
                  two solid red buttons side by side. Every confirmation below
                  is unchanged; the menu only opens it. */}
              {canManage ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      disabled={updateUserStatus.isPending}
                      variant={item.isActive ? 'outline' : 'default'}
                    >
                      {item.isActive ? 'Deactivate account' : 'Activate account'}
                    </Button>
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
                        className={
                          item.isActive ? buttonVariants({ variant: 'destructive' }) : undefined
                        }
                        onClick={() => void toggleStatus()}
                      >
                        {item.isActive ? 'Deactivate' : 'Activate'}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button aria-label="More actions" size="icon" variant="outline">
                    <MoreHorizontalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  {canProvisionTechnician ? (
                    <DropdownMenuItem
                      disabled={grantTechnicianAccess.isPending}
                      onSelect={() => setDialog('mobile')}
                    >
                      {grantTechnicianAccess.isPending ? 'Granting…' : 'Grant mobile access…'}
                    </DropdownMenuItem>
                  ) : null}
                  {canManage ? (
                    <>
                      {canProvisionTechnician ? <DropdownMenuSeparator /> : null}
                      <DropdownMenuItem
                        disabled={deleteUser.isPending}
                        onSelect={() => setDialog('delete')}
                        variant="destructive"
                      >
                        Delete…
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : undefined
        }
        badges={<StatusBadge value={item.isActive ? 'ACTIVE' : 'INACTIVE'} />}
        description={`${item.email} · created ${formatDateTime(item.createdAt)}`}
        info={
          <>
            <p>
              Access is defined entirely by the roles assigned here. Changes take effect on the
              user&apos;s next request.
            </p>
            <p>
              Effective permissions are the union of everything the assigned roles grant: what
              the account can actually do.
            </p>
          </>
        }
        infoLabel="How access works"
        title={item.displayName}
      />

      {canProvisionTechnician && !item.isSystemAdmin ? (
        <AlertDialog
          onOpenChange={(open) => setDialog(open ? 'mobile' : null)}
          open={dialog === 'mobile'}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Let {item.displayName} use the inspection app?</AlertDialogTitle>
              <AlertDialogDescription>
                They keep this one account and their current password — no temporary
                password is issued, and nothing about their console access changes. They
                will appear on the Technicians page and can be assigned inspections.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void grantHandsetAccess()}>
                Grant access
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {canManage && !item.isSystemAdmin ? (
        <DeleteAccountDialog
          displayName={item.displayName}
          error={deleteUser.error}
          id={id}
          isPending={deleteUser.isPending}
          onDelete={remove}
          onOpenChange={(open) => setDialog(open ? 'delete' : null)}
          open={dialog === 'delete'}
          scope="CONSOLE"
        />
      ) : null}

      {grantTechnicianAccess.error ? (
        <Alert className="mb-4" variant="destructive">
          <AlertDescription>{grantTechnicianAccess.error.message}</AlertDescription>
        </Alert>
      ) : null}
      {grantTechnicianAccess.data ? (
        <Alert className="mb-4">
          <AlertDescription>
            {grantTechnicianAccess.data.granted
              ? `${item.displayName} can now sign in to the inspection app with their existing password.`
              : `${item.displayName} already had mobile access.`}
          </AlertDescription>
        </Alert>
      ) : null}
      {updateUserStatus.error ? (
        <Alert className="mb-4" variant="destructive">
          <AlertDescription>{updateUserStatus.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {/* What you change first, then what it adds up to (console-development):
          the assignment was below a wall of permission names. */}
      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle variant="label">Role assignment</CardTitle>
          </CardHeader>
          <CardContent>
            {item.isSystemAdmin ? (
              <p className="text-muted-foreground text-sm">
                This is the protected bootstrap administrator. It has every permission and cannot
                be changed through custom role assignment.
              </p>
            ) : roles.isLoading ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {Array.from({ length: 4 }, (_, index) => (
                  <Skeleton className="h-14 rounded-lg" key={index} />
                ))}
              </div>
            ) : roles.isError ? (
              // A failed list is not an empty one: "No custom roles exist yet"
              // over a failed request sent people off to create roles that
              // already existed (console-development).
              <ErrorState error={roles.error} retry={() => void roles.refetch()} />
            ) : roles.data?.items.length ? (
              <fieldset className="grid gap-2 sm:grid-cols-2" disabled={!canManage}>
                <legend className="sr-only">Assigned roles</legend>
                {roles.data.items.map((role) => (
                  <CheckboxCard
                    checked={roleIds.has(role.id)}
                    description={
                      role.description ??
                      `${role.permissions.length} permission${role.permissions.length === 1 ? '' : 's'}`
                    }
                    disabled={!canManage}
                    key={role.id}
                    onCheckedChange={() => toggleRole(role.id)}
                    title={role.name}
                  />
                ))}
              </fieldset>
            ) : (
              <p className="text-muted-foreground text-sm">No custom roles exist yet.</p>
            )}

            {setUserRoles.error ? (
              <Alert className="mt-4" variant="destructive">
                <AlertDescription>{setUserRoles.error.message}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>

          {canManage && !item.isSystemAdmin ? (
            <CardFooter className="justify-end gap-2 border-t">
              {/* Discard appears only once something has changed — a permanently
                  visible "Cancel" beside a disabled Save is two dead controls. */}
              {dirty ? (
                <Button
                  onClick={() => setRoleIds(new Set(item.customRoles.map((role) => role.id)))}
                  variant="ghost"
                >
                  Discard changes
                </Button>
              ) : null}
              <Button disabled={!dirty || setUserRoles.isPending} onClick={() => void save()}>
                {setUserRoles.isPending ? <Spinner /> : null}
                {setUserRoles.isPending ? 'Saving…' : 'Save role assignment'}
              </Button>
            </CardFooter>
          ) : null}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle variant="label">Effective permissions</CardTitle>
          </CardHeader>
          <CardContent>
            {item.permissions.length ? (
              <div className="flex flex-wrap gap-1.5">
                {item.permissions.map((permission) => (
                  <Badge key={permission} variant="outline">
                    {formatPermission(permission)}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                No permissions. This account can sign in and reach nothing until a role is
                assigned above.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
