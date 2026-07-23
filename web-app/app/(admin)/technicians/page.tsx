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
import { TechnicianCreateDialog } from '@/components/technician-create-dialog';
import { usePermissions } from '@/lib/auth';
import { useTechnicians } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';

const TECHNICIAN_HEADERS = ['Technician', 'Email', 'Current', 'In progress', 'Completed', 'Status'];

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
            <button className="button button-primary" onClick={() => setCreating(true)}>
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
        <div className="field field-grow">
          <label htmlFor="technician-search">Search name or email</label>
          <input
            id="technician-search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search technicians..."
          />
        </div>
        <div className="field field-medium">
          <label htmlFor="technician-active">Account status</label>
          <select
            id="technician-active"
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
              <tr key={item.id}>
                <td>
                  <Link className="table-link" href={`/technicians/${item.id}`}>
                    {item.displayName}
                  </Link>
                </td>
                <td>{item.email}</td>
                <td className="numeric-cell">{item.workload?.current ?? 0}</td>
                <td className="numeric-cell">{item.workload?.inProgress ?? 0}</td>
                <td className="numeric-cell">{item.workload?.completed ?? 0}</td>
                <td>
                  <Badge value={item.isActive ? 'ACTIVE' : 'INACTIVE'} />
                </td>
              </tr>
            ))}
          </DataTable>
          <Pagination page={page} totalPages={technicians.data.totalPages} onPage={setPage} />
        </>
      )}
    </>
  );
}
