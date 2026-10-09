'use client';

import { isUpcomingVisit, VISIT_STATES, visitStateOf } from '@texasrenters/shared';
import { ClipboardCheckIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { DayFilter } from '@/components/day-filter';
import { InspectionBulkDeleteDialog } from '@/components/inspection-bulk-delete-dialog';
import type { DeletableInspection } from '@/components/inspection-delete-dialog';
import { ListToolbar, SelectFilter } from '@/components/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { EmptyState, ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { INSPECTION_TYPE_CHILDREN } from '@/lib/admin-navigation';
import { usePermissions } from '@/lib/auth';
import { businessToday } from '@/lib/clock';
import { EMPTY, formatCount, formatScheduledDate, humanize } from '@/lib/format';
import { quarterOf, recentQuarters } from '@/lib/planning';
import { useInspections, useTechnicians } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useUrlState } from '@/lib/url-state';

type InspectionRow = NonNullable<ReturnType<typeof useInspections>['data']>['items'][number];

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
  ROOF: {
    title: 'Roof inspections',
    description: 'Covers every area the property records as a roof.',
  },
  SUPRA_LOCKBOX_PLACEMENT: {
    title: 'Supra + lockbox placement',
    description: 'Fitting the lockbox, with photographs of where it went.',
  },
  SUPRA_LOCKBOX_REMOVAL: {
    title: 'Supra + lockbox removal',
    description: 'Collecting the lockbox at the end of the listing.',
  },
  AC_FILTER_DELIVERY: {
    title: 'AC filter delivery',
    description: 'Filters delivered to every area that has a unit.',
  },
};

/**
 * The lists where the benefit package means something: its visits are
 * occupied and HVAC inspections, and the combined list holds both. On a
 * move-in or move-out list its column read "Enrolled" on nearly every row, and
 * its two filters answered a question nobody asks there (the office,
 * 2026-10-07: "lots of buttons and filters that is not really necessary").
 */
const PROGRAMME_TYPES = new Set(['', 'OCCUPIED', 'HVAC']);

/** The office's own words, not a shorter paraphrase of them. */
const TBP_LABEL = {
  ENROLLED: 'Enrolled',
  NOT_ENROLLED: 'Not enrolled',
  NOT_VERIFIED: 'Not verified',
  MIXED: 'Mixed',
} as const;

/** The technician filter's "nobody yet". */
const UNASSIGNED = 'unassigned';
/** The day param's "every date". Absent is today. */
const ALL_DATES = 'all';

