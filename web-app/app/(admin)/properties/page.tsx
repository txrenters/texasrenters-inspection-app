'use client';

import Link from 'next/link';
import { useState } from 'react';

import { SearchableSelect } from '@/components/searchable-select';
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  TableLoadingState,
  address,
  formatDate,
} from '@/components/ui';
import { usePortfolios, useProperties } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';

const PROPERTY_HEADERS = [
  'Property',
  'Address',
  'Portfolio',
  'Units',
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
  return (
    <>
      <PageHeader
        title="Properties"
        description="Active normalized Propertyware properties available for inspections."
      />
      <div className="filter-bar">
        <div className="field field-grow">
          <label htmlFor="search">Search name or address</label>
          <input
            id="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search properties…"
          />
        </div>
        <div className="field">
          <label htmlFor="portfolio">Portfolio</label>
          <SearchableSelect
            id="portfolio"
            value={portfolioId}
            options={portfolioOptions}
            placeholder="All portfolios"
            clearLabel="All portfolios"
            searchPlaceholder="Search portfolios…"
            emptyMessage="No active portfolio matches your search."
            optionsLabel="Portfolio options"
            loadingMoreLabel="Loading more portfolios…"
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
      </div>
      {properties.isLoading ? (
        <TableLoadingState headers={PROPERTY_HEADERS} label="Loading properties" />
      ) : properties.isError ? (
        <ErrorState error={properties.error} retry={() => void properties.refetch()} />
      ) : !properties.data?.items.length ? (
        <EmptyState
          title="No synchronized properties"
          description="Run and verify Propertyware synchronization before creating inspections."
          action={
            <Link className="button button-primary" href="/integrations/propertyware">
              Open Propertyware
            </Link>
          }
        />
      ) : (
        <>
          <DataTable headers={PROPERTY_HEADERS}>
            {properties.data.items.map((property) => (
              <tr key={property.id}>
                <td>
                  <Link className="table-link" href={`/properties/${property.id}`}>
                    {property.name}
                  </Link>
                </td>
                <td>{address(property)}</td>
                <td>{property.portfolio.name}</td>
                <td>{property._count?.units ?? 0}</td>
                <td>{property._count?.inspections ?? 0}</td>
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
