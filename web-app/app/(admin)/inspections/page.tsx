'use client';

import Link from 'next/link';
import { useState } from 'react';
import { InspectionType } from '@texasrenters/shared';
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
  formatDate,
} from '@/components/shared';
import { usePermissions } from '@/lib/auth';
import { useInspections } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';

const INSPECTION_HEADERS = [
  'Property',
  'Unit',
  'Type',
  'Scheduled',
  'Priority',
  'Status',
  'Assignment',
  'Technician',
];

export default function InspectionsPage() {
  const canManage = usePermissions().has('inspections:manage');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [inspectionType, setInspectionType] = useState('');
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const debouncedSearch = useDebouncedValue(search);
  const searchText = search.trim();
  const appliedSearchText = debouncedSearch.trim();
  const isSearchPending = searchText !== appliedSearchText;
  const hasActiveFilters = Boolean(searchText || status || inspectionType || unassignedOnly);
  const inspections = useInspections({
    page,
    pageSize: 20,
    search: debouncedSearch,
    status,
    inspectionType,
    unassignedOnly: unassignedOnly || undefined,
  });
  const isFilterPending = isSearchPending || inspections.isPlaceholderData;
  const resultLabel =
    isFilterPending || inspections.isFetching
      ? 'Searching inspections...'
      : inspections.isLoading
        ? 'Loading inspections...'
        : `${(inspections.data?.total ?? 0).toLocaleString()} inspections`;

  return (
    <>
      <PageHeader
        title="Inspections"
        description="Schedule, assign, and monitor the complete property inspection lifecycle."
        action={
          canManage ? (
            <Link className={buttonVariants({ variant: 'primary' })} href="/inspections/new">
              Create inspection
            </Link>
          ) : undefined
        }
      />
      <FilterToolbar
        resultLabel={resultLabel}
        onClear={
          hasActiveFilters
            ? () => {
                setSearch('');
                setStatus('');
                setInspectionType('');
                setUnassignedOnly(false);
                setPage(1);
              }
            : undefined
        }
      >
        <div className="field field-grow">
          <label htmlFor="inspection-search">Search property or unit</label>
          <input
            id="inspection-search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search inspections..."
          />
        </div>
        <div className="field field-compact">
          <label htmlFor="inspection-type">Type</label>
          <select
            id="inspection-type"
            value={inspectionType}
            onChange={(event) => {
              setInspectionType(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All types</option>
            {Object.values(InspectionType).map((type) => (
              <option key={type} value={type}>
                {type.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </div>
        <div className="field field-compact">
          <label htmlFor="inspection-status">Status</label>
          <select
            id="inspection-status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {[
              'SCHEDULED',
              'IN_PROGRESS',
              'PROCESSING',
              'REVIEW_REQUIRED',
              'COMPLETED',
              'CANCELLED',
            ].map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </div>
        <label className="check-field filter-toggle">
          <input
            type="checkbox"
            checked={unassignedOnly}
            onChange={(event) => {
              setUnassignedOnly(event.target.checked);
              setPage(1);
            }}
          />{' '}
          Unassigned only
        </label>
      </FilterToolbar>
      {inspections.isLoading || isFilterPending ? (
        <TableLoadingState
          headers={INSPECTION_HEADERS}
          label={isFilterPending ? 'Searching inspections' : 'Loading inspections'}
          rows={4}
        />
      ) : inspections.isError ? (
        <ErrorState error={inspections.error} retry={() => void inspections.refetch()} />
      ) : !inspections.data?.items.length ? (
        <EmptyState
          title="No inspections found"
          description={
            hasActiveFilters
              ? 'Adjust the filters to see matching inspections.'
              : 'Create the first inspection from an active synchronized property.'
          }
          action={
            <Link className={buttonVariants({ variant: 'primary' })} href="/inspections/new">
              Create inspection
            </Link>
          }
        />
      ) : (
        <>
          <DataTable headers={INSPECTION_HEADERS} label="Property inspections">
            {inspections.data.items.map((inspection) => {
              const current = inspection.assignments.find((assignment) => assignment.isCurrent);
              return (
                <tr key={inspection.id}>
                  <td>
                    <Link className="table-link" href={`/inspections/${inspection.id}`}>
                      {inspection.propertywareBuilding?.name ?? 'Property snapshot'}
                    </Link>
                  </td>
                  <td>{inspection.propertywareUnit?.name ?? 'Entire property'}</td>
                  <td>
                    <Badge value={inspection.inspectionType} />
                  </td>
                  <td>{formatDate(inspection.scheduledAt)}</td>
                  <td>
                    <Badge value={inspection.priority} />
                  </td>
                  <td>
                    <Badge value={inspection.status} />
                  </td>
                  <td>
                    <Badge value={current ? 'ASSIGNED' : 'UNASSIGNED'} />
                  </td>
                  <td>{current?.technician?.displayName ?? '-'}</td>
                </tr>
              );
            })}
          </DataTable>
          <Pagination page={page} totalPages={inspections.data.totalPages} onPage={setPage} />
        </>
      )}
    </>
  );
}