/** "Tuesday, October 7", for a day held as `yyyy-MM-dd`. Noon UTC is that date everywhere. */
const dayName = (day: string) =>
  new Date(`${day}T12:00:00.000Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

/** "Move-in", "HVAC": the navigation's own names, so the list and the sidebar agree. */
const typeLabel = (type: string) =>
  INSPECTION_TYPE_CHILDREN.find((child) => child.type === type)?.title ?? humanize(type);

const currentTechnician = (row: InspectionRow) =>
  // `?? []`: a mutation response merged into this cache entry is a projection,
  // and can briefly leave the record without its assignments array.
  (row.assignments ?? []).find((assignment) => assignment.isCurrent)?.technician?.displayName ?? null;

/** The columns, given which list this is. */
function columnsFor(type: string): Array<Column<InspectionRow>> {
  const columns: Array<Column<InspectionRow> | null> = [
    {
      key: 'property',
      header: 'Property',
      primary: true,
      /**
       * The property, its unit when it has one, and the two facts that are
       * only ever exceptions: a priority that is not Standard, and a move-out
       * with no move-in to compare against. They had columns of their own --
       * "Entire property" and "Standard" down every row.
       */
      cell: (row) => (
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{row.propertywareBuilding?.name ?? 'Property snapshot'}</span>
            {row.priority && row.priority !== 'STANDARD' ? <StatusBadge value={row.priority} /> : null}
            {row.baselineMissing ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <TriangleAlertIcon
                    aria-label="No move-in baseline"
                    className="text-destructive size-3.5 shrink-0"
                  />
                </TooltipTrigger>
                <TooltipContent>No move-in to compare against. The comparison cannot be generated.</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
          {row.propertywareUnit?.name ? (
            <div className="text-muted-foreground truncate text-xs">{row.propertywareUnit.name}</div>
          ) : null}
        </div>
      ),
    },
    // On a type's own list every row is that type.
    type
      ? null
      : {
          key: 'type',
          header: 'Type',
          hideBelow: 'md',
          // A type is not a status: plain words, no dot, no chip. A coloured
          // chip here was one of the three in every row.
          cell: (row) => <span className="text-muted-foreground">{typeLabel(row.inspectionType)}</span>,
        },
    {
      key: 'scheduled',
      header: 'Scheduled',
      hideBelow: 'sm',
      // Sortable when the list spans dates; one day has no order to turn.
      sortable: true,
      // With its quarter: the API's answer, which knows a plan that starts
      // fifteen days early puts its first visits in the quarter before. The
      // date is only the fallback, for a row served before the API said.
      cell: (row) => (
        <div className="min-w-0">
          <div>{formatScheduledDate(row.scheduledAt)}</div>
          <div className="text-muted-foreground text-xs">{row.quarter || quarterOf(row.scheduledAt)}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      // Where the visit stands, in the inspection page's own words: a
      // submitted visit is Done, not "Review required" (2026-10-07).
      cell: (row) => <StatusBadge value={visitStateOf(row)} />,
    },
    {
      key: 'technician',
      header: 'Technician',
      /**
       * "Unassigned" only where somebody is still needed. A cancelled or done
       * visit with nobody on it needs nobody, and flagging it filled the list
       * with warnings about nothing.
       */
      cell: (row) =>
        currentTechnician(row) ??
        (isUpcomingVisit(visitStateOf(row)) ? (
          <StatusBadge value="UNASSIGNED" />
        ) : (
          <span className="text-muted-foreground text-xs">{EMPTY}</span>
        )),
    },
    {
      key: 'evidence',
      header: 'Evidence',
      hideBelow: 'md',
      /**
       * Photographs, not areas: an inspection is created with its property's
       * layout snapshotted onto it, so an area count says a plan existed -- not
       * that anybody walked the property.
       */
      cell: (row) =>
        row.evidence && row.evidence.photos > 0 ? (
          <span className="font-mono text-xs tabular-nums">
            {formatCount(row.evidence.photos)}
            <span className="text-muted-foreground font-sans"> photos</span>
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">Empty</span>
        ),
    },
    PROGRAMME_TYPES.has(type)
      ? {
          key: 'tbp',
          header: 'TBP',
          hideBelow: 'lg',
          /**
           * Benefit-package enrolment for the tenancy at this property, the
           * office's three answers; a dash where there is no active tenancy at
           * all, rather than a claim about somebody who does not exist.
           */
          cell: (row) =>
            row.tbp ? (
              <Badge variant={row.tbp === 'ENROLLED' ? 'secondary' : 'outline'}>{TBP_LABEL[row.tbp]}</Badge>
            ) : (
              <span className="text-muted-foreground text-xs">{EMPTY}</span>
            ),
        }
      : null,
  ];
  return columns.filter((column): column is Column<InspectionRow> => column !== null);
}

export default function InspectionsPage() {
  const permissions = usePermissions();
  const canManage = permissions.has('inspections:manage');
  const canDelete = permissions.has('inspections:delete');
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [state, setState] = useUrlState({
    // Empty is newest first. Kept as the absent value so the ordinary URL stays
    // clean and an old link still means what it meant.
    asc: false,
    /** A Texas day (`yyyy-MM-dd`), `all`, or absent for today. */
    day: '',
    page: 1,
    q: '',
    quarter: '',
    status: '',
    tbp: false,
    /** A technician's id, `unassigned`, or absent for any. */
    tech: '',
    type: '',
    /** Read only: the dashboard's "Assign now" and older links. */
    unassigned: false,
  });

  const debouncedSearch = useDebouncedValue(state.q);
  const isSearchPending = state.q.trim() !== debouncedSearch.trim();
  const today = businessToday();
  /**
   * The day shown. The office opens a list on today's visits (2026-10-07), and
   * steps through days from there. A search reaches every date unless a day
   * was picked: somebody typing a technician or an address is looking for it
   * wherever it is, and finding nothing because it is not today's was the
   * "it will not show" this page was reported for.
   */
  const day =
    state.day === ALL_DATES
      ? null
      : state.day || (state.q.trim() || state.unassigned ? null : today);
  const technician = state.tech || (state.unassigned ? UNASSIGNED : '');
  const programme = PROGRAMME_TYPES.has(state.type);

  const inspections = useInspections({
    page: state.page,
    pageSize: 20,
    search: debouncedSearch,
    status: state.status,
    inspectionType: state.type,
    // The day itself: `scheduledAt` is a date, so this is an equality.
    scheduledOn: day ?? undefined,
    technicianId: technician && technician !== UNASSIGNED ? technician : undefined,
    unassignedOnly: technician === UNASSIGNED || undefined,
    tbpOnly: (programme && state.tbp) || undefined,
    // The quarter itself, not the days it covers: the API decides membership
    // by the plan that made the visit.
    quarter: (programme && state.quarter) || undefined,
    // Sorted by the API, not here: these are twenty rows of thousands.
    scheduledOrder: state.asc ? 'asc' : undefined,
  });
  const technicians = useTechnicians({ page: 1, pageSize: 100 });

  const busy = inspections.isLoading || isSearchPending || inspections.isPlaceholderData;
  // The day is not counted: it is where the list is, and "Clear filters" goes
  // back to today rather than throwing the reader into every date at once.
  const hasNarrowingFilters = Boolean(
    state.q.trim() || state.status || technician || (programme && (state.tbp || state.quarter)),
  );
  const total = inspections.data?.total ?? 0;
  const resultLabel = busy
    ? 'Searching inspections…'
    : `${total.toLocaleString()} ${total === 1 ? 'inspection' : 'inspections'}${day ? ` on ${dayName(day)}` : ''}`;

  /** Back to the list as it opens: today, everything else cleared. The type stays: it is the section. */
  const clearFilters = useCallback(
    () =>
      setState({ day: '', page: 1, q: '', quarter: '', status: '', tbp: false, tech: '', unassigned: false }),
    [setState],
  );

  const section = state.type ? DESCRIPTIONS[state.type] : undefined;
  // The type as the page's title spells it -- "move-out", "HVAC" -- not the
  // enum humanized ("move out", "hvac").
  const typeKind = section?.title.replace(/ inspections$/, '') ?? '';
  const typeName = typeKind === typeKind.toUpperCase() ? typeKind : typeKind.toLowerCase();
  const createHref = section ? `/inspections/new?type=${encodeURIComponent(state.type)}` : '/inspections/new';
  const createLabel = section ? `Create ${typeName} inspection` : 'Create inspection';
  const columns = useMemo(() => columnsFor(state.type), [state.type]);

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
   * Selection narrowed to what is on screen **during render**, not by an
   * effect that prunes the state -- that version looped on every re-derived
   * page. The bulk bar can never offer to delete a row the reader cannot see.
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

  const technicianOptions = [
    { value: UNASSIGNED, label: 'Unassigned' },
    ...[...(technicians.data?.items ?? [])]
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((entry) => ({ value: entry.id, label: entry.displayName })),
  ];
  const technicianName =
    technician === UNASSIGNED ? 'Unassigned' : technicianOptions.find((option) => option.value === technician)?.label;

  const activeFilters = [
    state.status
      ? {
          label: 'Status',
          value: VISIT_STATES.find((entry) => entry.value === state.status)?.label ?? humanize(state.status),
          onRemove: () => setState({ status: '', page: 1 }),
        }
      : null,
    technician
      ? {
          label: 'Technician',
          value: technicianName ?? 'One technician',
          onRemove: () => setState({ tech: '', unassigned: false, page: 1 }),
        }
      : null,
    programme && state.tbp
      ? { label: 'Programme', value: 'Benefit package', onRemove: () => setState({ tbp: false, page: 1 }) }
      : null,
    programme && state.quarter
      ? { label: 'Quarter', value: state.quarter, onRemove: () => setState({ quarter: '', page: 1 }) }
      : null,
  ].filter((filter) => filter !== null);

  /**
   * Upcoming visits on this page with nobody on them. A cancelled or done
   * visit needs nobody, and counting them is how sixteen "unassigned" filled
   * a page of mostly cancelled move-outs.
   */
  const unassignedOnPage = rows.filter(
    (row) => isUpcomingVisit(visitStateOf(row)) && !currentTechnician(row),
  ).length;

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
        description={section?.description ?? 'Schedule, assign, and monitor the complete property inspection lifecycle.'}
        title={section?.title ?? 'Inspections'}
      />

      <ListToolbar
        activeFilters={activeFilters}
        filters={
          <>
            {/* One day, as the timesheet picks one (2026-10-07). */}
            <DayFilter
              onChange={(next) => setState({ day: next === null ? ALL_DATES : next === today ? '' : next, page: 1 })}
              value={day}
            />
            <SelectFilter
              allLabel="All statuses"
              label="Status"
              onChange={(status) => setState({ status, page: 1 })}
              options={VISIT_STATES.map((entry) => ({ value: entry.value, label: entry.label }))}
              value={state.status}
            />
            <SelectFilter
              allLabel="All technicians"
              label="Technician"
              onChange={(tech) => setState({ tech, unassigned: false, page: 1 })}
              options={technicianOptions}
              value={technician}
            />
            {programme ? (
              <>
                <SelectFilter
                  allLabel="Any quarter"
                  label="Quarter"
                  onChange={(quarter) => setState({ quarter, page: 1 })}
                  options={recentQuarters().map((quarter) => ({ value: quarter, label: quarter }))}
                  value={state.quarter}
                />
                <Label className="h-9 cursor-pointer gap-2 rounded-md border px-3 text-sm font-normal">
                  <Checkbox
                    checked={state.tbp}
                    onCheckedChange={(checked) => setState({ tbp: checked === true, page: 1 })}
                  />
                  Benefit package
                </Label>
              </>
            ) : null}
          </>
        }
        onClear={clearFilters}
        onSearch={(q) => setState({ q, page: 1 })}
        pending={isSearchPending}
        resultLabel={resultLabel}
        search={state.q}
        searchLabel={`Search ${section ? `${typeName} inspections` : 'inspections'} by property, address, unit or technician`}
        searchPlaceholder={`Search ${section ? `${typeName} inspections` : 'inspections'}…`}
      />

      {busy ? (
        <DataTableSkeleton columns={columns} label="Loading inspections" rows={8} />
      ) : inspections.isError ? (
        <ErrorState error={inspections.error} retry={() => void inspections.refetch()} />
      ) : !rows.length ? (
        <EmptyState
          description={
            hasNarrowingFilters
              ? 'Nothing matches these filters. Clear them to see the whole list.'
              : day
                ? `Nothing ${typeName ? `of this type ` : ''}is scheduled on ${dayName(day)}. Step to another day, or show every date.`
                : section
                  ? 'Nothing of this type has been scheduled yet. Other types are unaffected.'
                  : 'Create the first inspection from an active synchronized property.'
          }
          icon={ClipboardCheckIcon}
          title={section ? `No ${typeName} inspections` : 'No inspections found'}
        >
          {hasNarrowingFilters ? (
            <Button onClick={clearFilters} variant="outline">
              Clear filters
            </Button>
          ) : day ? (
            <Button onClick={() => setState({ day: ALL_DATES, page: 1 })} variant="outline">
              Show every date
            </Button>
          ) : canManage ? (
            <Button asChild>
              <Link href={createHref}>{createLabel}</Link>
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <>
          {unassignedOnPage && technician !== UNASSIGNED ? (
            <Alert className="mb-4" role="status" variant="warning">
              <TriangleAlertIcon />
              <AlertDescription>
                {unassignedOnPage === 1
                  ? '1 upcoming visit here has no technician, and will reach nobody until it does.'
                  : `${unassignedOnPage} upcoming visits here have no technician, and will reach nobody until they do.`}{' '}
                <Button
                  className="h-auto p-0 text-inherit underline"
                  onClick={() => setState({ tech: UNASSIGNED, unassigned: false, page: 1 })}
                  variant="link"
                >
                  Show them
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          {/* Above the table and only when something is picked. Deleting is
              here and only here: a bin on every row was a button nobody should
              be one stray click from. */}
          {canDelete && visibleSelection.size ? (
            <div className="border-primary bg-primary/5 mb-3 flex flex-wrap items-center gap-3 rounded-lg border p-2.5">
              <span className="text-sm font-medium">{visibleSelection.size} selected on this page</span>
              <Button onClick={() => setSelectedIds(new Set())} size="sm" type="button" variant="ghost">
                Clear
              </Button>
              <Button className="ml-auto" onClick={() => setBulkOpen(true)} size="sm" type="button" variant="destructive">
                <Trash2Icon />
                Delete {visibleSelection.size} permanently
              </Button>
            </div>
          ) : null}

          <DataTable
            columns={columns}
            label="Property inspections"
            rowHref={(row) => `/inspections/${row.id}`}
            rowKey={(row) => row.id}
            rows={rows}
            // Back to page one: page four of newest-first holds nothing a
            // reader turning the list around was looking for.
            sort={
              day
                ? undefined
                : {
                    by: 'scheduled',
                    direction: state.asc ? 'asc' : 'desc',
                    onChange: () => setState({ asc: !state.asc, page: 1 }),
                  }
            }
            selection={
              canDelete
                ? {
                    noun: 'inspections',
                    onToggle: toggleOne,
                    onToggleAll: toggleMany,
                    rowLabel: (id) =>
                      rows.find((row) => row.id === id)?.propertywareBuilding?.name ?? 'this inspection',
                    selected: visibleSelection,
                  }
                : undefined
            }
          />
          <Pagination
            onPage={(page) => setState({ page })}
            page={state.page}
            total={inspections.data?.total ?? 0}
            totalPages={inspections.data?.totalPages ?? 1}
          />
        </>
      )}

      {bulkOpen && selectedRows.length ? (
        <InspectionBulkDeleteDialog
          inspections={selectedRows}
          onClose={() => setBulkOpen(false)}
          // Only the ids that actually went. A partial failure leaves the rest
          // selected so they can be retried without hunting for them again.
          onDeleted={(ids) => setSelectedIds((current) => new Set([...current].filter((id) => !ids.includes(id))))}
        />
      ) : null}
    </>
  );
}
