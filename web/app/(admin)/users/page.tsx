'use client';

import { UserRoundIcon } from 'lucide-react';
import { useState } from 'react';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { ListToolbar, SelectFilter } from '@/components/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { EmptyState, ErrorState } from '@/components/states';
import { PresenceIndicator } from '@/components/presence-indicator';
import { StatusBadge } from '@/components/status-badge';
import { UserCreateDialog } from '@/components/user-create-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { usePermissions } from '@/lib/auth';
import { useUsers } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useUrlState } from '@/lib/url-state';

type UserRow = NonNullable<ReturnType<typeof useUsers>['data']>['items'][number];

const STATUS_OPTIONS = [
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Inactive' },
];

const COLUMNS: Array<Column<UserRow>> = [
  { key: 'name', header: 'User', primary: true, cell: (row) => row.displayName },
  {
    key: 'email',
    header: 'Email',
    hideBelow: 'md',
    cell: (row) => <span className="text-muted-foreground">{row.email}</span>,
  },
  {
    key: 'roles',
    header: 'Assigned roles',
    cell: (row) => (
      <div className="flex flex-wrap gap-1">
        {row.isSystemAdmin ? (
          <Badge variant="info">System administrator</Badge>
        ) : row.customRoles.length ? (
          row.customRoles.map((role) => (
            <Badge key={role.id} variant="secondary">
              {role.name}
            </Badge>
          ))
        ) : (
          // Said in words rather than left blank: an account with no role can
          // sign in and reach nothing, which looks like a broken app.
          <span className="text-warning text-sm">No access</span>
        )}
      </div>
    ),
  },
  {
    key: 'presence',
    header: 'Console',
    cell: (row) => <PresenceIndicator isOnline={row.isOnline} lastSeenAt={row.lastSeenAt} />,
  },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => <StatusBadge value={row.isActive ? 'ACTIVE' : 'INACTIVE'} />,
  },
];

export default function UsersPage() {
  const canManage = usePermissions().has('users:manage');
  const [creating, setCreating] = useState(false);
  const [state, setState, reset] = useUrlState({ page: 1, q: '', active: '' });

  const debouncedSearch = useDebouncedValue(state.q);
  const isSearchPending = state.q.trim() !== debouncedSearch.trim();

  const users = useUsers({
    page: state.page,
    pageSize: 20,
    search: debouncedSearch,
    active: state.active || undefined,
  });

  const busy = users.isLoading || isSearchPending || users.isPlaceholderData;
  const hasActiveFilters = Boolean(state.q.trim() || state.active);
  const resultLabel = busy
    ? 'Searching users…'
    : `${(users.data?.total ?? 0).toLocaleString()} users`;

  return (
    <>
      <PageHeader
        actions={canManage ? <Button onClick={() => setCreating(true)}>Create user</Button> : undefined}
        description="Provision web accounts and assign fully customizable roles. New users have no access until a role is assigned."
        title="Users"
      />

      {creating ? <UserCreateDialog onClose={() => setCreating(false)} /> : null}

      <ListToolbar
        activeFilters={
          state.active
            ? [
                {
                  label: 'Status',
                  value: state.active === 'true' ? 'Active' : 'Inactive',
                  onRemove: () => setState({ active: '', page: 1 }),
                },
              ]
            : []
        }
        filters={
          <SelectFilter
            allLabel="All accounts"
            label="Account status"
            onChange={(active) => setState({ active, page: 1 })}
            options={STATUS_OPTIONS}
            value={state.active}
          />
        }
        onClear={reset}
        onSearch={(q) => setState({ q, page: 1 })}
        pending={isSearchPending}
        resultLabel={resultLabel}
        search={state.q}
        searchLabel="Search user name or email"
        searchPlaceholder="Search users…"
      />

      {busy ? (
        <DataTableSkeleton columns={COLUMNS} label="Loading users" rows={8} />
      ) : users.isError ? (
        <ErrorState error={users.error} retry={() => void users.refetch()} />
      ) : !users.data?.items.length ? (
        <EmptyState
          description={
            hasActiveFilters
              ? 'Adjust the search or status filter to see matching users.'
              : 'Create a user account to grant access. Roles determine everything the account can do.'
          }
          icon={UserRoundIcon}
          title="No users found"
        >
          {hasActiveFilters ? (
            <Button onClick={reset} variant="outline">
              Clear filters
            </Button>
          ) : canManage ? (
            <Button onClick={() => setCreating(true)}>Create user</Button>
          ) : null}
        </EmptyState>
      ) : (
        <>
          <DataTable
            columns={COLUMNS}
            label="User accounts"
            rowHref={(row) => `/users/${row.id}`}
            rowKey={(row) => row.id}
            rows={users.data.items}
          />
          <Pagination
            onPage={(page) => setState({ page })}
            page={state.page}
            total={users.data.total}
            totalPages={users.data.totalPages}
          />
        </>
      )}
    </>
  );
}
