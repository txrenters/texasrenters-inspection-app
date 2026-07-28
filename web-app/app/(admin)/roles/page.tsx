'use client';

import { useState } from 'react';
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
import { TableCell, TableRow } from '@/components/ui/table';
import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';

import type { AdminRoleSummary } from '@texasrenters/shared';

import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  TableLoadingState,
} from '@/components/shared';
import { RoleEditorDialog } from '@/components/role-editor-dialog';
import { usePermissions } from '@/lib/auth';
import { formatPermission } from '@/lib/access';
import { useRoles, useAccessMutations } from '@/lib/queries';

const ROLE_HEADERS = ['Role', 'Permissions', 'Assigned users', 'Actions'];

export default function RolesPage() {
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<AdminRoleSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const { has } = usePermissions();
  const canManage = has('roles:manage');
  const roles = useRoles({ page, pageSize: 20 });
  const { deleteRole } = useAccessMutations();

  async function remove(role: AdminRoleSummary) {
    await deleteRole.mutateAsync(role.id);
  }

  return (
    <>
      <PageHeader
        title="Roles"
        description="Fully customizable permission sets. Compose roles from the permission catalog, then assign them to users."
        action={
          canManage ? (
            <button className={buttonVariants({ variant: 'primary' })} onClick={() => setCreating(true)}>
              Create role
            </button>
          ) : undefined
        }
      />
      {creating ? <RoleEditorDialog onClose={() => setCreating(false)} /> : null}
      {editing ? <RoleEditorDialog role={editing} onClose={() => setEditing(null)} /> : null}
      {deleteRole.error ? (
        <Alert variant="destructive" role="alert">
          {deleteRole.error.message}
        </Alert>
      ) : null}
      {roles.isLoading ? (
        <TableLoadingState headers={ROLE_HEADERS} label="Loading roles" rows={4} />
      ) : roles.isError ? (
        <ErrorState error={roles.error} retry={() => void roles.refetch()} />
      ) : !roles.data?.items.length ? (
        <EmptyState
          title="No roles yet"
          description={
            canManage
              ? 'Create your first role to start granting permissions. New users have no access until they are assigned a role.'
              : 'No custom roles have been created yet.'
          }
        />
      ) : (
        <>
          <DataTable headers={ROLE_HEADERS} label="Custom roles">
            {roles.data.items.map((role) => (
              <TableRow key={role.id}>
                <TableCell>
                  <strong>{role.name}</strong>
                  {role.description ? <div className="text-[13px] text-muted-foreground">{role.description}</div> : null}
                </TableCell>
                <TableCell>
                  <div className="badge-wrap">
                    {role.permissions.length ? (
                      role.permissions
                        .slice(0, 6)
                        .map((permission) => (
                          <Badge key={permission} value={formatPermission(permission)} />
                        ))
                    ) : (
                      <span className="text-[13px] text-muted-foreground">No permissions</span>
                    )}
                    {role.permissions.length > 6 ? (
                      <span className="text-[13px] text-muted-foreground">+{role.permissions.length - 6} more</span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="numeric-cell">{role.assignedUserCount}</TableCell>
                <TableCell>
                  {canManage ? (
                    <div className="action-row">
                      <button className={buttonVariants({ variant: 'secondary' })} onClick={() => setEditing(role)}>
                        Edit
                      </button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <button
                            className={buttonVariants({ variant: 'danger' })}
                            disabled={deleteRole.isPending}
                          >
                            Delete
                          </button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete “{role.name}”?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This removes the role from {role.assignedUserCount} user
                              {role.assignedUserCount === 1 ? '' : 's'}. Those users lose every
                              permission this role granted until another role is assigned.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              className={buttonVariants({ variant: 'danger' })}
                              onClick={() => void remove(role)}
                            >
                              Delete role
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  ) : (
                    <span className="text-[13px] text-muted-foreground">View only</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </DataTable>
          <Pagination page={page} totalPages={roles.data.totalPages} onPage={setPage} />
        </>
      )}
    </>
  );
}
