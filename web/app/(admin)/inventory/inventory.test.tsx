import type { StockItemDetail, StockItemRow, StockList, StockMovementRow } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import StockItemPage from './items/[itemId]/page';
import InventoryPage from './page';

/** Inventory, phase 1 (2026-11-19). Every item, place, person and price invented. */

const mutation = () => ({ mutateAsync: vi.fn(async () => ({})), isPending: false, error: null, reset: vi.fn() });
const hooks = vi.hoisted(() => ({
  useStock: vi.fn(),
  useStockItem: vi.fn(),
  useStockPlaces: vi.fn(),
  useVendors: vi.fn(),
  useInventoryEdits: vi.fn(),
  useStockSlips: vi.fn(),
  // Asks from the trucks (2026-11-24): none waiting here.
  useTruckAsks: vi.fn(() => ({ isError: false, data: { asks: [] } })),
  useTruckKeepLevels: vi.fn(),
  useTruckKeepEdits: vi.fn(),
  useStockSlipChoices: vi.fn(),
  useStockSlipEdits: vi.fn(),
  useStockCounts: vi.fn(),
  useStockCountChoices: vi.fn(),
  useStockCountEdits: vi.fn(),
  useInventoryMonitoring: vi.fn(),
}));
vi.mock('@/lib/inventory-queries', () => hooks);
const url = vi.hoisted(() => ({ state: { tab: 'stock', company: 'all', show: 'in-use', q: '', period: '30d', technician: '' }, set: vi.fn() }));
vi.mock('@/lib/url-state', () => ({ useUrlState: () => [url.state, url.set, vi.fn()] }));
const account = vi.hoisted(() => ({ permissions: new Set<string>() }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: (permission: string) => account.permissions.has(permission) }) }));
vi.mock('next/navigation', () => ({ useParams: () => ({ itemId: 'item-filter' }) }));

const row = (over: Partial<StockItemRow> = {}): StockItemRow => ({
  id: 'item-filter',
  code: 'FLT-16251',
  name: 'Filter 16x25x1',
  unit: 'each',
  category: { id: 'cat-filters', name: 'Filters' },
  company: { tenantId: 'tenant-thmp', name: 'THMP' },
  reorderLevel: 24,
  reorderQuantity: 48,
  usualVendor: null,
  lineType: { id: 'type-item', code: 'ITEM', name: 'Item', keepsStock: true },
  priceCents: 342,
  active: true,
  onHand: 27,
  inStockrooms: 18,
  inVans: 9,
  valueCents: 9234,
  status: 'ENOUGH',
  ...over,
});
const list = (items: StockItemRow[]): StockList => ({
  items,
  places: [
    { id: 'place-stockroom', name: 'Stockroom', code: 'STOCKROOM', kind: 'STOCKROOM', technicianId: null, technicianName: null, itemsHeld: 2, active: true },
    { id: 'place-shed', name: 'Old shed', code: 'OLD-SHED', kind: 'STOCKROOM', technicianId: null, technicianName: null, itemsHeld: 0, active: false },
  ],
  companies: [{ tenantId: 'tenant-thmp', name: 'THMP' }],
  vendors: [],
  lineTypes: [
    { id: 'type-item', code: 'ITEM', name: 'Item', keepsStock: true, active: true },
    { id: 'type-service', code: 'SERVICE', name: 'Service', keepsStock: false, active: true },
  ],
  categories: [
    { id: 'cat-filters', name: 'Filters', prefix: 'FLT', nextCode: 'FLT-0003', itemCount: 1, active: true },
    { id: 'cat-pest', name: 'Pest products', prefix: 'PST', nextCode: 'PST-0001', itemCount: 0, active: true },
    { id: 'cat-old', name: 'Old parts', prefix: 'OLD', nextCode: 'OLD-0004', itemCount: 3, active: false },
  ],
});
const movement = (over: Partial<StockMovementRow> = {}): StockMovementRow => ({
  id: 'movement-1',
  kind: 'OPENING_BALANCE',
  day: '2026-11-18',
  placeId: 'place-stockroom',
  placeName: 'Stockroom',
  quantity: 18,
  unitCostCents: 342,
  onHandAfter: 18,
  note: null,
  by: 'Office Coordinator',
  createdAt: '2026-11-18T15:00:00.000Z',
  reversesId: null,
  reversedById: null,
  removalReason: null,
  ...over,
});

