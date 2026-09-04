'use client';

import { Building2Icon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { ListToolbar } from '@/components/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { SearchableSelect } from '@/components/searchable-select';
import { EmptyState, ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EMPTY, formatAddress, formatRelative } from '@/lib/format';
import { usePortfolios, useProperties } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useUrlState } from '@/lib/url-state';

type PropertyRow = NonNullable<ReturnType<typeof useProperties>['data']>['items'][number];

const COLUMNS: Array<Column<PropertyRow>> = [
  { key: 'name', header: 'Property', primary: true, cell: (row) => row.name },
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
    cell: (row) =>
      row.sourceStatus ? (
        <Badge variant={/^occupied$/i.test(row.sourceStatus) ? 'default' : 'outline'}>
          {row.sourceStatus}
        </Badge>
      ) : (
        EMPTY
      ),
  },
  {
    key: 'status',
    header: 'Status',
    hideBelow: 'lg',
    cell: (row) => <StatusBadge value={row.isActive ? 'ACTIVE' : 'INACTIVE'} />,
  },
  {
    key: 'synced',
    header: 'Last synced',
    hideBelow: 'xl',
    cell: (row) => (
      <span className="text-muted-foreground" title={row.lastSyncedAt ?? undefined}>
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

  return (
    <>
      <PageHeader
        title="Properties"
        description="Active normalized Propertyware properties available for inspections."
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
              {tab.total === undefined ? '' : ` (${tab.total.toLocaleString()})`}
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
    </>
  );
}
