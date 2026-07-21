'use client';

import Link from 'next/link';
import { useState } from 'react';
import { InspectionType } from '@texasrenters/shared';

import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  TableLoadingState,
  formatDate,
} from '@/components/ui';
import { useInspections } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';

const INSPECTION_HEADERS = [
  'Property / unit',
  'Type',
  'Scheduled',
  'Priority',
  'Status',
  'Assignment',
  'Technician',
];

export default function InspectionsPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [inspectionType, setInspectionType] = useState('');
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const debouncedSearch = useDebouncedValue(search);
  const inspections = useInspections({
    page,
    pageSize: 20,
    search: debouncedSearch,
    status,
    inspectionType,
    unassignedOnly: unassignedOnly || undefined,
  });

  return (
    <>
      <PageHeader
        title="Inspections"
        description="Schedule, assign, and monitor the complete property inspection lifecycle."
        action={
          <Link className="button button-primary" href="/inspections/new">
            Create inspection
          </Link>
        }
      />
      <div className="filter-bar">
        <div className="field field-grow">
          <label htmlFor="inspection-search">Search property or unit</label>
          <input
            id="inspection-search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search inspections…"
          />
        </div>
        <div className="field">
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
        <div className="field">
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
        <label className="check-field">
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
      </div>
      {inspections.isLoading ? (
        <TableLoadingState headers={INSPECTION_HEADERS} label="Loading inspections" />
      ) : inspections.isError ? (
        <ErrorState error={inspections.error} retry={() => void inspections.refetch()} />
      ) : !inspections.data?.items.length ? (
        <EmptyState
          title="No inspections found"
          description="Adjust the filters or create the first inspection from an active synchronized property."
          action={
            <Link className="button button-primary" href="/inspections/new">
              Create inspection
            </Link>
          }
        />
      ) : (
        <>
          <DataTable headers={INSPECTION_HEADERS}>
            {inspections.data.items.map((inspection) => {
              const current = inspection.assignments.find((assignment) => assignment.isCurrent);
              return (
                <tr key={inspection.id}>
                  <td>
                    <Link className="table-link" href={`/inspections/${inspection.id}`}>
                      {inspection.propertywareBuilding?.name ?? 'Property snapshot'}
                    </Link>
                    <small className="cell-note">
                      {inspection.propertywareUnit?.name ?? 'Entire property'}
                    </small>
                  </td>
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
                  <td>{current?.technician?.displayName ?? '—'}</td>
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
