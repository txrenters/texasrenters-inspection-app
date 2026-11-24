import type { StockItemDeletion, StockItemDetail, StockItemRow } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DeleteItemDialog, RemoveStockDialog } from './remove-and-delete';

/** Removing stock and deleting an item code (2026-11-24). Every item, place and document invented. */

const hooks = vi.hoisted(() => ({ useInventoryEdits: vi.fn(), useStockItem: vi.fn(), useStockItemDeletion: vi.fn() }));
vi.mock('@/lib/inventory-queries', () => hooks);

const item = (over: Partial<StockItemRow> = {}): StockItemRow => ({
  id: 'item-filter',
  code: 'FLT-16251',
  name: 'Filter 16x25x1',
  unit: 'pcs',
  category: { id: 'cat-filters', name: 'Filters' },
  company: null,
  reorderLevel: 24,
  reorderQuantity: 48,
  usualVendor: null,
  lineType: { id: 'type-item', code: 'ITEM', name: 'Item', keepsStock: true },
  priceCents: 342,
  active: true,
  onHand: 24,
  inStockrooms: 20,
  inVans: 4,
  valueCents: 24 * 342,
  status: 'ENOUGH',
  ...over,
});
const detail = (levels: StockItemDetail['levels']): StockItemDetail => ({ item: item(), levels, averageCostCents: 342, movements: [], movementsTotal: 2 });
const LEVELS: StockItemDetail['levels'] = [
  { placeId: 'place-store', placeName: 'Storeroom', kind: 'STOCKROOM', quantity: 20 },
  { placeId: 'place-van', placeName: 'Truck 1', kind: 'VAN', quantity: 4 },
];

type Mutation = { mutateAsync: ReturnType<typeof vi.fn>; isPending: boolean; error: Error | null };
let removeStock: Mutation;
let deleteItem: Mutation;

beforeEach(() => {
  removeStock = { mutateAsync: vi.fn(async () => detail([])), isPending: false, error: null };
  deleteItem = { mutateAsync: vi.fn(async () => ({ items: [] })), isPending: false, error: null };
  hooks.useInventoryEdits.mockReturnValue({ removeStock, deleteItem });
  hooks.useStockItem.mockReturnValue({ isLoading: false, isError: false, data: detail(LEVELS) });
});

const removeButton = () => screen.getByRole('button', { name: /^Remove/ }) as HTMLButtonElement;

