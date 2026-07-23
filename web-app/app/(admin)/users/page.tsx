'use client';

import Link from 'next/link';
import { useState } from 'react';

import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  FilterToolbar,
  PageHeader,
  Pagination,
  TableLoadingState,
} from '@/components/ui';
import { UserCreateDialog } from '@/components/user-create-dialog';
import { usePermissions } from '@/lib/auth';
import { useUsers } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';

const USER_HEADERS = ['User', 'Email', 'Assigned roles', 'Status'];

export default function UsersPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState('');
  const [creating, setCreating] = useState(false);
  const { has } = usePermissions();
  const canManage = has('users:manage');
  const debouncedSearch = useDebouncedValue(search);
  const isSearchPending = search.trim() !== debouncedSearch.trim();
  const hasActiveFilters = Boolean(search.trim() || active);
  const users = useUsers({
    page,
    pageSize: 20,
    search: debouncedSearch,
    active: active || undefined,
  });
  const isFilterPending = isSearchPending || users.isPlaceholderData;
  const resultLabel =
    isFilterPending || users.isFetching
      ? 'Searching users...'
      : users.isLoading
        ? 'Loading users...'
        : `${(users.data?.total ?? 0).toLocaleString()} users`;

  return (
    <>
      <PageHeader
        title="Users"
        description="Provision web accounts and assign fully customizable roles. New users have no access until a role is assigned."
        action={
          canManage ? (
            <button className="button button-primary" onClick={() => setCreating(true)}>
              Create user
            </button>
          ) : undefined
        }
      />
      {creating ? <UserCreateDialog onClose={() => setCreating(false)} /> : null}
      <FilterToolbar
        resultLabel={resultLabel}
        onClear={
          hasActiveFilters
            ? () => {
                setSearch('');
                setActive('');
                setPage(1);
              }
            : undefined
        }
      >
        <div className="field field-grow">
          <label htmlFor="user-search">Search name or email</label>
          <input
            id="user-search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search users..."
          />
        </div>
        <div className="field field-medium">
          <label htmlFor="user-active">Account status</label>
          <select
            id="user-active"
            value={active}
            onChange={(event) => {
              setActive(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All accounts</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
        </div>
      </FilterToolbar>
      {users.isLoading || isFilterPending ? (
        <TableLoadingState headers={USER_HEADERS} label="Loading users" rows={4} />
      ) : users.isError ? (
        <ErrorState error={users.error} retry={() => void users.refetch()} />
      ) : !users.data?.items.length ? (
        <EmptyState
          title="No users found"
          description={
            hasActiveFilters
              ? 'Adjust the search or status filter to see matching users.'
              : 'Create a user account to grant access. Roles determine everything the account can do.'
          }
        />
      ) : (
        <>
          <DataTable headers={USER_HEADERS} label="User accounts">
            {users.data.items.map((user) => (
              <tr key={user.id}>
                <td>
                  <Link className="table-link" href={`/users/${user.id}`}>
                    {user.displayName}
                  </Link>
                </td>
                <td>{user.email}</td>
                <td>
                  <div className="badge-wrap">
                    {user.isSystemAdmin ? (
                      <Badge value="SYSTEM ADMINISTRATOR" />
                    ) : user.customRoles.length ? (
                      user.customRoles.map((role) => <Badge key={role.id} value={role.name} />)
                    ) : (
                      <span className="media-meta">None</span>
                    )}
                  </div>
                </td>
                <td>
                  <Badge value={user.isActive ? 'ACTIVE' : 'INACTIVE'} />
                </td>
              </tr>
            ))}
          </DataTable>
          <Pagination page={page} totalPages={users.data.totalPages} onPage={setPage} />
        </>
      )}
    </>
  );
}
