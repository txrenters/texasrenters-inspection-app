'use client';

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
  TableLoadingState,
} from '@/components/shared';
import { TechnicianCreateDialog } from '@/components/technician-create-dialog';
import { usePermissions } from '@/lib/auth';
import { useTechnicians } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';

const TECHNICIAN_HEADERS = ['Technician', 'Email', 'Current', 'In progress', 'Completed', 'Status'];

// Radix Select rejects an empty string as an item value, so the unfiltered
// row carries a sentinel that is translated back to '' for the query.
const ALL = '__all__';

export default function TechniciansPage() {
  const canProvision = usePermissions().has('technicians:provision');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState('');
  const [creating, setCreating] = useState(false);
  const debouncedSearch = useDebouncedValue(search);
  const searchText = search.trim();
  const appliedSearchText = debouncedSearch.trim();
  const isSearchPending = searchText !== appliedSearchText;
  const hasActiveFilters = Boolean(searchText || active);
  const technicians = useTechnicians({
    page,
    pageSize: 20,
    search: debouncedSearch,
    active: active || undefined,
  });
  const isFilterPending = isSearchPending || technicians.isPlaceholderData;
  const visibleWorkload = technicians.data?.items.reduce(
    (summary, technician) => ({
      current: summary.current + (technician.workload?.current ?? 0),
      inProgress: summary.inProgress + (technician.workload?.inProgress ?? 0),
      completed: summary.completed + (technician.workload?.completed ?? 0),
    }),
    { current: 0, inProgress: 0, completed: 0 },
  );
  const resultLabel =
    isFilterPending || technicians.isFetching
      ? 'Searching technician accounts...'
      : technicians.isLoading
        ? 'Loading technician accounts...'
        : `${(technicians.data?.total ?? 0).toLocaleString()} technician accounts`;

  return (
    <>
      <PageHeader
        title="Technicians"
        description="Provision mobile accounts and manage assigned inspection workloads."
        action={
          canProvision ? (
            <button className={buttonVariants({ variant: 'primary' })} onClick={() => setCreating(true)}>
              Create technician
            </button>
          ) : undefined
        }
      />
      {creating ? <TechnicianCreateDialog onClose={() => setCreating(false)} /> : null}
      {visibleWorkload && !isFilterPending ? (
        <section className="workload-strip" aria-label="Visible technician workload">
          <div>
            <span>Current assignments</span>
            <strong>{visibleWorkload.current}</strong>
          </div>
          <div>
            <span>In progress</span>
            <strong>{visibleWorkload.inProgress}</strong>
          </div>
          <div>
            <span>Completed</span>
            <strong>{visibleWorkload.completed}</strong>
          </div>
          <small>Workload totals for the accounts shown on this page</small>
        </section>
      ) : null}
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
          <FieldLabel htmlFor="technician-search">Search name or email</FieldLabel>
          <Input
            id="technician-search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search technicians..."
          />
        </Field>
        <Field className="w-[min(280px,100%)]">
          <FieldLabel htmlFor="technician-active">Account status</FieldLabel>
          <Select
            onValueChange={(next) => {
              setActive(next === ALL ? '' : next);
              setPage(1);
            }}
            value={active || ALL}
          >
            <SelectTrigger id="technician-active">
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
      {technicians.isLoading || isFilterPending ? (
        <TableLoadingState
          headers={TECHNICIAN_HEADERS}
          label={isFilterPending ? 'Searching technicians' : 'Loading technicians'}
          rows={4}
        />
      ) : technicians.isError ? (
        <ErrorState error={technicians.error} retry={() => void technicians.refetch()} />
      ) : !technicians.data?.items.length ? (
        <EmptyState
          title="No technicians found"
          description={
            hasActiveFilters
              ? 'Adjust the search or account status filter to see matching technicians.'
              : 'Create a technician account to prepare mobile access. New accounts have no inspections until an administrator assigns one.'
          }
        />
      ) : (
        <>
          <DataTable headers={TECHNICIAN_HEADERS} label="Technician accounts and workloads">
            {technicians.data.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell>
                  <Link className="font-semibold text-primary" href={`/technicians/${item.id}`}>
                    {item.displayName}
                  </Link>
                </TableCell>
                <TableCell>{item.email}</TableCell>
                <TableCell className="numeric-cell">{item.workload?.current ?? 0}</TableCell>
                <TableCell className="numeric-cell">{item.workload?.inProgress ?? 0}</TableCell>
                <TableCell className="numeric-cell">{item.workload?.completed ?? 0}</TableCell>
                <TableCell>
                  <Badge value={item.isActive ? 'ACTIVE' : 'INACTIVE'} />
                </TableCell>
              </TableRow>
            ))}
          </DataTable>
          <Pagination page={page} totalPages={technicians.data.totalPages} onPage={setPage} />
        </>
      )}
    </>
  );
}