describe('removing stock', () => {
  it('starts at all of the first place, says what is left, and sends the reason with its key', async () => {
    const onClose = vi.fn();
    render(<RemoveStockDialog itemId="item-filter" onClose={onClose} />);
    expect(screen.getByRole('heading', { name: 'Remove stock of FLT-16251' })).toBeTruthy();
    expect((screen.getByLabelText('How many, in pcs') as HTMLInputElement).value).toBe('20');
    expect(removeButton().textContent).toBe('Remove 20');

    fireEvent.change(screen.getByLabelText('How many, in pcs'), { target: { value: '5' } });
    expect(screen.getByText(/Storeroom goes from 20 to 15\./)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Damaged'));
    fireEvent.click(removeButton());

    await waitFor(() =>
      expect(removeStock.mutateAsync).toHaveBeenCalledWith({ itemId: 'item-filter', input: { placeId: 'place-store', quantity: 5, reason: 'DAMAGED', note: null, requestKey: expect.any(String) } }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('refuses more than the place holds, and needs words for Other', () => {
    render(<RemoveStockDialog itemId="item-filter" onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('How many, in pcs'), { target: { value: '25' } });
    expect(screen.getByText('Storeroom has 20 of FLT-16251.')).toBeTruthy();
    expect(removeButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'All 20' }));
    expect(removeButton().disabled).toBe(false);
    fireEvent.click(screen.getByLabelText('Other, say why'));
    expect(removeButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'Left at a house' } });
    expect(removeButton().disabled).toBe(false);
  });

  it('from every place takes all of it', async () => {
    render(<RemoveStockDialog itemId="item-filter" onClose={vi.fn()} />);
    fireEvent.keyDown(screen.getByLabelText('From'), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: 'Every place · 24 on hand' }));

    const quantity = screen.getByLabelText('How many, in pcs') as HTMLInputElement;
    expect(quantity.disabled).toBe(true);
    expect(quantity.value).toBe('24');
    expect(screen.getByText(/Storeroom goes from 20 to 0, Truck 1 goes from 4 to 0\./)).toBeTruthy();
    fireEvent.click(removeButton());
    await waitFor(() => expect(removeStock.mutateAsync).toHaveBeenCalledWith({ itemId: 'item-filter', input: expect.objectContaining({ placeId: null, quantity: 24, reason: 'TESTING' }) }));
  });

  it('says so when there is none anywhere, and offers nothing to remove', () => {
    hooks.useStockItem.mockReturnValue({ isLoading: false, isError: false, data: detail([]) });
    render(<RemoveStockDialog itemId="item-filter" onClose={vi.fn()} />);
    expect(screen.getByText('There is none of FLT-16251 anywhere to remove.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
  });

  it('shows what the server says when it is refused', () => {
    removeStock.error = new Error('A yearly count is open, so stock cannot move.');
    render(<RemoveStockDialog itemId="item-filter" onClose={vi.fn()} />);
    expect(screen.getByText('A yearly count is open, so stock cannot move.')).toBeTruthy();
  });
});

const LAPTOP = item({ id: 'item-laptop', code: 'OFF-0002', name: 'Asus Vivobook', unit: 'unit', onHand: 1, inStockrooms: 1, inVans: 0 });
const deletion = (over: Partial<StockItemDeletion> = {}): StockItemDeletion => ({
  item: { id: 'item-laptop', code: 'OFF-0002', name: 'Asus Vivobook', unit: 'unit' },
  neverUsed: false,
  onHand: [{ placeName: 'Storeroom', quantity: 1 }],
  open: [],
  usedOn: [
    { kind: 'REQUISITION', id: 'req-14', number: 'PR-00014' },
    { kind: 'RECEIPT', id: 'rcv-3', number: 'RCV-0003' },
  ],
  usedOnMore: 2,
  ...over,
});
const deleteButton = () => screen.getByRole('button', { name: 'Delete OFF-0002' }) as HTMLButtonElement;

describe('deleting an item code', () => {
  it('says what deleting it would do, and deletes only once its code is typed', async () => {
    hooks.useStockItemDeletion.mockReturnValue({ isLoading: false, isError: false, data: deletion() });
    const onClose = vi.fn();
    render(<DeleteItemDialog item={LAPTOP} onClose={onClose} />);

    expect(screen.getByText('1 in Storeroom')).toBeTruthy();
    expect(screen.getByText(/is removed\s+first, with the reason below\./)).toBeTruthy();
    expect(screen.getByText('OFF-0002 can be given to a new item.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'PR-00014' }).getAttribute('href')).toBe('/purchasing/requisitions/req-14');
    // A receipt is on its order's page: named, not linked.
    expect(screen.queryByRole('link', { name: 'RCV-0003' })).toBeNull();
    expect(screen.getByText(/and 2 more\. Their totals do not change\./)).toBeTruthy();

    expect(deleteButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type OFF-0002 to confirm'), { target: { value: 'OFF-002' } });
    expect(deleteButton().disabled).toBe(true);
    // As a label reads it, in any case.
    fireEvent.change(screen.getByLabelText('Type OFF-0002 to confirm'), { target: { value: 'off-0002' } });
    expect(deleteButton().disabled).toBe(false);
    fireEvent.click(deleteButton());

    await waitFor(() => expect(deleteItem.mutateAsync).toHaveBeenCalledWith({ itemId: 'item-laptop', input: { reason: 'TESTING', note: null, confirmCode: 'off-0002' } }));
    expect(onClose).toHaveBeenCalled();
  });

  it('takes one nothing names out completely', () => {
    hooks.useStockItemDeletion.mockReturnValue({ isLoading: false, isError: false, data: deletion({ neverUsed: true, onHand: [], usedOn: [], usedOnMore: 0 }) });
    render(<DeleteItemDialog item={LAPTOP} onClose={vi.fn()} />);
    expect(screen.getByText(/It is taken out completely, and OFF-0002 is free again\./)).toBeTruthy();
  });

  it('needs words for Other', () => {
    hooks.useStockItemDeletion.mockReturnValue({ isLoading: false, isError: false, data: deletion() });
    render(<DeleteItemDialog item={LAPTOP} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Type OFF-0002 to confirm'), { target: { value: 'OFF-0002' } });
    fireEvent.click(screen.getByLabelText('Other, say why'));
    expect(deleteButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'Two codes for one laptop' } });
    expect(deleteButton().disabled).toBe(false);
  });

  it('while still on something open, names it with a way there, and offers no delete', () => {
    hooks.useStockItemDeletion.mockReturnValue({
      isLoading: false,
      isError: false,
      data: deletion({
        open: [
          { kind: 'REQUISITION', id: 'req-16', number: 'A draft requisition' },
          { kind: 'COUNT', id: 'cnt-4', number: 'CNT-0004' },
          { kind: 'TRUCK_ASK', id: 'ask-1', number: "Truck 1's ask" },
        ],
      }),
    });
    render(<DeleteItemDialog item={LAPTOP} onClose={vi.fn()} />);
    expect(screen.getByText(/OFF-0002 is still on/).textContent).toBe("OFF-0002 is still on A draft requisition, CNT-0004, Truck 1's ask. Finish or cancel those first.");
    expect(screen.getByRole('link', { name: 'CNT-0004' }).getAttribute('href')).toBe('/inventory/counts/cnt-4');
    expect(screen.getByRole('link', { name: "Truck 1's ask" }).getAttribute('href')).toBe('/inventory?tab=withdrawals');
    expect(screen.queryByRole('button', { name: 'Delete OFF-0002' })).toBeNull();
    // The footer's Close, beside the dialog's own corner one.
    expect(screen.getAllByRole('button', { name: 'Close' }).some((button) => button.textContent === 'Close')).toBe(true);
  });
});
