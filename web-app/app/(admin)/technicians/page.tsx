'use client';

import Link from 'next/link';
import { useState } from 'react';

import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  TableLoadingState,
} from '@/components/ui';
import { TechnicianCreateDialog } from '@/components/technician-create-dialog';
import { useTechnicians } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';

const TECHNICIAN_HEADERS = ['Technician', 'Email', 'Current', 'In progress', 'Completed', 'Status'];

export default function TechniciansPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState('');
  const [creating, setCreating] = useState(false);
  const debouncedSearch = useDebouncedValue(search);
  const technicians = useTechnicians({
    page,
    pageSize: 20,
    search: debouncedSearch,
    active: active || undefined,
  });
  return (
    <>
      <PageHeader
        title="Technicians"
        description="Provision mobile accounts and manage assigned inspection workloads."
        action={
          <button className="button button-primary" onClick={() => setCreating(true)}>
            Create technician
          </button>
        }
      />
      {creating ? <TechnicianCreateDialog onClose={() => setCreating(false)} /> : null}
      <div className="filter-bar">
        <div className="field field-grow">
          <label htmlFor="technician-search">Search name or email</label>
          <input
            id="technician-search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search technicians…"
          />
        </div>
        <div className="field">
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
      </div>
      {technicians.isLoading ? (
        <TableLoadingState headers={TECHNICIAN_HEADERS} label="Loading technicians" />
      ) : technicians.isError ? (
        <ErrorState error={technicians.error} retry={() => void technicians.refetch()} />
      ) : !technicians.data?.items.length ? (
        <EmptyState
          title="No technicians found"
          description="Create a technician account to prepare mobile access. New accounts have no inspections until an administrator assigns one."
        />
      ) : (
        <>
          <DataTable headers={TECHNICIAN_HEADERS}>
            {technicians.data.items.map((item) => (
              <tr key={item.id}>
                <td>
                  <Link className="table-link" href={`/technicians/${item.id}`}>
                    {item.displayName}
                  </Link>
                </td>
                <td>{item.email}</td>
                <td>{item.workload?.current ?? 0}</td>
                <td>{item.workload?.inProgress ?? 0}</td>
                <td>{item.workload?.completed ?? 0}</td>
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
