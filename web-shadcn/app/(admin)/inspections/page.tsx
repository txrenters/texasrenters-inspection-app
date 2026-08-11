'use client';

import { ClipboardCheckIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { InspectionBulkDeleteDialog } from '@/components/inspection-bulk-delete-dialog';
import {
  InspectionDeleteDialog,
  type DeletableInspection,
} from '@/components/inspection-delete-dialog';
import { ListToolbar, SelectFilter, enumOptions } from '@/components/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { EmptyState, ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { dayEnd, dayStart, rangeLabel } from '@/lib/date-range';
import { formatDateTime, humanize } from '@/lib/format';
import { usePermissions } from '@/lib/auth';
import { useInspections } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useUrlState } from '@/lib/url-state';

type InspectionRow = NonNullable<ReturnType<typeof useInspections>['data']>['items'][number];

const STATUSES = [
  'SCHEDULED',
  'IN_PROGRESS',
  'PROCESSING',
  'REVIEW_REQUIRED',
  'COMPLETED',
  'CANCELLED',
] as const;

/**
 * What each type is *for*, keyed by `InspectionType`.
 *
 * Shown when one type is open on its own. The generic lifecycle blurb is true of
 * the combined list and says nothing once you have narrowed to move-outs, which
 * is the one place a reader might be new to the distinction.
 */
const DESCRIPTIONS: Record<string, { title: string; description: string }> = {
  BACK_TO_MARKET: {
    title: 'Back-to-market inspections',
    description: 'Turn work verified and the unit confirmed ready to list.',
  },
  HVAC: {
    title: 'HVAC inspections',
    description: 'Equipment maintenance, scheduled independently of the tenancy.',
  },
  MOVE_IN: {
    title: 'Move-in inspections',
    description: 'The condition record a later move-out is compared against.',
  },
  MOVE_OUT: {
    title: 'Move-out inspections',
    description: 'Damage assessment and tenant charges, compared to the move-in record.',
  },
  OCCUPIED: {
    title: 'Occupied inspections',
    description: 'Periodic checks during an active tenancy.',
  },
};

const COLUMNS: Array<Column<InspectionRow>> = [
  {
    key: 'property',
    header: 'Property',
    primary: true,
    cell: (row) => row.propertywareBuilding?.name ?? 'Property snapshot',
  },
  {
    key: 'unit',
    header: 'Unit',
    hideBelow: 'lg',
    cell: (row) => row.propertywareUnit?.name ?? 'Entire property',
  },
  { key: 'type', header: 'Type', hideBelow: 'md', cell: (row) => <StatusBadge value={row.inspectionType} /> },
  {
    key: 'scheduled',
    header: 'Scheduled',
    hideBelow: 'sm',
    cell: (row) => formatDateTime(row.scheduledAt),
  },
  { key: 'priority', header: 'Priority', hideBelow: 'xl', cell: (row) => <StatusBadge value={row.priority} /> },
  { key: 'status', header: 'Status', cell: (row) => <StatusBadge value={row.status} /> },
  {
    key: 'technician',
    header: 'Technician',
    cell: (row) => {
      // `?? []` for the same reason as the detail page: a mutation response
      // merged into this cache entry is a projection, and can briefly leave the
      // record without its assignments array.
      const current = (row.assignments ?? []).find((assignment) => assignment.isCurrent);
      // A dash was the only sign nobody had it. An inspection can be scheduled
      // with "Leave unassigned" and then nothing ever raises it again, so the
      // one place they are all listed has to say so in words.
      return (
        current?.technician?.displayName ?? <StatusBadge value="UNASSIGNED" />
      );
    },
  },
];