let edits: Record<string, ReturnType<typeof mutation>>;
const ITEMS = [
  row(),
  row({ id: 'item-battery', code: 'BAT-9V', name: 'Battery, 9 V', category: null, company: null, onHand: 5, inStockrooms: 3, inVans: 2, reorderLevel: 12, valueCents: 925, status: 'LOW' }),
  row({ id: 'item-old', code: 'OLD-1', name: 'Discontinued filter', onHand: 0, inStockrooms: 0, inVans: 0, valueCents: 0, status: 'OUT', active: false }),
];

beforeEach(() => {
  url.state = { tab: 'stock', company: 'all', show: 'in-use', q: '', period: '30d', technician: '' };
  url.set.mockReset();
  account.permissions = new Set(['inventory:read', 'inventory:manage']);
  edits = Object.fromEntries(
    ['createItem', 'updateItem', 'createCategory', 'updateCategory', 'enterOpeningBalance', 'reverseMovement', 'removeStock', 'deleteItem', 'createPlace', 'updatePlace', 'createVendor', 'updateVendor'].map((name) => [
      name,
      mutation(),
    ]),
  );
  hooks.useInventoryEdits.mockReturnValue(edits);
  hooks.useStock.mockReturnValue({ isLoading: false, isError: false, data: list(ITEMS) });
  hooks.useStockPlaces.mockReturnValue({ isError: false, data: undefined });
  hooks.useVendors.mockReturnValue({ isError: false, data: undefined });
  hooks.useStockSlips.mockReturnValue({ isError: false, data: { slips: [] } });
  hooks.useStockSlipChoices.mockReturnValue({ isError: false, data: undefined });
  hooks.useStockSlipEdits.mockReturnValue({ post: mutation(), reverse: mutation() });
  hooks.useStockCounts.mockReturnValue({ isError: false, data: { counts: [], schedule: [{ kind: 'MONTHLY', due: '2026-11-30', current: null, lastPosted: null }] } });
  hooks.useStockCountEdits.mockReturnValue({ start: mutation() });
});

describe('the withdrawals tab', () => {
  it('lists the slips for anybody who sees the inventory, and gives the form only to who may record', () => {
    url.state = { ...url.state, tab: 'withdrawals' };
    const { unmount } = render(<InventoryPage />);
    expect(screen.getByText('No slips yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New item' })).toBeNull();
    // Asked for with the read switched off: nothing is read (2026-11-24).
    expect(hooks.useStockSlipChoices.mock.calls.every(([enabled]) => !enabled)).toBe(true);
    unmount();

    account.permissions = new Set(['inventory:read', 'inventory:withdraw']);
    render(<InventoryPage />);
    expect(hooks.useStockSlipChoices).toHaveBeenCalledWith(true, null);
  });
});

describe('the reorder and usage tab', () => {
  it('reads the period in the address, and one technician\'s slips when the Withdrawals tab is opened from a name', () => {
    hooks.useInventoryMonitoring.mockReturnValue({ isError: false, data: undefined });
    url.state = { ...url.state, tab: 'reorder', period: 'quarter' };
    const { unmount } = render(<InventoryPage />);
    expect(hooks.useInventoryMonitoring).toHaveBeenCalledWith(true, 'quarter');
    expect(screen.queryByRole('button', { name: 'New item' })).toBeNull();
    unmount();

    url.state = { ...url.state, tab: 'withdrawals', technician: 'tech-ana' };
    render(<InventoryPage />);
    expect(hooks.useStockSlips).toHaveBeenCalledWith(true, 'tech-ana');
    expect(screen.getByRole('link', { name: "Show everybody's" }).getAttribute('href')).toBe('/inventory?tab=withdrawals');
  });
});

