'use client';

import { useState } from 'react';

import type { AdminRoleSummary } from '@texasrenters/shared';

import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  TableLoadingState,
} from '@/components/ui';
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
    if (
      !window.confirm(
        `Delete “${role.name}”? It will be removed from ${role.assignedUserCount} user(s).`,
      )
    )
      return;
    await deleteRole.mutateAsync(role.id);
  }

  return (
    <>
      <PageHeader
        title="Roles"
        description="Fully customizable permission sets. Compose roles from the permission catalog, then assign them to users."
        action={
          canManage ? (
            <button className="button button-primary" onClick={() => setCreating(true)}>
              Create role
            </button>
          ) : undefined
        }
      />
      {creating ? <RoleEditorDialog onClose={() => setCreating(false)} /> : null}
      {editing ? <RoleEditorDialog role={editing} onClose={() => setEditing(null)} /> : null}
      {deleteRole.error ? (
        <div className="alert alert-danger" role="alert">
          {deleteRole.error.message}
        </div>
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
              <tr key={role.id}>
                <td>
                  <strong>{role.name}</strong>
                  {role.description ? <div className="media-meta">{role.description}</div> : null}
                </td>
                <td>
                  <div className="badge-wrap">
                    {role.permissions.length ? (
                      role.permissions
                        .slice(0, 6)
                        .map((permission) => (
                          <Badge key={permission} value={formatPermission(permission)} />
                        ))
                    ) : (
                      <span className="media-meta">No permissions</span>
                    )}
                    {role.permissions.length > 6 ? (
                      <span className="media-meta">+{role.permissions.length - 6} more</span>
                    ) : null}
                  </div>
                </td>
                <td className="numeric-cell">{role.assignedUserCount}</td>
                <td>
                  {canManage ? (
                    <div className="action-row">
                      <button className="button button-secondary" onClick={() => setEditing(role)}>
                        Edit
                      </button>
                      <button
                        className="button button-danger"
                        disabled={deleteRole.isPending}
                        onClick={() => void remove(role)}
                      >
                        Delete
                      </button>
                    </div>
                  ) : (
                    <span className="media-meta">View only</span>
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
          <Pagination page={page} totalPages={roles.data.totalPages} onPage={setPage} />
        </>
      )}
    </>
  );
}
