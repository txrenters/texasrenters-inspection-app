'use client';

import { Eye } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TableCell, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel } from '@/components/ui/field';
import { buttonVariants } from '@/components/ui/button';

import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  FilterToolbar,
  PageHeader,
  Pagination,
  RowAction,
  RowActions,
  TableLoadingState,
} from '@/components/shared';
import { UserCreateDialog } from '@/components/user-create-dialog';
import { usePermissions } from '@/lib/auth';
import { useUsers } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';

const USER_HEADERS = ['User', 'Email', 'Assigned roles', 'Status', ''];

// Radix Select rejects an empty string as an item value, so the unfiltered
// row carries a sentinel that is translated back to '' for the query.
const ALL = '__all__';

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
            <button className={buttonVariants({ variant: 'primary' })} onClick={() => setCreating(true)}>
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
        <Field className="flex-1">
          <FieldLabel htmlFor="user-search">Search name or email</FieldLabel>
          <Input
            id="user-search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search users..."
          />
        </Field>
        <Field className="w-[min(280px,100%)]">
          <FieldLabel htmlFor="user-active">Account status</FieldLabel>
          <Select
            onValueChange={(next) => {
              setActive(next === ALL ? '' : next);
              setPage(1);
            }}
            value={active || ALL}
          >
            <SelectTrigger id="user-active">
              <SelectValue placeholder="All accounts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All accounts</SelectItem>
              <SelectItem value="true">Active</SelectItem>
              <SelectItem value="false">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </Field>
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
              <TableRow key={user.id}>
                <TableCell>
                  <Link className="font-semibold text-primary" href={`/users/${user.id}`}>
                    {user.displayName}
                  </Link>
                </TableCell>
                <TableCell>{user.email}</TableCell>
                <TableCell>
                  <div className="badge-wrap">
                    {user.isSystemAdmin ? (
                      <Badge value="SYSTEM ADMINISTRATOR" />
                    ) : user.customRoles.length ? (
                      user.customRoles.map((role) => <Badge key={role.id} value={role.name} />)
                    ) : (
                      <span className="text-[13px] text-muted-foreground">None</span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge value={user.isActive ? 'ACTIVE' : 'INACTIVE'} />
                </TableCell>
                <TableCell>
                  <RowActions>
                    <RowAction
                      href={`/users/${user.id}`}
                      icon={<Eye aria-hidden className="size-4" />}
                      label="Open"
                    />
                  </RowActions>
                </TableCell>
              </TableRow>
            ))}
          </DataTable>
          <Pagination page={page} totalPages={users.data.totalPages} onPage={setPage} />
        </>
      )}
    </>
  );
}