describe('the item codes tab', () => {
  it('lists the codes from the stock already read, with the form only for the stock keeper', () => {
    url.state = { ...url.state, tab: 'codes' };
    const { unmount } = render(<InventoryPage />);
    expect(within(screen.getByRole('table', { name: 'Item codes' })).getByRole('row', { name: /FLT-16251/ }).textContent).toContain('$3.42');
    expect(screen.getByRole('form', { name: 'New item code' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New item' })).toBeNull();
    // The Stock tab's read: nothing more is asked for.
    expect(hooks.useStock).toHaveBeenCalledWith();
    unmount();

    account.permissions = new Set(['inventory:read']);
    render(<InventoryPage />);
    expect(screen.queryByRole('form', { name: 'New item code' })).toBeNull();
  });
});

describe('removing stock and deleting an item code (2026-11-24)', () => {
  it('offers Remove stock on each item with stock in it, to whoever manages stock', () => {
    hooks.useStockItem.mockReturnValue({ isLoading: false, isError: false, data: { item: ITEMS[0], levels: [{ placeId: 'place-stockroom', placeName: 'Stockroom', kind: 'STOCKROOM', quantity: 18 }], averageCostCents: 342, movements: [], movementsTotal: 1 } });
    const { unmount } = render(<InventoryPage />);
    const table = screen.getByRole('table', { name: 'Stock on hand' });
    expect(within(table).getByRole('button', { name: 'Remove stock of BAT-9V' })).toBeTruthy();
    fireEvent.click(within(table).getByRole('button', { name: 'Remove stock of FLT-16251' }));
    expect(screen.getByRole('dialog', { name: 'Remove stock of FLT-16251' })).toBeTruthy();
    unmount();

    account.permissions = new Set(['inventory:read']);
    render(<InventoryPage />);
    expect(screen.queryByRole('button', { name: /^Remove stock/ })).toBeNull();
  });

  it('offers Delete on the item codes to whoever keeps them and manages stock, and to nobody else', () => {
    url.state = { ...url.state, tab: 'codes' };
    const { unmount } = render(<InventoryPage />);
    expect(screen.getByRole('button', { name: 'Delete FLT-16251' })).toBeTruthy();
    expect(screen.getByText(/Deleted: gone from every list, picker, label sheet and the phone/)).toBeTruthy();
    unmount();

    // The code admin keeps the codes but moves no stock: Edit, and no Delete.
    account.permissions = new Set(['inventory:read', 'purchasing:codes']);
    hooks.useStock.mockReturnValue({ isLoading: false, isError: false, data: { ...list(ITEMS), keeps: { items: true, categories: false, places: false, vendors: false } } });
    render(<InventoryPage />);
    expect(screen.getByRole('button', { name: 'Edit FLT-16251' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
  });
});

describe('the counts tab', () => {
  it('shows when the counts are due to anybody who sees the inventory, and "Start a count" only to who may count', () => {
    url.state = { ...url.state, tab: 'counts' };
    const { unmount } = render(<InventoryPage />);
    expect(screen.getByRole('article', { name: 'Monthly count' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Start/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New item' })).toBeNull();
    unmount();

    account.permissions = new Set(['inventory:read', 'inventory:count']);
    render(<InventoryPage />);
    expect(screen.getByRole('button', { name: 'Start the monthly count' })).toBeTruthy();
  });
});

describe('the stock list', () => {
  it('shows what is on hand of each item in use, and opens the item', () => {
    render(<InventoryPage />);

    const table = screen.getByRole('table', { name: 'Stock on hand' });
    const filter = within(table).getByRole('row', { name: /FLT-16251/ });
    expect(within(filter).getByText('27')).toBeTruthy();
    expect(within(filter).getByText('Enough')).toBeTruthy();
    expect(within(table).getByRole('link', { name: /Filter 16x25x1/ }).getAttribute('href')).toBe('/inventory/items/item-filter');
    expect(within(table).getByRole('row', { name: /BAT-9V/ }).textContent).toContain('Low');
    expect(within(table).queryByText('Discontinued filter')).toBeNull();
  });

  it('adds up the items in use, those low or out, and the value on hand', () => {
    render(<InventoryPage />);

    expect(screen.getByText('Low or out').closest('div')?.parentElement?.textContent).toContain('1');
    expect(screen.getByText('$101.59')).toBeTruthy();
  });

  it('narrows to low or out, to switched off, and by a search, from the rows in hand', () => {
    url.state = { ...url.state, show: 'low' };
    const { unmount } = render(<InventoryPage />);
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText('Battery, 9 V')).toBeTruthy();
    unmount();

    url.state = { ...url.state, show: 'off' };
    const off = render(<InventoryPage />);
    expect(screen.getByText('Discontinued filter')).toBeTruthy();
    off.unmount();

    url.state = { ...url.state, show: 'in-use', q: 'batt' };
    render(<InventoryPage />);
    expect(screen.queryByText('Filter 16x25x1')).toBeNull();
    expect(screen.getByText('Battery, 9 V')).toBeTruthy();
    expect(hooks.useStock).toHaveBeenCalledWith();
  });

  it('reads places and vendors only on their own tabs', () => {
    render(<InventoryPage />);
    expect(hooks.useStockPlaces).not.toHaveBeenCalled();
    expect(hooks.useVendors).not.toHaveBeenCalled();
  });

  it('offers nothing to change to somebody who may only look', () => {
    account.permissions = new Set(['inventory:read']);
    render(<InventoryPage />);
    expect(screen.queryByRole('button', { name: 'New item' })).toBeNull();
  });

  // Purchasing Setup (2026-11-21): each list is changed by the role the office gives it, as the server says.
  it('offers each list to whoever keeps it, not to every stock keeper', () => {
    account.permissions = new Set(['inventory:read', 'inventory:manage']);
    hooks.useStock.mockReturnValue({ isLoading: false, isError: false, data: { ...list(ITEMS), keeps: { items: false, categories: true, places: true, vendors: false } } });
    const { unmount } = render(<InventoryPage />);
    expect(screen.queryByRole('button', { name: 'New item' })).toBeNull();
    unmount();

    url.state = { ...url.state, tab: 'categories' };
    render(<InventoryPage />);
    expect(screen.getByRole('button', { name: 'New category' })).toBeTruthy();
  });

  it('picks what an item is counted in from the units of measure, once there are any', async () => {
    hooks.useStock.mockReturnValue({ isLoading: false, isError: false, data: { ...list(ITEMS), units: [{ code: 'EA', name: 'each' }, { code: 'BOX', name: 'box' }] } });
    render(<InventoryPage />);
    fireEvent.click(screen.getByRole('button', { name: 'New item' }));
    const dialog = screen.getByRole('dialog', { name: 'New item' });
    expect(within(dialog).getByLabelText('Counted in').tagName).toBe('BUTTON');
    expect(within(dialog).getByLabelText('Counted in').textContent).toBe('each');

    fireEvent.keyDown(within(dialog).getByLabelText('Counted in'), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: 'box' }));
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Gloves' } });
    fireEvent.keyDown(within(dialog).getByLabelText('Category'), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: 'Filters (FLT)' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add item' }));
    await waitFor(() => expect(edits.createItem!.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ name: 'Gloves', unit: 'box' })));
  });

  it('adds an item under a category, which gives it its code: nowhere to type a code or on hand', async () => {
    render(<InventoryPage />);
    fireEvent.click(screen.getByRole('button', { name: 'New item' }));

    const dialog = screen.getByRole('dialog', { name: 'New item' });
    expect(within(dialog).queryByLabelText(/on hand/i)).toBeNull();
    expect(within(dialog).queryByLabelText(/^code$/i)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: ' Filter 20x20x1 ' } });
    fireEvent.change(within(dialog).getByLabelText('Reorder at'), { target: { value: '24' } });
    const add = within(dialog).getByRole('button', { name: 'Add item' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);

    fireEvent.keyDown(within(dialog).getByLabelText('Category'), { key: 'ArrowDown' });
    expect(screen.queryByRole('option', { name: /Old parts/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Filters (FLT)' }));
    expect(within(dialog).getByText('Its code will be FLT-0003.')).toBeTruthy();
    fireEvent.click(add);

    await waitFor(() => expect(edits.createItem!.mutateAsync).toHaveBeenCalledWith({ name: 'Filter 20x20x1', unit: 'each', categoryId: 'cat-filters', reorderLevel: 24, reorderQuantity: 0 }));
  });

  it('lists the categories with the code each will give next, and adds one with a prefix', async () => {
    url.state = { ...url.state, tab: 'categories' };
    render(<InventoryPage />);

    const table = screen.getByRole('table', { name: 'Categories and their codes' });
    expect(within(table).getByRole('row', { name: /Filters/ }).textContent).toContain('FLT-0003');
    fireEvent.click(screen.getByRole('button', { name: 'New category' }));
    const dialog = screen.getByRole('dialog', { name: 'New category' });
    const add = within(dialog).getByRole('button', { name: 'Add category' }) as HTMLButtonElement;
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Parts' } });
    fireEvent.change(within(dialog).getByLabelText('Prefix'), { target: { value: 'p-1' } });
    expect(add.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText('Prefix'), { target: { value: 'prt' } });
    expect(within(dialog).getByText('Its first item will be PRT-0001.')).toBeTruthy();
    fireEvent.click(add);
    await waitFor(() => expect(edits.createCategory!.mutateAsync).toHaveBeenCalledWith({ name: 'Parts', prefix: 'PRT' }));
  });

  it('keeps the prefix of a category that has given out a code', () => {
    url.state = { ...url.state, tab: 'categories' };
    render(<InventoryPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Filters' }));

    const dialog = screen.getByRole('dialog', { name: 'Edit category' });
    expect((within(dialog).getByLabelText('Prefix') as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).getByText(/already given out codes starting FLT/)).toBeTruthy();
  });
});

describe('one item', () => {
  const detail = (over: Partial<StockItemDetail> = {}): StockItemDetail => ({
    item: row({ onHand: 18, inStockrooms: 18, inVans: 0, valueCents: 6156 }),
    levels: [{ placeId: 'place-stockroom', placeName: 'Stockroom', kind: 'STOCKROOM', quantity: 18 }],
    averageCostCents: 342,
    movements: [movement()],
    movementsTotal: 1,
    ...over,
  });
  const mount = (data = detail()) => {
    hooks.useStockItem.mockReturnValue({ isLoading: false, isError: false, data });
    return render(<StockItemPage />);
  };

  it('shows where it is, what it cost, and each movement with the on hand it left', () => {
    mount();

    expect(screen.getByRole('heading', { name: 'On hand: 18' })).toBeTruthy();
    expect(screen.getByText('$3.42', { selector: 'dd' })).toBeTruthy();
    const line = within(screen.getByRole('table', { name: 'Movements of Filter 16x25x1' })).getByRole('row', { name: /Opening balance/ });
    expect(line.textContent).toContain('Stockroom');
    expect(line.textContent).toContain('Office Coordinator');
  });

  it('reverses a movement only with a reason, and never offers to edit one', async () => {
    mount();

    expect(screen.queryByRole('button', { name: /edit .*movement/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Reverse the opening balance/ }));
    const dialog = screen.getByRole('dialog', { name: 'Reverse this movement?' });
    const confirm = within(dialog).getByRole('button', { name: 'Reverse movement' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText('Why'), { target: { value: ' Counted the wrong shelf ' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(edits.reverseMovement!.mutateAsync).toHaveBeenCalledWith({ movementId: 'movement-1', input: { reason: 'Counted the wrong shelf' } }));
  });

  it('offers no reversal of a reversal, or of a movement already reversed', () => {
    mount(
      detail({
        movements: [
          movement({ id: 'movement-2', kind: 'REVERSAL', quantity: -18, onHandAfter: 0, reversesId: 'movement-1', note: 'Counted the wrong shelf' }),
          movement({ reversedById: 'movement-2' }),
        ],
        movementsTotal: 2,
      }),
    );

    expect(screen.queryByRole('button', { name: /^Reverse/ })).toBeNull();
    expect(screen.getByText('Reversed')).toBeTruthy();
  });

  it('enters an opening balance in whole units and cents, with one key for the entry', async () => {
    mount(detail({ movements: [], movementsTotal: 0, levels: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Enter opening balance' }));

    const dialog = screen.getByRole('dialog', { name: 'Opening balance' });
    const submit = within(dialog).getByRole('button', { name: 'Enter opening balance' });
    fireEvent.change(within(dialog).getByLabelText('Quantity, in each'), { target: { value: '1.5' } });
    fireEvent.change(within(dialog).getByLabelText('Cost of one'), { target: { value: '3.42' } });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText('Quantity, in each'), { target: { value: '18' } });
    expect(within(dialog).getByText('$61.56 in all.')).toBeTruthy();
    fireEvent.click(submit);
    await waitFor(() => expect(edits.enterOpeningBalance!.mutateAsync).toHaveBeenCalledTimes(1));
    expect(edits.enterOpeningBalance!.mutateAsync).toHaveBeenCalledWith({
      itemId: 'item-filter',
      input: { placeId: 'place-stockroom', quantity: 18, unitCostCents: 342, requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    });
  });

  it('offers no day after today in Texas, and says so to somebody whose own calendar is a day ahead (2026-11-19)', () => {
    // 00:55 on November 20 in Manila: 10:55 on November 19 in Texas.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T16:55:00.000Z'));
    try {
      mount(detail({ movements: [], movementsTotal: 0, levels: [] }));
      fireEvent.click(screen.getByRole('button', { name: 'Enter opening balance' }));
      const dialog = screen.getByRole('dialog', { name: 'Opening balance' });
      const day = within(dialog).getByLabelText('As of') as HTMLInputElement;
      expect(day.max).toBe('2026-11-19');
      fireEvent.change(within(dialog).getByLabelText('Quantity, in each'), { target: { value: '25' } });
      fireEvent.change(within(dialog).getByLabelText('Cost of one'), { target: { value: '50' } });
      fireEvent.change(day, { target: { value: '2026-11-20' } });
      expect(within(dialog).getByText(/That day has not come yet in Texas\. It is .*19.* there\./)).toBeTruthy();
      expect((within(dialog).getByRole('button', { name: 'Enter opening balance' }) as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(day, { target: { value: '2026-11-19' } });
      expect(within(dialog).queryByText(/has not come yet/)).toBeNull();
      expect((within(dialog).getByRole('button', { name: 'Enter opening balance' }) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows stock removed with its reason, reverses it, and offers Remove stock to the stock keeper (2026-11-24)', async () => {
    mount(
      detail({
        movements: [movement({ id: 'movement-2', kind: 'REMOVAL', quantity: -5, onHandAfter: 13, removalReason: 'DAMAGED', note: 'Fell off the shelf' }), movement()],
        movementsTotal: 2,
      }),
    );
    const line = within(screen.getByRole('table', { name: 'Movements of Filter 16x25x1' })).getByRole('row', { name: /Removed · Damaged/ });
    expect(line.textContent).toContain('Fell off the shelf');
    expect(screen.getByRole('button', { name: 'Remove stock' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Reverse the removal of/ }));
    const dialog = screen.getByRole('dialog', { name: 'Reverse this movement?' });
    expect(dialog.textContent).toContain('This puts 5 of FLT-16251 back into Stockroom');
  });

  it('shows the ledger and nothing to press to somebody who may only look', () => {
    account.permissions = new Set(['inventory:read']);
    mount();
    expect(screen.queryByRole('button', { name: 'Remove stock' })).toBeNull();

    expect(screen.getByRole('table', { name: 'Movements of Filter 16x25x1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit item' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enter opening balance' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reverse/ })).toBeNull();
  });

  it('lets the keeper of the item codes edit the item, but only a stock keeper enter stock (2026-11-21)', () => {
    account.permissions = new Set(['inventory:read', 'purchasing:codes']);
    hooks.useStock.mockReturnValue({ isLoading: false, isError: false, data: { ...list(ITEMS), keeps: { items: true, categories: false, places: false, vendors: false } } });
    mount();

    expect(screen.getByRole('button', { name: 'Edit item' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enter opening balance' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reverse/ })).toBeNull();
  });
});
