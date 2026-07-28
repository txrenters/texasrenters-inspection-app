'use client';

import Link from 'next/link';
import { useState } from 'react';
import { InspectionType } from '@texasrenters/shared';
import { Checkbox } from '@/components/ui/checkbox';
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

// Radix Select rejects an empty string as an item value, so the unfiltered
// row carries a sentinel that is translated back to '' for the query.
const ALL = '__all__';

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
        <Field className="flex-1">
          <FieldLabel htmlFor="inspection-search">Search property or unit</FieldLabel>
          <Input
            id="inspection-search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search inspections..."
          />
        </Field>
        <Field className="w-[min(210px,100%)]">
          <FieldLabel htmlFor="inspection-type">Type</FieldLabel>
          <Select
            onValueChange={(next) => {
              setInspectionType(next === ALL ? '' : next);
              setPage(1);
            }}
            value={inspectionType || ALL}
          >
            <SelectTrigger id="inspection-type">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All types</SelectItem>
              {Object.values(InspectionType).map((type) => (
                <SelectItem key={type} value={type}>
                  {type.replaceAll('_', ' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field className="w-[min(210px,100%)]">
          <FieldLabel htmlFor="inspection-status">Status</FieldLabel>
          <Select
            onValueChange={(next) => {
              setStatus(next === ALL ? '' : next);
              setPage(1);
            }}
            value={status || ALL}
          >
            <SelectTrigger id="inspection-status">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {[
                'SCHEDULED',
                'IN_PROGRESS',
                'PROCESSING',
                'REVIEW_REQUIRED',
                'COMPLETED',
                'CANCELLED',
              ].map((item) => (
                <SelectItem key={item} value={item}>
                  {item.replaceAll('_', ' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <label className="flex min-h-[42px] items-center gap-2 text-[13px] font-semibold">
          <Checkbox
            checked={unassignedOnly}
            onCheckedChange={(checked) => {
              setUnassignedOnly(checked === true);
              setPage(1);
            }}
          />
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
                <TableRow key={inspection.id}>
                  <TableCell>
                    <Link className="font-semibold text-primary" href={`/inspections/${inspection.id}`}>
                      {inspection.propertywareBuilding?.name ?? 'Property snapshot'}
                    </Link>
                  </TableCell>
                  <TableCell>{inspection.propertywareUnit?.name ?? 'Entire property'}</TableCell>
                  <TableCell>
                    <Badge value={inspection.inspectionType} />
                  </TableCell>
                  <TableCell>{formatDate(inspection.scheduledAt)}</TableCell>
                  <TableCell>
                    <Badge value={inspection.priority} />
                  </TableCell>
                  <TableCell>
                    <Badge value={inspection.status} />
                  </TableCell>
                  <TableCell>
                    <Badge value={current ? 'ASSIGNED' : 'UNASSIGNED'} />
                  </TableCell>
                  <TableCell>{current?.technician?.displayName ?? '-'}</TableCell>
                </TableRow>
              );
            })}
          </DataTable>
          <Pagination page={page} totalPages={inspections.data.totalPages} onPage={setPage} />
        </>
      )}
    </>
  );
}
