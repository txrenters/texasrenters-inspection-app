'use client';

import { UsersIcon } from 'lucide-react';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { ListToolbar } from '@/components/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { EmptyState, ErrorState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EMPTY } from '@/lib/format';
import { useTenants, type AdminTenant } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useUrlState } from '@/lib/url-state';

/**
 * Tenancies, and which of them are in the Tenant Benefit Package.
 *
 * The rows come from the office's own Propertyware report rather than the lease
 * endpoint, because it is the only source that knows about the benefit package
 * — enrolment, the HVAC plan, filter sizes, when a filter was last delivered —
 * and the only one carrying a building address to tie a tenancy to a property.
 */
const COLUMNS: Array<Column<AdminTenant>> = [
  { key: 'name', header: 'Tenant', primary: true, cell: (row) => row.leaseName },
  {
    key: 'address',
    header: 'Property',
    cell: (row) => (
      <div className="min-w-0">
        <div className="truncate">{row.addressLine1 ?? EMPTY}</div>
        <div className="text-muted-foreground truncate text-xs">
          {[row.city, row.state, row.postalCode].filter(Boolean).join(', ')}
          {/* Said plainly rather than left blank: a tenancy whose address
              matched no building is still shown, and the reason it carries no
              property link should not be something a reader has to infer. */}
          {row.building ? null : ' · not matched to a property'}
        </div>
      </div>
    ),
  },
  {
    key: 'tbp',
    header: 'Benefit package',
    cell: (row) =>
      row.tbpEnrollment ? (
        <Badge
          variant={
            /^yes$/i.test(row.tbpEnrollment)
              ? 'default'
              : /^no$/i.test(row.tbpEnrollment)
                ? 'outline'
                : 'secondary'
          }
        >
          {row.tbpEnrollment}
        </Badge>
      ) : (
        EMPTY
      ),
  },
  { key: 'zone', header: 'Zone', hideBelow: 'lg', cell: (row) => row.zone ?? EMPTY },
  {
    key: 'hvac',
    header: 'HVAC plan',
    hideBelow: 'xl',
    cell: (row) => row.hvacPlan ?? EMPTY,
  },
  {
    key: 'filters',
    header: 'Filter sizes',
    hideBelow: 'xl',
    // Placeholders are stripped on the way in, so an empty list means the
    // office recorded none — not that it wrote "N/A" four times.
    cell: (row) =>
      row.hvacFilterSizes.length ? (
        <span className="font-mono text-xs">{row.hvacFilterSizes.join(', ')}</span>
      ) : (
        EMPTY
      ),
  },
  {
    key: 'lastFilter',
    header: 'Last filter delivery',
    hideBelow: 'xl',
    // Free text in the report — values read like "04/09/2026 - Moses", the date
    // and the person who delivered it. Shown as written rather than parsed into
    // a date that would throw the name away.
    cell: (row) => (
      <span className="text-muted-foreground text-xs">{row.lastFilterDelivery ?? EMPTY}</span>
    ),
  },
];

export default function TenantsPage() {
  const [state, setState, reset] = useUrlState({ page: 1, q: '', enrollment: '' });
  const debouncedSearch = useDebouncedValue(state.q);
  const isSearchPending = state.q.trim() !== debouncedSearch.trim();

  const base = { search: debouncedSearch, active: true };
  const tenants = useTenants({
    ...base,
    page: state.page,
    pageSize: 20,
    enrollment: state.enrollment || undefined,
  });

  // Only the total is read, so these ask for a single row rather than a page.
  // They carry the search in force, so a tab count never describes a wider set
  // than the list beneath it.
  const allCount = useTenants({ ...base, pageSize: 1 });
  const tbpCount = useTenants({ ...base, pageSize: 1, enrollment: 'TBP' });
  const notTbpCount = useTenants({ ...base, pageSize: 1, enrollment: 'NOT_TBP' });

  const tabs = [
    { value: '', label: 'Active tenants', total: allCount.data?.total },
    { value: 'TBP', label: 'Benefit package', total: tbpCount.data?.total },
    { value: 'NOT_TBP', label: 'Not enrolled', total: notTbpCount.data?.total },
  ];

  const busy = tenants.isLoading || isSearchPending || tenants.isPlaceholderData;
  const total = (tenants.data?.total ?? 0).toLocaleString();
  const resultLabel = busy
    ? 'Searching tenants…'
    : state.enrollment === 'TBP'
      ? `${total} enrolled in the benefit package`
      : state.enrollment === 'NOT_TBP'
        ? `${total} not enrolled`
        : `${total} active tenants`;

  return (
    <>
      <PageHeader
        title="Tenants"
        description="Active tenancies from Propertyware, and which are enrolled in the Tenant Benefit Package."
      />

      <Tabs
        onValueChange={(enrollment) => setState({ enrollment, page: 1 })}
        value={state.enrollment}
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
        onClear={reset}
        onSearch={(q) => setState({ q, page: 1 })}
        pending={isSearchPending}
        resultLabel={resultLabel}
        search={state.q}
        searchLabel="Search tenant, address or zone"
        searchPlaceholder="Search tenants…"
      />

      {busy ? (
        <DataTableSkeleton columns={COLUMNS} label="Loading tenants" rows={8} />
      ) : tenants.isError ? (
        <ErrorState error={tenants.error} retry={() => void tenants.refetch()} />
      ) : !tenants.data?.items.length ? (
        <EmptyState
          description={
            state.q.trim() || state.enrollment
              ? 'No tenancy matches this filter.'
              : 'No tenancies have been synchronized from Propertyware yet.'
          }
          icon={UsersIcon}
          title="No tenants to show"
        />
      ) : (
        <>
          <DataTable columns={COLUMNS} rowKey={(row) => row.id} rows={tenants.data.items} />
          <Pagination
            onPage={(page) => setState({ page })}
            page={tenants.data.page}
            total={tenants.data.total}
            totalPages={tenants.data.totalPages}
          />
        </>
      )}
    </>
  );
}
