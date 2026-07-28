'use client';

import Link from 'next/link';
import { useState } from 'react';
import { buttonVariants } from '@/components/ui/button';

import { SearchableSelect } from '@/components/searchable-select';
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  FilterToolbar,
  PageHeader,
  Pagination,
  TableLoadingState,
  address,
  formatDate,
} from '@/components/shared';
import { usePortfolios, useProperties } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';

const PROPERTY_HEADERS = [
  'Property',
  'Address',
  'Portfolio',
  'Units',
  'Total area',
  'Leases',
  'Inspections',
  'Status',
  'Last synced',
];

export default function PropertiesPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [portfolioId, setPortfolioId] = useState('');
  const [portfolioSearch, setPortfolioSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search);
  const searchText = search.trim();
  const appliedSearchText = debouncedSearch.trim();
  const isSearchPending = searchText !== appliedSearchText;
  const hasActiveFilters = Boolean(searchText || portfolioId);
  const properties = useProperties({
    page,
    pageSize: 20,
    search: debouncedSearch,
    portfolioId,
    active: true,
  });
  const portfolios = usePortfolios(portfolioSearch);
  const portfolioOptions =
    portfolios.data?.pages.flatMap((portfolioPage) =>
      portfolioPage.items.map((item) => ({
        value: item.id,
        label: item.name,
        searchText: item.abbreviation ?? undefined,
      })),
    ) ?? [];
  const resultLabel =
    isSearchPending || properties.isPlaceholderData || properties.isFetching
      ? 'Searching active properties...'
      : properties.isLoading
        ? 'Loading active properties...'
        : `${(properties.data?.total ?? 0).toLocaleString()} active properties`;
  return (
    <>
      <PageHeader
        title="Properties"
        description="Active normalized Propertyware properties available for inspections."
      />
      <FilterToolbar
        resultLabel={resultLabel}
        onClear={
          search || portfolioId
            ? () => {
                setSearch('');
                setPortfolioId('');
                setPortfolioSearch('');
                setPage(1);
              }
            : undefined
        }
      >
        <div className="field field-grow">
          <label htmlFor="search">Search name or address</label>
          <input
            id="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search properties..."
          />
        </div>
        <div className="field field-medium">
          <label htmlFor="portfolio">Portfolio</label>
          <SearchableSelect
            id="portfolio"
            value={portfolioId}
            options={portfolioOptions}
            placeholder="All portfolios"
            clearLabel="All portfolios"
            searchPlaceholder="Search portfolios..."
            emptyMessage="No active portfolio matches your search."
            optionsLabel="Portfolio options"
            loadingMoreLabel="Loading more portfolios..."
            moreHint="Scroll for more portfolios"
            disabled={portfolios.isLoading || portfolios.isError}
            hasMore={portfolios.hasNextPage}
            loadingMore={portfolios.isFetchingNextPage}
            onSearch={setPortfolioSearch}
            onLoadMore={() => void portfolios.fetchNextPage()}
            onChange={(nextPortfolioId) => {
              setPortfolioId(nextPortfolioId);
              setPage(1);
            }}
          />
        </div>
      </FilterToolbar>
      {properties.isLoading || isSearchPending || properties.isPlaceholderData ? (
        <TableLoadingState
          headers={PROPERTY_HEADERS}
          label={
            isSearchPending || properties.isPlaceholderData
              ? 'Searching properties'
              : 'Loading properties'
          }
          rows={4}
        />
      ) : properties.isError ? (
        <ErrorState error={properties.error} retry={() => void properties.refetch()} />
      ) : !properties.data?.items.length ? (
        <EmptyState
          title={hasActiveFilters ? 'No matching properties' : 'No synchronized properties'}
          description={
            hasActiveFilters
              ? 'Try a different property name, address, city, or portfolio.'
              : 'Run and verify Propertyware synchronization before creating inspections.'
          }
          action={
            hasActiveFilters ? undefined : (
              <Link className={buttonVariants({ variant: 'primary' })} href="/integrations/propertyware">
                Open Propertyware
              </Link>
            )
          }
        />
      ) : (
        <>
          <DataTable headers={PROPERTY_HEADERS} label="Active synchronized properties">
            {properties.data.items.map((property) => (
              <tr key={property.id}>
                <td>
                  <Link className="table-link" href={`/properties/${property.id}`}>
                    {property.name}
                  </Link>
                </td>
                <td>{address(property)}</td>
                <td>{property.portfolio.name}</td>
                <td className="numeric-cell">{property._count?.units ?? 0}</td>
                <td>
                  {property.totalArea?.label ?? 'Not provided'}
                  {property.totalArea?.source === 'MANUAL' ? (
                    <span className="cell-note">Manual</span>
                  ) : property.totalArea?.derived ? (
                    <span className="cell-note">Derived</span>
                  ) : null}
                </td>
                <td>
                  {property.leaseSummary?.summary ?? '—'}
                  {property.leaseSummary?.leaseDataAvailable === false ? (
                    <span className="cell-note is-warning">Not synchronized</span>
                  ) : property.leaseSummary?.nextLeaseEndDate ? (
                    <span className="cell-note">
                      Next ends {formatDate(property.leaseSummary.nextLeaseEndDate)}
                    </span>
                  ) : null}
                </td>
                <td className="numeric-cell">{property._count?.inspections ?? 0}</td>
                <td>
                  <Badge value={property.isActive ? 'ACTIVE' : 'INACTIVE'} />
                </td>
                <td>{formatDate(property.lastSyncedAt)}</td>
              </tr>
            ))}
          </DataTable>
          <Pagination page={page} totalPages={properties.data.totalPages} onPage={setPage} />
        </>
      )}
    </>
  );
}
