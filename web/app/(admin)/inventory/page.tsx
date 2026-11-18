'use client';

import { formatMoney, stockSummary, type StockCategoryRow, type StockItemRow, type StockPlaceRow, type VendorRow } from '@texasrenters/shared';
import { BoxesIcon, PencilIcon, TagsIcon, TruckIcon, WarehouseIcon } from 'lucide-react';
import { useState } from 'react';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { CategoryDialog, ItemDialog, PlaceDialog, VendorDialog } from '@/components/inventory/inventory-dialogs';
import { InUseBadge, StockStatusBadge } from '@/components/inventory/stock-status';
import { WithdrawalsTab } from '@/components/inventory/withdrawals-tab';
import { PageHeader } from '@/components/page-header';
import { Stat, StatGroup } from '@/components/stat-card';
import { EmptyState, ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePermissions } from '@/lib/auth';
import { EMPTY, formatCount } from '@/lib/format';
import { useInventoryEdits, useStock, useStockPlaces, useVendors } from '@/lib/inventory-queries';
import { useUrlState } from '@/lib/url-state';

/**
 * Inventory (2026-11-19, phase 1 of the inventory and purchasing plan): what
 * the office stocks and what is on hand, the places it is kept, and the
 * vendors. On hand is added up from the item's movements and is never typed
 * here; an item's page enters its opening balance. An item's code is given by
 * the console from its category (2026-11-19), so nobody types one. The
 * Withdrawals tab records what leaves, comes back and moves (phase 5).
 *
 * The item list is one read of every item -- tens to a few hundred -- so the
 * filters and the search work on the rows in hand and ask for nothing more.
 */

const ALL = 'all';
type Editing<Row> = { row?: Row } | null;

