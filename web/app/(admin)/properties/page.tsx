'use client';

import { isDemoProperty } from '@texasrenters/shared';
import { Building2Icon, PlusIcon, Trash2Icon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import {
  DemoPropertyDeleteDialog,
  type DeletableDemoProperty,
} from '@/components/demo-property-delete-dialog';
import { ListToolbar } from '@/components/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { SearchableSelect } from '@/components/searchable-select';
import { EmptyState, ErrorState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePermissions } from '@/lib/auth';
import { EMPTY, formatAddress, formatDateTime, formatRelative } from '@/lib/format';
import { useAdminMutations, usePortfolios, useProperties } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useUrlState } from '@/lib/url-state';

type PropertyRow = NonNullable<ReturnType<typeof useProperties>['data']>['items'][number];

const COLUMNS: Array<Column<PropertyRow>> = [
  {
    key: 'name',
    header: 'Property',
    primary: true,
    /**
     * The badge is on the name, not in a column of its own.
     *
     * Every other row on this page is a house somebody lives in, and a demo
     * property has to be unmistakable at the point somebody reads its name —
     * including in the property picker on the inspection form, which shows the
     * same field. A separate column would be the first thing hidden on a narrow
     * screen, which is exactly when the mistake gets made.
     */
    cell: (row) => (
      <span className="flex items-center gap-1.5">
        {row.name}
        {/* `warning`, not a neutral tone: this says "not a real house", which is
            the one thing a reader must not skim past. */}
        {isDemoProperty(row) ? <Badge variant="warning">Demo</Badge> : null}
      </span>
    ),
  },
  { key: 'address', header: 'Address', cell: (row) => formatAddress(row), hideBelow: 'md' },
  {
    key: 'portfolio',
    header: 'Portfolio',
    hideBelow: 'lg',
    cell: (row) =>
      row.portfolio?.name ?? <span className="text-muted-foreground">Unassigned</span>,
  },
  { key: 'units', header: 'Units', numeric: true, cell: (row) => row._count?.units ?? 0 },
  {
    key: 'area',
    header: 'Total area',
    hideBelow: 'xl',
    cell: (row) => (
      <span className="flex items-center gap-1.5">
        {row.totalArea?.label ?? EMPTY}
        {row.totalArea?.source === 'MANUAL' ? (
          <Badge variant="outline">Manual</Badge>
        ) : row.totalArea?.derived ? (
          <Badge variant="outline">Derived</Badge>
        ) : null}
      </span>
    ),
  },
  {
    key: 'inspections',
    header: 'Inspections',
    numeric: true,
    hideBelow: 'sm',
    cell: (row) => row._count?.inspections ?? 0,
  },
  {
    /**
     * Whether somebody lives there — a different question from the one beside
     * it.
     *
     * `Status` says whether TexasRenters still manages the property;
     * `Occupancy` says whether a tenant is in residence. Both columns are
     * present because the two were previously indistinguishable on this page,
     * and a vacant property is still managed and still inspectable — a move-out
     * happens *because* it became vacant.
     *
     * Propertyware's own word is shown rather than a yes/no, because it also
     * writes values that are neither.
     */
    key: 'occupancy',
    header: 'Occupancy',
    // Plain words (console-development): "Occupied" plain and every other word
    // in an outlined box made the exceptions the loudest thing in the column.
    // The usual answer reads in the text colour, the rest quieter.
    cell: (row) =>
      row.sourceStatus ? (
        <span className={/^occupied$/i.test(row.sourceStatus) ? undefined : 'text-muted-foreground'}>
          {row.sourceStatus}
        </span>
      ) : (
        EMPTY
      ),
  },
  {
    key: 'status',
    header: 'Status',
    hideBelow: 'lg',
    // The list is active-only, so a green dot on every row said nothing
    // (console-development). Active is a quiet word; Inactive, the exception,
    // keeps a dot so it still stands out if one ever appears.
    cell: (row) =>
      row.isActive ? (
        <span className="text-muted-foreground">Active</span>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="bg-muted-foreground/60 size-1.5 shrink-0 rounded-full" />
          Inactive
        </span>
      ),
  },
  {
    key: 'synced',
    header: 'Last synced',
    hideBelow: 'xl',
    cell: (row) => (
      <span
        className="text-muted-foreground"
        title={row.lastSyncedAt ? formatDateTime(row.lastSyncedAt) : undefined}
      >
        {formatRelative(row.lastSyncedAt)}
      </span>
    ),
  },
];