export default function InspectionsPage() {
  const permissions = usePermissions();
  const canManage = permissions.has('inspections:manage');
  const canDelete = permissions.has('inspections:delete');
  // Held as the row rather than an id, so the confirmation can name the
  // property without looking it back up after the list has already refetched.
  const [pendingDelete, setPendingDelete] = useState<DeletableInspection | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [state, setState] = useUrlState({
    from: '',
    page: 1,
    q: '',
    status: '',
    to: '',
    type: '',
    unassigned: false,
  });

  /**
   * Clears the narrowing filters but keeps `type`, so clearing inside a section
   * returns you to the whole of that type rather than to every inspection ever
   * recorded. The type's own chip is still there to leave the section with.
   *
   * Not `reset` from `useUrlState`, which drops the entire query string.
   */
  const clearFilters = useCallback(
    () => setState({ from: '', page: 1, q: '', status: '', to: '', unassigned: false }),
    [setState],
  );

  const debouncedSearch = useDebouncedValue(state.q);
  const isSearchPending = state.q.trim() !== debouncedSearch.trim();

  const inspections = useInspections({
    page: state.page,
    pageSize: 20,
    search: debouncedSearch,
    status: state.status,
    inspectionType: state.type,
    // The API compares against `scheduledAt`, a timestamp, so a bare date would
    // read as local midnight and drop everything scheduled later that day from
    // the "to" end of the range. Both bounds are widened to cover the whole day
    // the reader picked, which is what a date range means to them.
    scheduledFrom: dayStart(state.from),
    scheduledTo: dayEnd(state.to),
    unassignedOnly: state.unassigned || undefined,
  });

  const busy = inspections.isLoading || isSearchPending || inspections.isPlaceholderData;
  // `type` is deliberately not counted here. Opened from the sidebar it is the
  // section you are in, not a filter you left on — so an empty move-out list
  // must not offer "Clear filters", which would silently eject you from it.
  const hasNarrowingFilters = Boolean(state.q.trim() || state.status || state.unassigned);
  const resultLabel = busy
    ? 'Searching inspections…'
    : `${(inspections.data?.total ?? 0).toLocaleString()} inspections`;

  /**
   * Reached from the sidebar's sub-item, one type reads as its own section
   * rather than as a filter someone left on — the title, the count, and the
   * empty state all name the type.
   *
   * It is still only the `type` search param, so the toolbar's Type select and
   * its removable chip keep working and stay in sync with the sidebar.
   */
  const section = state.type ? DESCRIPTIONS[state.type] : undefined;
  /**
   * Creating from inside a section prefills that type, so the button in
   * Move-out makes a move-out. Only when the type is one the section list
   * recognizes — an unknown `?type=` must not be forwarded into the form.
   */
  const createHref = section
    ? `/inspections/new?type=${encodeURIComponent(state.type)}`
    : '/inspections/new';
  const createLabel = section ? `Create ${humanize(state.type).toLowerCase()} inspection` : 'Create inspection';

  const rows = useMemo(() => inspections.data?.items ?? [], [inspections.data?.items]);
  const asDeletable = useCallback(
    (row: InspectionRow): DeletableInspection => ({
      id: row.id,
      name: row.propertywareBuilding?.name ?? 'Inspection',
      unitName: row.propertywareUnit?.name,
      finalized: Boolean(row.finalizedAt),
    }),
    [],
  );

  /**
   * Selection is narrowed to what is on screen **during render**, not by an
   * effect that prunes the state.
   *
   * The effect version set state on every change to `rows`, and `rows` is a new
   * reference whenever react-query re-derives the page — so it re-rendered,
   * produced new rows, set state again, and blew the update depth. Deriving it
   * instead cannot loop: nothing writes state during render, and a stale id
   * lingering in `selectedIds` is invisible because every read goes through
   * this.
   *
   * The guarantee is unchanged: the bulk bar can never offer to delete an
   * inspection the reader cannot currently see.
   */
  const visibleSelection = useMemo(() => {
    const visible = new Set(rows.map((row) => row.id));
    return new Set([...selectedIds].filter((id) => visible.has(id)));
  }, [rows, selectedIds]);

  const selectedRows = rows.filter((row) => visibleSelection.has(row.id)).map(asDeletable);

  const toggleOne = useCallback((id: string, selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const toggleMany = useCallback((ids: string[], selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const activeFilters = [
    // No chip for `type`. It is the section, not a filter — leaving it is what
    // the breadcrumb's "Inspections" link and the sidebar's parent item are for.
    state.from || state.to
      ? {
          label: 'Scheduled',
          value: rangeLabel(state.from, state.to),
          onRemove: () => setState({ from: '', to: '', page: 1 }),
        }
      : null,
    state.status
      ? {
          label: 'Status',
          value: humanize(state.status),
          onRemove: () => setState({ status: '', page: 1 }),
        }
      : null,
    state.unassigned
      ? {
          label: 'Assignment',
          value: 'Unassigned only',
          onRemove: () => setState({ unassigned: false, page: 1 }),
        }
      : null,
  ].filter((filter) => filter !== null);

  // Counted on the page rather than fetched: this covers the loaded page, which
  // is enough to notice the problem exists. An inspection scheduled and never
  // assigned reaches nobody, and nothing else raises it.
  const unassignedOnPage =
    inspections.data?.items.filter(
      (inspection) => !(inspection.assignments ?? []).some((assignment) => assignment.isCurrent),
    ).length ?? 0;

  return (
    <>
      <PageHeader
        actions={
          canManage ? (
            <Button asChild>
              <Link href={createHref}>{createLabel}</Link>
            </Button>
          ) : undefined
        }
        description={
          section?.description ??
          'Schedule, assign, and monitor the complete property inspection lifecycle.'
        }
        title={section?.title ?? 'Inspections'}
      />

      <ListToolbar
        activeFilters={activeFilters}
        filters={
          <>
            {/* The type filter is gone: each type is its own page now, so
                choosing one here would be a second, competing way to be in a
                section — and one that leaves the sidebar and title disagreeing
                with the list. Use the sidebar's sub-items instead.

                Scheduled-date bounds took its place, because with the types
                separated the question left is a historical one: which move-ins
                did this property have before September. */}
            <DatePicker
              aria-label="Scheduled on or after"
              className="w-[178px]"
              // Bounded by the other end, so the calendar cannot produce an
              // inverted range that returns nothing with no explanation.
              max={state.to || undefined}
              onChange={(from) => setState({ from, page: 1 })}
              placeholder="Scheduled from"
              value={state.from}
            />
            <DatePicker
              aria-label="Scheduled on or before"
              className="w-[178px]"
              min={state.from || undefined}
              onChange={(to) => setState({ to, page: 1 })}
              placeholder="Scheduled to"
              value={state.to}
            />
            <SelectFilter
              allLabel="All statuses"
              label="Status"
              onChange={(status) => setState({ status, page: 1 })}
              options={enumOptions(STATUSES)}
              value={state.status}
            />
          </>
        }
        onClear={clearFilters}
        onSearch={(q) => setState({ q, page: 1 })}
        pending={isSearchPending}
        resultLabel={resultLabel}
        search={state.q}
        searchLabel="Search property or unit"
        searchPlaceholder="Search inspections…"
      >
        <Label className="h-9 cursor-pointer gap-2 rounded-md border px-3 text-sm font-normal">
          <Checkbox
            checked={state.unassigned}
            onCheckedChange={(checked) => setState({ unassigned: checked === true, page: 1 })}
          />
          Unassigned only
        </Label>
      </ListToolbar>

      {busy ? (
        <DataTableSkeleton columns={COLUMNS} label="Loading inspections" rows={8} />
      ) : inspections.isError ? (
        <ErrorState error={inspections.error} retry={() => void inspections.refetch()} />
      ) : !inspections.data?.items.length ? (
        <EmptyState
          description={
            hasNarrowingFilters
              ? 'Adjust the filters to see matching inspections.'
              : section
                ? 'Nothing of this type has been scheduled yet. Other types are unaffected.'
                : 'Create the first inspection from an active synchronized property.'
          }
          icon={ClipboardCheckIcon}
          title={
            section
              ? `No ${humanize(state.type).toLowerCase()} inspections`
              : 'No inspections found'
          }
        >
          {hasNarrowingFilters ? (
            <Button onClick={clearFilters} variant="outline">
              Clear filters
            </Button>
          ) : canManage ? (
            <Button asChild>
              <Link href={createHref}>{createLabel}</Link>
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <>
          {unassignedOnPage ? (
            <Alert className="mb-4" role="status" variant="warning">
              <TriangleAlertIcon />
              <AlertDescription>
                {unassignedOnPage === 1
                  ? '1 inspection on this page has no technician assigned.'
                  : `${unassignedOnPage} inspections on this page have no technician assigned.`}{' '}
                They will not appear in anyone&apos;s queue until they do.
                {!state.unassigned ? (
                  <Button
                    className="h-auto p-0 text-inherit underline"
                    onClick={() => setState({ unassigned: true, page: 1 })}
                    variant="link"
                  >
                    Show only unassigned
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          {/* Sits directly above the table and only when something is picked —
              a permanently visible bulk bar is chrome that reads as an action
              even when there is nothing to act on. */}
          {canDelete && visibleSelection.size ? (
            <div className="border-primary bg-primary/5 mb-3 flex flex-wrap items-center gap-3 rounded-lg border p-2.5">
              <span className="text-sm font-medium">
                {visibleSelection.size} selected on this page
              </span>
              <Button
                onClick={() => setSelectedIds(new Set())}
                size="sm"
                type="button"
                variant="ghost"
              >
                Clear
              </Button>
              <Button
                className="ml-auto"
                onClick={() => setBulkOpen(true)}
                size="sm"
                type="button"
                variant="destructive"
              >
                <Trash2Icon />
                Delete {visibleSelection.size} permanently
              </Button>
            </div>
          ) : null}

          <DataTable
            // Only ever rendered with `inspections:delete`. The row itself is a
            // link to the detail page, so this control carries `relative z-10`
            // via RowActions to sit above the stretched link rather than under
            // it — otherwise clicking the bin would just open the inspection.
            actions={
              canDelete
                ? (row) => (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          aria-label={`Delete ${row.propertywareBuilding?.name ?? 'inspection'}`}
                          className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          onClick={() =>
                            setPendingDelete({
                              id: row.id,
                              name: row.propertywareBuilding?.name ?? 'Inspection',
                              unitName: row.propertywareUnit?.name,
                              finalized: Boolean(row.finalizedAt),
                            })
                          }
                          size="icon-sm"
                          variant="ghost"
                        >
                          <Trash2Icon />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Delete permanently</TooltipContent>
                    </Tooltip>
                  )
                : undefined
            }
            columns={COLUMNS}
            label="Property inspections"
            rowHref={(row) => `/inspections/${row.id}`}
            rowKey={(row) => row.id}
            rows={rows}
            selection={
              canDelete
                ? {
                    noun: 'inspections',
                    onToggle: toggleOne,
                    onToggleAll: toggleMany,
                    rowLabel: (id) =>
                      rows.find((row) => row.id === id)?.propertywareBuilding?.name ??
                      'this inspection',
                    selected: visibleSelection,
                  }
                : undefined
            }
          />
          <Pagination
            onPage={(page) => setState({ page })}
            page={state.page}
            total={inspections.data.total}
            totalPages={inspections.data.totalPages}
          />
        </>
      )}

      {/* No `redirectTo`: the list is not about the deleted record, and
          navigating away would discard the filters mid-cleanup. */}
      {pendingDelete ? (
        <InspectionDeleteDialog
          inspection={pendingDelete}
          onClose={() => setPendingDelete(null)}
        />
      ) : null}

      {bulkOpen && selectedRows.length ? (
        <InspectionBulkDeleteDialog
          inspections={selectedRows}
          onClose={() => setBulkOpen(false)}
          // Only the ids that actually went. A partial failure leaves the rest
          // selected so they can be retried without hunting for them again.
          onDeleted={(ids) =>
            setSelectedIds((current) => new Set([...current].filter((id) => !ids.includes(id))))
          }
        />
      ) : null}
    </>
  );
}
