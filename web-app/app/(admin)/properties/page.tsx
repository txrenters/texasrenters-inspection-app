'use client';

import Link from 'next/link';
import { useState } from 'react';
import { TableCell, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel } from '@/components/ui/field';
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
        <Field className="flex-1">
          <FieldLabel htmlFor="search">Search name or address</FieldLabel>
          <Input
            id="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search properties..."
          />
        </Field>
        <Field className="w-[min(280px,100%)]">
          <FieldLabel htmlFor="portfolio">Portfolio</FieldLabel>
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
        </Field>
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
              <TableRow key={property.id}>
                <TableCell>
                  <Link className="font-semibold text-primary" href={`/properties/${property.id}`}>
                    {property.name}
                  </Link>
                </TableCell>
                <TableCell>{address(property)}</TableCell>
                <TableCell>
                  {property.portfolio?.name ?? (
                    <span className="text-muted-foreground">Unassigned</span>
                  )}
                </TableCell>
                <TableCell className="numeric-cell">{property._count?.units ?? 0}</TableCell>
                <TableCell>
                  {property.totalArea?.label ?? 'Not provided'}
                  {property.totalArea?.source === 'MANUAL' ? (
                    <span className="cell-note">Manual</span>
                  ) : property.totalArea?.derived ? (
                    <span className="cell-note">Derived</span>
                  ) : null}
                </TableCell>
                <TableCell className="numeric-cell">{property._count?.inspections ?? 0}</TableCell>
                <TableCell>
                  <Badge value={property.isActive ? 'ACTIVE' : 'INACTIVE'} />
                </TableCell>
                <TableCell>{formatDate(property.lastSyncedAt)}</TableCell>
              </TableRow>
            ))}
          </DataTable>
          <Pagination page={page} totalPages={properties.data.totalPages} onPage={setPage} />
        </>
      )}
    </>
  );
}