export default function PropertiesPage() {
  const [state, setState, reset] = useUrlState({
    page: 1,
    q: '',
    portfolio: '',
    // In the URL, so a filtered view is a link somebody can send.
    occupancy: '',
  });
  const [portfolioSearch, setPortfolioSearch] = useState('');
  const canManage = usePermissions().has('properties:manage');
  const createDemoProperty = useAdminMutations().createDemoProperty;
  const [pendingDelete, setPendingDelete] = useState<DeletableDemoProperty | null>(null);

  const debouncedSearch = useDebouncedValue(state.q);
  const isSearchPending = state.q.trim() !== debouncedSearch.trim();

  /** The filters every tab shares; only `occupancy` differs between them. */
  const baseQuery = {
    search: debouncedSearch,
    portfolioId: state.portfolio,
    active: true,
  };

  const properties = useProperties({
    ...baseQuery,
    page: state.page,
    pageSize: 20,
    occupancy: state.occupancy || undefined,
  });

  /**
   * Counts for the two tabs that are not currently open.
   *
   * `pageSize: 1` because only `total` is read — the list query already counts,
   * so this asks for the number and one row rather than a second page of data.
   *
   * They carry `baseQuery`, so the counts describe the search and portfolio in
   * force rather than the whole portfolio. A tab reading "Vacant (132)" beside
   * a filtered list of four would be answering a question nobody asked.
   */
  const occupiedCount = useProperties({ ...baseQuery, pageSize: 1, occupancy: 'OCCUPIED' });
  const vacantCount = useProperties({ ...baseQuery, pageSize: 1, occupancy: 'VACANT' });
  const allCount = useProperties({ ...baseQuery, pageSize: 1 });

  const tabs = [
    { value: '', label: 'All', total: allCount.data?.total },
    { value: 'OCCUPIED', label: 'Occupied', total: occupiedCount.data?.total },
    { value: 'VACANT', label: 'Vacant', total: vacantCount.data?.total },
  ];
  const portfolios = usePortfolios(portfolioSearch);
  const portfolioOptions =
    portfolios.data?.pages.flatMap((portfolioPage) =>
      portfolioPage.items.map((item) => ({
        value: item.id,
        label: item.name,
        searchText: item.abbreviation ?? undefined,
      })),
    ) ?? [];
  const selectedPortfolio = portfolioOptions.find((option) => option.value === state.portfolio);

  const busy = properties.isLoading || isSearchPending || properties.isPlaceholderData;
  const hasActiveFilters = Boolean(state.q.trim() || state.portfolio || state.occupancy);
  const total = (properties.data?.total ?? 0).toLocaleString();
  const resultLabel = busy
    ? 'Searching active properties…'
    : state.occupancy === 'OCCUPIED'
      ? `${total} occupied properties`
      : state.occupancy === 'VACANT'
        ? `${total} vacant properties`
        : `${total} active properties`;

  /**
   * The server's own message on failure, not a generic one.
   *
   * Both refusals this can return say something the person can act on — the
   * limit is reached, or the property already exists and the list needs a
   * refresh. Replacing them with "something went wrong" would throw away the
   * only two useful sentences here.
   */
  const addDemoProperty = () =>
    createDemoProperty.mutate(undefined, {
      onSuccess: (property) => toast.success(`${property.name} is ready to inspect.`),
      onError: (error) =>
        toast.error(
          error instanceof Error ? error.message : 'The demo property could not be created.',
        ),
    });

  return (
    <>
      <PageHeader
        /**
         * The one action on this page that writes a property.
         *
         * Gated on `properties:manage` because it writes into the table every
         * other surface reads from, and hidden rather than disabled for anyone
         * without it — a button that cannot be pressed invites a support
         * question, and nothing here explains the permission.
         */
        actions={
          canManage ? (
            <Button
              disabled={createDemoProperty.isPending}
              onClick={addDemoProperty}
              variant="outline"
            >
              <PlusIcon />
              {createDemoProperty.isPending ? 'Adding…' : 'Add demo property'}
            </Button>
          ) : null
        }
        description="Every active property from Propertyware, ready for inspections."
        title="Properties"
      />

      {/* Occupancy, not management status. Every tab is already limited to
          properties under management; this splits them by whether a tenant is
          in residence, which is the question a move-out turns on. */}
      <Tabs
        onValueChange={(occupancy) => setState({ occupancy, page: 1 })}
        value={state.occupancy}
      >
        <TabsList>
          {tabs.map((tab) => (
            <TabsTrigger key={tab.value || 'all'} value={tab.value}>
              {tab.label}
              {/* A figure, not part of the name (console-development). */}
              {tab.total === undefined ? null : (
                <span className="text-muted-foreground font-mono text-xs tabular-nums">
                  {tab.total.toLocaleString()}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <ListToolbar
        activeFilters={
          selectedPortfolio
            ? [
                {
                  label: 'Portfolio',
                  value: selectedPortfolio.label,
                  onRemove: () => setState({ portfolio: '', page: 1 }),
                },
              ]
            : []
        }
        filters={
          <SearchableSelect
            className="w-[240px]"
            clearLabel="All portfolios"
            disabled={portfolios.isLoading || portfolios.isError}
            emptyMessage="No active portfolio matches your search."
            hasMore={portfolios.hasNextPage}
            id="portfolio"
            loadingMore={portfolios.isFetchingNextPage}
            loadingMoreLabel="Loading more portfolios…"
            moreHint="Scroll for more portfolios"
            onChange={(portfolio) => setState({ portfolio, page: 1 })}
            onLoadMore={() => void portfolios.fetchNextPage()}
            onSearch={setPortfolioSearch}
            options={portfolioOptions}
            optionsLabel="Portfolio options"
            placeholder="All portfolios"
            searchPlaceholder="Search portfolios…"
            value={state.portfolio}
          />
        }
        onClear={reset}
        onSearch={(q) => setState({ q, page: 1 })}
        pending={isSearchPending}
        resultLabel={resultLabel}
        search={state.q}
        searchLabel="Search property name or address"
        searchPlaceholder="Search properties…"
      />

      {busy ? (
        <DataTableSkeleton columns={COLUMNS} label="Loading properties" rows={8} />
      ) : properties.isError ? (
        <ErrorState error={properties.error} retry={() => void properties.refetch()} />
      ) : !properties.data?.items.length ? (
        <EmptyState
          description={
            hasActiveFilters
              ? 'Try a different property name, address, city, or portfolio.'
              : 'Run and verify Propertyware synchronization before creating inspections.'
          }
          icon={Building2Icon}
          title={hasActiveFilters ? 'No matching properties' : 'No synchronized properties'}
        >
          {hasActiveFilters ? (
            <Button onClick={reset} variant="outline">
              Clear filters
            </Button>
          ) : (
            <Button asChild>
              <Link href="/integrations/propertyware">Open Propertyware</Link>
            </Button>
          )}
        </EmptyState>
      ) : (
        <>
          <DataTable
            /**
             * Only demo properties get a control, and only for somebody who can
             * manage properties.
             *
             * `undefined` for a synced row rather than a disabled button: the
             * whole portfolio is synced, so a column of greyed-out bins beside
             * 570 real properties would imply deleting them is a thing that
             * could be arranged. It is not — there is no endpoint for it.
             *
             * The row itself is a link to the detail page, and `DataTable` puts
             * this cell above the stretched link, so the bin does not just open
             * the property.
             */
            actions={
              canManage
                ? (row) =>
                    isDemoProperty(row) ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            aria-label={`Delete ${row.name}`}
                            className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                            onClick={() =>
                              setPendingDelete({
                                id: row.id,
                                name: row.name,
                                inspectionCount: row._count?.inspections ?? 0,
                              })
                            }
                            size="icon-sm"
                            variant="ghost"
                          >
                            <Trash2Icon />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Delete demo property</TooltipContent>
                      </Tooltip>
                    ) : null
                : undefined
            }
            columns={COLUMNS}
            label="Active synchronized properties"
            rowHref={(row) => `/properties/${row.id}`}
            rowKey={(row) => row.id}
            rows={properties.data.items}
          />
          <Pagination
            onPage={(page) => setState({ page })}
            page={state.page}
            total={properties.data.total}
            totalPages={properties.data.totalPages}
          />
        </>
      )}

      {pendingDelete ? (
        <DemoPropertyDeleteDialog
          onClose={() => setPendingDelete(null)}
          property={pendingDelete}
        />
      ) : null}
    </>
  );
}