export default function InventoryPage() {
  const permissions = usePermissions();
  const canManage = permissions.has('inventory:manage');
  const canWithdraw = permissions.has('inventory:withdraw');
  const [state, setState] = useUrlState({ tab: 'stock', company: ALL, show: 'in-use', q: '' });
  const [item, setItem] = useState(false);
  const [place, setPlace] = useState<Editing<StockPlaceRow>>(null);
  const [vendor, setVendor] = useState<Editing<VendorRow>>(null);
  const [category, setCategory] = useState<Editing<StockCategoryRow>>(null);
  const stock = useStock();
  const edits = useInventoryEdits();

  const add =
    state.tab === 'categories' ? (
      <Button onClick={() => setCategory({})}>New category</Button>
    ) : state.tab === 'places' ? (
      <Button onClick={() => setPlace({})}>New place</Button>
    ) : state.tab === 'vendors' ? (
      <Button onClick={() => setVendor({})}>New vendor</Button>
    ) : state.tab === 'withdrawals' ? undefined : (
      <Button onClick={() => setItem(true)}>New item</Button>
    );

  return (
    <>
      <PageHeader
        actions={canManage ? add : undefined}
        description="What the office stocks, where it is, and who it is bought from."
        info={
          <>
            <p>On hand is added up from each item&apos;s movements. It cannot be typed over.</p>
            <p>To bring in what is on the shelf today, open an item and enter its opening balance. A wrong entry is reversed, never edited.</p>
          </>
        }
        infoLabel="About inventory"
        title="Inventory"
      />

      <Tabs onValueChange={(tab) => setState({ tab })} value={state.tab}>
        <TabsList>
          <TabsTrigger value="stock">Stock</TabsTrigger>
          <TabsTrigger value="withdrawals">Withdrawals</TabsTrigger>
          <TabsTrigger value="categories">Categories</TabsTrigger>
          <TabsTrigger value="places">Places</TabsTrigger>
          <TabsTrigger value="vendors">Vendors</TabsTrigger>
        </TabsList>

        <TabsContent value="stock">
          {stock.isLoading ? (
            <DataTableSkeleton columns={STOCK_COLUMNS} label="Loading stock" rows={8} />
          ) : stock.isError || !stock.data ? (
            <ErrorState error={stock.error} retry={() => void stock.refetch()} />
          ) : (
            <StockTab canManage={canManage} items={stock.data.items} onAdd={() => setItem(true)} companies={stock.data.companies} setState={setState} state={state} />
          )}
        </TabsContent>
        <TabsContent value="withdrawals">
          <WithdrawalsTab canWithdraw={canWithdraw} />
        </TabsContent>
        <TabsContent value="categories">
          {stock.isError ? (
            <ErrorState error={stock.error} retry={() => void stock.refetch()} />
          ) : !stock.data ? (
            <DataTableSkeleton columns={CATEGORY_COLUMNS} label="Loading categories" rows={3} />
          ) : !stock.data.categories.length ? (
            <EmptyState
              description={canManage ? 'Add a category for each kind of stock, with the prefix its codes start with. Items are then numbered by the console.' : 'No category has been added yet.'}
              icon={TagsIcon}
              title="No categories yet"
            />
          ) : (
            <DataTable
              actions={canManage ? (row) => <EditButton label={`Edit ${row.name}`} onClick={() => setCategory({ row })} /> : undefined}
              columns={CATEGORY_COLUMNS}
              label="Categories and their codes"
              rowKey={(row) => row.id}
              rows={stock.data.categories}
            />
          )}
        </TabsContent>
        <TabsContent value="places">
          <PlacesTab canManage={canManage} enabled={state.tab === 'places'} onEdit={(row) => setPlace({ row })} />
        </TabsContent>
        <TabsContent value="vendors">
          <VendorsTab canManage={canManage} enabled={state.tab === 'vendors'} onEdit={(row) => setVendor({ row })} />
        </TabsContent>
      </Tabs>

      {item && stock.data ? (
        <ItemDialog
          categories={stock.data.categories}
          companies={stock.data.companies}
          error={edits.createItem.error}
          onClose={() => {
            setItem(false);
            edits.createItem.reset();
          }}
          onSave={(input) => edits.createItem.mutateAsync(input)}
          pending={edits.createItem.isPending}
          vendors={stock.data.vendors}
        />
      ) : null}
      {category ? (
        <CategoryDialog
          category={category.row}
          error={(category.row ? edits.updateCategory : edits.createCategory).error}
          onClose={() => {
            setCategory(null);
            edits.updateCategory.reset();
            edits.createCategory.reset();
          }}
          onSave={(input) => (category.row ? edits.updateCategory.mutateAsync({ categoryId: category.row.id, input }) : edits.createCategory.mutateAsync(input))}
          pending={edits.updateCategory.isPending || edits.createCategory.isPending}
        />
      ) : null}
      {place ? <PlaceEditor editing={place} onClose={() => setPlace(null)} /> : null}
      {vendor ? (
        <VendorDialog
          error={(vendor.row ? edits.updateVendor : edits.createVendor).error}
          onClose={() => {
            setVendor(null);
            edits.updateVendor.reset();
            edits.createVendor.reset();
          }}
          onSave={(input) => (vendor.row ? edits.updateVendor.mutateAsync({ vendorId: vendor.row.id, input }) : edits.createVendor.mutateAsync(input))}
          pending={edits.updateVendor.isPending || edits.createVendor.isPending}
          vendor={vendor.row}
        />
      ) : null}
    </>
  );
}

// ── Stock ─────────────────────────────────────────────────────────────────

const STOCK_COLUMNS: Array<Column<StockItemRow>> = [
  { key: 'code', header: 'Code', cell: (row) => row.code, className: 'whitespace-nowrap' },
  {
    key: 'item',
    header: 'Item',
    primary: true,
    cell: (row) => (
      <span className="grid gap-0.5">
        <span className="font-medium">{row.name}</span>
        <span className="text-muted-foreground text-xs">{row.category ? `${row.category.name} · ${row.unit}` : row.unit}</span>
      </span>
    ),
  },
  { key: 'company', header: 'Company', hideBelow: 'lg', cell: (row) => row.company?.name ?? EMPTY },
  { key: 'stockrooms', header: 'Stockroom', numeric: true, hideBelow: 'md', cell: (row) => formatCount(row.inStockrooms) },
  { key: 'vans', header: 'In vans', numeric: true, hideBelow: 'md', cell: (row) => formatCount(row.inVans) },
  { key: 'onHand', header: 'On hand', numeric: true, cell: (row) => <span className="font-semibold">{formatCount(row.onHand)}</span> },
  { key: 'reorder', header: 'Reorder at', numeric: true, hideBelow: 'sm', cell: (row) => (row.reorderLevel ? formatCount(row.reorderLevel) : EMPTY) },
  { key: 'value', header: 'Value', numeric: true, hideBelow: 'xl', cell: (row) => formatMoney(row.valueCents) },
  { key: 'status', header: 'Stock', cell: (row) => <StockStatusBadge item={row} /> },
];

