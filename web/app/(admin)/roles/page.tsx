'use client';

import type { AdminRoleSummary } from '@texasrenters/shared';
import { KeyRoundIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { RoleEditorDialog } from '@/components/role-editor-dialog';
import { EmptyState, ErrorState } from '@/components/states';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatPermission } from '@/lib/access';
import { usePermissions } from '@/lib/auth';
import { useAccessMutations, useRoles } from '@/lib/queries';
import { useUrlState } from '@/lib/url-state';

/** Beyond this a permission list stops being scannable and becomes a wall. */
const VISIBLE_PERMISSIONS = 6;

export default function RolesPage() {
  const canManage = usePermissions().has('roles:manage');
  const [state, setState] = useUrlState({ page: 1 });
  const [editing, setEditing] = useState<AdminRoleSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const roles = useRoles({ page: state.page, pageSize: 20 });
  const { deleteRole } = useAccessMutations();

  const columns: Array<Column<AdminRoleSummary>> = [
    {
      key: 'name',
      header: 'Role',
      primary: true,
      cell: (role) => (
        <span className="grid gap-0.5">
          <span className="font-medium">{role.name}</span>
          {role.description ? (
            <span className="text-muted-foreground text-xs">{role.description}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'permissions',
      header: 'Permissions',
      cell: (role) => (
        <div className="flex flex-wrap gap-1">
          {role.permissions.length ? (
            role.permissions.slice(0, VISIBLE_PERMISSIONS).map((permission) => (
              <Badge key={permission} variant="secondary">
                {formatPermission(permission)}
              </Badge>
            ))
          ) : (
            <span className="text-warning text-sm">No permissions</span>
          )}
          {role.permissions.length > VISIBLE_PERMISSIONS ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline">
                  +{role.permissions.length - VISIBLE_PERMISSIONS} more
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {role.permissions
                  .slice(VISIBLE_PERMISSIONS)
                  .map((permission) => formatPermission(permission))
                  .join(', ')}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      ),
    },
    {
      key: 'assigned',
      header: 'Assigned users',
      numeric: true,
      cell: (role) => role.assignedUserCount,
    },
  ];

  return (
    <>
      <PageHeader
        actions={canManage ? <Button onClick={() => setCreating(true)}>Create role</Button> : undefined}
        description="Fully customizable permission sets. Compose roles from the permission catalog, then assign them to users."
        title="Roles"
      />

      {creating ? <RoleEditorDialog onClose={() => setCreating(false)} /> : null}
      {editing ? <RoleEditorDialog onClose={() => setEditing(null)} role={editing} /> : null}

      {deleteRole.error ? (
        <Alert className="mb-4" variant="destructive">
          <AlertDescription>{deleteRole.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {roles.isLoading ? (
        <DataTableSkeleton columns={columns} hasActions label="Loading roles" rows={6} />
      ) : roles.isError ? (
        <ErrorState error={roles.error} retry={() => void roles.refetch()} />
      ) : !roles.data?.items.length ? (
        <EmptyState
          description={
            canManage
              ? 'Create your first role to start granting permissions. New users have no access until they are assigned a role.'
              : 'No custom roles have been created yet.'
          }
          icon={KeyRoundIcon}
          title="No roles yet"
        >
          {canManage ? <Button onClick={() => setCreating(true)}>Create role</Button> : null}
        </EmptyState>
      ) : (
        <>
          <DataTable
            // The one actions column in the app that mutates. A role has no
            // detail page — the editor is a dialog — so there is nowhere else
            // for these to live. They keep their own gate: `roles:manage`, plus
            // a confirmation that states what the deletion costs.
            actions={
              canManage
                ? (role) => (
                    <>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            aria-label={`Edit ${role.name}`}
                            onClick={() => setEditing(role)}
                            size="icon-sm"
                            variant="ghost"
                          >
                            <PencilIcon />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Edit role</TooltipContent>
                      </Tooltip>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            aria-label={`Delete ${role.name}`}
                            className="text-muted-foreground hover:text-destructive"
                            disabled={deleteRole.isPending}
                            size="icon-sm"
                            variant="ghost"
                          >
                            <Trash2Icon />
                          </Button>
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
                              className={buttonVariants({ variant: 'destructive' })}
                              onClick={() => void deleteRole.mutateAsync(role.id)}
                            >
                              Delete role
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </>
                  )
                : undefined
            }
            columns={columns}
            label="Custom roles"
            rowKey={(role) => role.id}
            rows={roles.data.items}
          />
          <Pagination
            onPage={(page) => setState({ page })}
            page={state.page}
            total={roles.data.total}
            totalPages={roles.data.totalPages}
          />
        </>
      )}
    </>
  );
}