const SHOWN: { value: string; label: string; keeps: (row: StockItemRow) => boolean }[] = [
  { value: 'in-use', label: 'Items in use', keeps: (row) => row.active },
  { value: 'low', label: 'Low or out', keeps: (row) => row.active && row.status !== 'ENOUGH' },
  { value: 'off', label: 'Switched off', keeps: (row) => !row.active },
];

function StockTab({
  items,
  companies,
  state,
  setState,
  canManage,
  onAdd,
}: {
  items: StockItemRow[];
  companies: readonly { tenantId: string; name: string }[];
  state: { company: string; show: string; q: string };
  setState: (next: Partial<{ company: string; show: string; q: string }>) => void;
  canManage: boolean;
  onAdd: () => void;
}) {
  if (!items.length)
    return (
      <EmptyState
        description={canManage ? 'Add the first item the office stocks, then enter what is on hand as its opening balance.' : 'Nothing has been added to the inventory yet.'}
        icon={BoxesIcon}
        title="No items yet"
      >
        {canManage ? <Button onClick={onAdd}>New item</Button> : null}
      </EmptyState>
    );

  const summary = stockSummary(items);
  const shown = SHOWN.find((option) => option.value === state.show) ?? SHOWN[0]!;
  const words = state.q.trim().toLowerCase();
  const rows = items.filter(
    (row) =>
      shown.keeps(row) &&
      (state.company === ALL || row.company?.tenantId === state.company) &&
      (!words || `${row.code} ${row.name} ${row.category?.name ?? ''}`.toLowerCase().includes(words)),
  );

  return (
    <div className="grid gap-4">
      <StatGroup columns="grid-cols-1 sm:grid-cols-3">
        <Stat label="Items" value={formatCount(summary.items)} />
        <Stat label="Low or out" tone={summary.lowOrOut ? 'warning' : 'default'} value={formatCount(summary.lowOrOut)} />
        <Stat detail="What is on hand, at what it cost" label="Stock value" value={formatMoney(summary.valueCents)} />
      </StatGroup>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="stock-show">Show</Label>
          <Select onValueChange={(show) => setState({ show })} value={shown.value}>
            <SelectTrigger className="w-44" id="stock-show">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SHOWN.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {companies.length ? (
          <div className="grid gap-1.5">
            <Label htmlFor="stock-company">Company</Label>
            <Select onValueChange={(company) => setState({ company })} value={state.company}>
              <SelectTrigger className="w-52" id="stock-company">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All companies</SelectItem>
                {companies.map((company) => (
                  <SelectItem key={company.tenantId} value={company.tenantId}>
                    {company.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="ml-auto grid w-full gap-1.5 sm:w-64">
          <Label htmlFor="stock-search">Search items</Label>
          <Input id="stock-search" onChange={(event) => setState({ q: event.target.value })} placeholder="Code, name or category" type="search" value={state.q} />
        </div>
      </div>

      {rows.length ? (
        <DataTable columns={STOCK_COLUMNS} label="Stock on hand" rowHref={(row) => `/inventory/items/${row.id}`} rowKey={(row) => row.id} rows={rows} />
      ) : (
        <EmptyState description="No item matches what is chosen above." icon={BoxesIcon} title="Nothing to show" />
      )}
      <p className="text-muted-foreground text-xs">
        On hand is added up from the movements and cannot be typed here. Open an item to enter its opening balance or reverse a movement.
      </p>
    </div>
  );
}

// ── Categories ────────────────────────────────────────────────────────────

const CATEGORY_COLUMNS: Array<Column<StockCategoryRow>> = [
  { key: 'name', header: 'Category', primary: true, cell: (row) => <span className="font-medium">{row.name}</span> },
  { key: 'prefix', header: 'Prefix', cell: (row) => row.prefix },
  { key: 'next', header: 'Next code', cell: (row) => row.nextCode },
  { key: 'items', header: 'Items', numeric: true, cell: (row) => formatCount(row.itemCount) },
  { key: 'status', header: 'Status', cell: (row) => <InUseBadge active={row.active} /> },
];

// ── Places ────────────────────────────────────────────────────────────────

const PLACE_COLUMNS: Array<Column<StockPlaceRow>> = [
  { key: 'name', header: 'Place', primary: true, cell: (row) => <span className="font-medium">{row.name}</span> },
  { key: 'kind', header: 'Kind', cell: (row) => (row.kind === 'VAN' ? 'Van' : 'Stockroom') },
  { key: 'technician', header: 'Technician', cell: (row) => row.technicianName ?? EMPTY },
  { key: 'status', header: 'Status', cell: (row) => <InUseBadge active={row.active} /> },
];

function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button aria-label={label} onClick={onClick} size="icon-sm" variant="ghost">
      <PencilIcon />
    </Button>
  );
}

function PlacesTab({ enabled, canManage, onEdit }: { enabled: boolean; canManage: boolean; onEdit: (row: StockPlaceRow) => void }) {
  const places = useStockPlaces(enabled);
  if (places.isError) return <ErrorState error={places.error} retry={() => void places.refetch()} />;
  if (!places.data) return <DataTableSkeleton columns={PLACE_COLUMNS} label="Loading places" rows={3} />;
  if (!places.data.places.length)
    return (
      <EmptyState
        description={canManage ? 'Add the stockroom first, then a place for each van that carries stock.' : 'No place has been added yet.'}
        icon={WarehouseIcon}
        title="No places yet"
      />
    );
  return (
    <DataTable
      actions={canManage ? (row) => <EditButton label={`Edit ${row.name}`} onClick={() => onEdit(row)} /> : undefined}
      columns={PLACE_COLUMNS}
      label="Places stock is kept"
      rowKey={(row) => row.id}
      rows={places.data.places}
    />
  );
}

/** Its own component so the technicians are read only when the form is open. */
function PlaceEditor({ editing, onClose }: { editing: { row?: StockPlaceRow }; onClose: () => void }) {
  const places = useStockPlaces(true);
  const { createPlace, updatePlace } = useInventoryEdits();
  const row = editing.row;
  if (!places.data) return null;
  return (
    <PlaceDialog
      error={(row ? updatePlace : createPlace).error}
      onClose={onClose}
      onSave={(input) => (row ? updatePlace.mutateAsync({ placeId: row.id, input }) : createPlace.mutateAsync(input))}
      pending={updatePlace.isPending || createPlace.isPending}
      place={row}
      technicians={places.data.technicians}
    />
  );
}

// ── Vendors ───────────────────────────────────────────────────────────────

const VENDOR_COLUMNS: Array<Column<VendorRow>> = [
  { key: 'name', header: 'Vendor', primary: true, cell: (row) => <span className="font-medium">{row.name}</span> },
  { key: 'contact', header: 'Contact', hideBelow: 'md', cell: (row) => row.contactName ?? EMPTY },
  { key: 'email', header: 'Email', hideBelow: 'lg', cell: (row) => row.email ?? EMPTY },
  { key: 'phone', header: 'Phone', hideBelow: 'md', cell: (row) => row.phone ?? EMPTY },
  { key: 'terms', header: 'Terms', hideBelow: 'sm', cell: (row) => row.terms ?? EMPTY },
  { key: 'status', header: 'Status', cell: (row) => <InUseBadge active={row.active} /> },
];

function VendorsTab({ enabled, canManage, onEdit }: { enabled: boolean; canManage: boolean; onEdit: (row: VendorRow) => void }) {
  const vendors = useVendors(enabled);
  if (vendors.isError) return <ErrorState error={vendors.error} retry={() => void vendors.refetch()} />;
  if (!vendors.data) return <DataTableSkeleton columns={VENDOR_COLUMNS} label="Loading vendors" rows={3} />;
  if (!vendors.data.vendors.length)
    return <EmptyState description={canManage ? 'Add who the office buys stock from.' : 'No vendor has been added yet.'} icon={TruckIcon} title="No vendors yet" />;
  return (
    <DataTable
      actions={canManage ? (row) => <EditButton label={`Edit ${row.name}`} onClick={() => onEdit(row)} /> : undefined}
      columns={VENDOR_COLUMNS}
      label="Vendors"
      rowKey={(row) => row.id}
      rows={vendors.data.vendors}
    />
  );
}
