import type { StockCategoryRow, StockItemRow } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ItemCodesTab } from './item-codes-tab';

/** Item codes (2026-11-19). Every item, category, company and price invented. */

const hooks = vi.hoisted(() => ({ useInventoryEdits: vi.fn() }));
vi.mock('@/lib/inventory-queries', () => hooks);

const item = (over: Partial<StockItemRow> = {}): StockItemRow => ({
  id: 'item-filter',
  code: 'FLT-16251',
  name: 'Filter 16x25x1',
  unit: 'pcs',
  category: { id: 'cat-filters', name: 'Filters' },
  company: { tenantId: 'tenant-homes', name: 'Example Home Services LLC' },
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
const ITEMS = [item(), item({ id: 'item-battery', code: 'BAT-9V', name: 'Battery, 9 V', category: { id: 'cat-parts', name: 'Parts' }, priceCents: null }), item({ id: 'item-old', code: 'OLD-0003', name: 'Discontinued filter', priceCents: null, active: false })];
const CATEGORIES: StockCategoryRow[] = [
  { id: 'cat-filters', name: 'Filters', prefix: 'FLT', nextCode: 'FLT-0004', itemCount: 2, active: true },
  { id: 'cat-parts', name: 'Parts', prefix: 'BAT', nextCode: 'BAT-0002', itemCount: 1, active: true },
  { id: 'cat-old', name: 'Old parts', prefix: 'OLD', nextCode: 'OLD-0004', itemCount: 3, active: false },
];
const COMPANIES = [
  { tenantId: 'tenant-homes', name: 'Example Home Services LLC' },
  { tenantId: 'tenant-pest', name: 'Example Pest Co' },
];

const mutation = (answer: unknown = { item: item({ code: 'FLT-20201' }) }) => ({ mutateAsync: vi.fn<(input: unknown) => Promise<unknown>>(async () => answer), isPending: false, error: null as Error | null, reset: vi.fn() });
let createItem: ReturnType<typeof mutation>;
let updateItem: ReturnType<typeof mutation>;
const LINE_TYPES = [
  { id: 'type-item', code: 'ITEM', name: 'Item', keepsStock: true, active: true },
  { id: 'type-service', code: 'SERVICE', name: 'Service', keepsStock: false, active: true },
  { id: 'type-old', code: 'OLD', name: 'Old type', keepsStock: true, active: false },
];
const mount = (over: { canManage?: boolean; companies?: typeof COMPANIES; items?: StockItemRow[]; lineTypes?: typeof LINE_TYPES } = {}) =>
  render(<ItemCodesTab canManage={over.canManage ?? true} categories={CATEGORIES} companies={over.companies ?? COMPANIES} items={over.items ?? ITEMS} lineTypes={over.lineTypes} />);
const pick = (root: HTMLElement, label: string, option: string | RegExp) => {
  fireEvent.keyDown(within(root).getByLabelText(label), { key: 'ArrowDown' });
  fireEvent.click(screen.getByRole('option', { name: option }));
};
const field = (root: HTMLElement, label: string | RegExp) => within(root).getByLabelText(label) as HTMLInputElement;
const add = (form: HTMLElement) => within(form).getByRole('button', { name: 'Add item code' }) as HTMLButtonElement;

beforeEach(() => {
  createItem = mutation();
  updateItem = mutation();
  hooks.useInventoryEdits.mockReturnValue({ createItem, updateItem });
});

describe('the list', () => {
  it('shows each code with its description, unit of measure and price', () => {
    mount();
    const table = screen.getByRole('table', { name: 'Item codes' });
    const filter = within(table).getByRole('row', { name: /FLT-16251/ });
    for (const words of ['Filter 16x25x1', 'pcs', '$3.42', 'Filters', 'In use']) expect(filter.textContent).toContain(words);
    expect(within(table).getByRole('row', { name: /BAT-9V/ }).textContent).toContain('No price');
    expect(within(table).getByRole('row', { name: /OLD-0003/ }).textContent).toContain('Switched off');
  });

  it('narrows by code or description', () => {
    mount();
    fireEvent.change(screen.getByLabelText('Search item codes'), { target: { value: 'batt' } });
    expect(screen.getAllByRole('row')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Search item codes'), { target: { value: 'nothing like it' } });
    expect(screen.getByText('No item code matches the search.')).toBeTruthy();
  });

  it('has no form and no Edit for somebody who is not the stock keeper', () => {
    mount({ canManage: false });
    expect(screen.queryByRole('form', { name: 'New item code' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
    expect(screen.getByText('FLT-16251')).toBeTruthy();
  });
});

describe('a new item code', () => {
  it('suggests the category\'s next number, and lets the console give it when it is left as suggested', async () => {
    mount();
    const form = screen.getByRole('form', { name: 'New item code' });
    expect(add(form).disabled).toBe(true);
    expect(within(form).getByText('Choose a category.')).toBeTruthy();

    // A category that is switched off is not offered.
    fireEvent.keyDown(field(form, 'Category'), { key: 'ArrowDown' });
    expect(screen.queryByRole('option', { name: /Old parts/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Filters (FLT)' }));
    expect(field(form, 'Item code').value).toBe('FLT-0004');
    expect(within(form).getByText(/Suggested: FLT-0004, the next number/)).toBeTruthy();

    pick(form, 'Company', 'Example Home Services LLC');
    fireEvent.change(field(form, 'Description'), { target: { value: ' Filter 20x20x1 ' } });
    fireEvent.click(add(form));

    // No code is sent: the console numbers it, so two people adding at once never share one.
    await waitFor(() => expect(createItem.mutateAsync).toHaveBeenCalledWith({ name: 'Filter 20x20x1', unit: 'pcs', categoryId: 'cat-filters', priceCents: null, xeroTenantId: 'tenant-homes' }));
    expect(await within(form).findByText('FLT-20201 is added.')).toBeTruthy();
    // Ready for the next one, in the same category and company.
    expect(field(form, 'Description').value).toBe('');
  });

  it('takes a code typed over the suggestion, in capitals, with the unit and the price', async () => {
    mount();
    const form = screen.getByRole('form', { name: 'New item code' });
    pick(form, 'Category', 'Filters (FLT)');
    pick(form, 'Company', 'Example Pest Co');
    fireEvent.change(field(form, 'Item code'), { target: { value: 'flt-16251' } });
    expect(field(form, 'Item code').value).toBe('FLT-16251');
    fireEvent.change(field(form, 'Description'), { target: { value: 'Filter 16x25x1' } });
    fireEvent.change(field(form, 'Unit of measure'), { target: { value: 'box' } });
    fireEvent.change(field(form, /^Price/), { target: { value: '3.42' } });
    fireEvent.click(add(form));

    await waitFor(() => expect(createItem.mutateAsync).toHaveBeenCalledWith({ code: 'FLT-16251', name: 'Filter 16x25x1', unit: 'box', categoryId: 'cat-filters', priceCents: 342, xeroTenantId: 'tenant-pest' }));
  });

  it('says what is missing or wrong before it can be added', () => {
    mount();
    const form = screen.getByRole('form', { name: 'New item code' });
    pick(form, 'Category', 'Filters (FLT)');
    expect(within(form).getByText('Choose the company it is bought for.')).toBeTruthy();
    pick(form, 'Company', 'Example Home Services LLC');
    expect(within(form).getByText('Give it a description.')).toBeTruthy();
    fireEvent.change(field(form, 'Description'), { target: { value: 'Filter' } });

    fireEvent.change(field(form, 'Item code'), { target: { value: 'FLT 16251!' } });
    expect(within(form).getByText(/An item code is 2 to 24 capitals, digits and dashes/)).toBeTruthy();
    fireEvent.change(field(form, 'Item code'), { target: { value: 'FLT-16251' } });
    fireEvent.change(field(form, /^Price/), { target: { value: 'cheap' } });
    expect(within(form).getByText('A price is an amount, like 3.42.')).toBeTruthy();
    fireEvent.change(field(form, 'Unit of measure'), { target: { value: ' ' } });
    fireEvent.change(field(form, /^Price/), { target: { value: '' } });
    expect(within(form).getByText(/Say what it is counted in/)).toBeTruthy();
    expect(add(form).disabled).toBe(true);
    expect(createItem.mutateAsync).not.toHaveBeenCalled();
  });

  it('shows the server\'s words when the code is taken, and keeps what was typed', async () => {
    createItem.mutateAsync.mockRejectedValueOnce(new Error('refused'));
    createItem.error = new Error('FLT-16251 is already Filter 16x25x1. Choose another code.');
    mount({ companies: [] });
    const form = screen.getByRole('form', { name: 'New item code' });
    // An office with no companies is not asked for one.
    expect(within(form).queryByLabelText('Company')).toBeNull();
    pick(form, 'Category', 'Filters (FLT)');
    fireEvent.change(field(form, 'Item code'), { target: { value: 'FLT-16251' } });
    fireEvent.change(field(form, 'Description'), { target: { value: 'Another filter' } });
    fireEvent.click(add(form));

    await waitFor(() => expect(createItem.mutateAsync).toHaveBeenCalled());
    expect(within(form).getByText('FLT-16251 is already Filter 16x25x1. Choose another code.')).toBeTruthy();
    expect(field(form, 'Description').value).toBe('Another filter');
  });
});

describe('an item code\'s type (2026-11-20)', () => {
  it('starts as an Item, offers the types in use, and sends the one chosen', async () => {
    mount({ lineTypes: LINE_TYPES });
    const form = screen.getByRole('form', { name: 'New item code' });
    expect(within(form).getByLabelText('Type').textContent).toContain('Item (ITEM)');
    fireEvent.keyDown(within(form).getByLabelText('Type'), { key: 'ArrowDown' });
    expect(screen.queryByRole('option', { name: /Old type/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Service (SERVICE), keeps no stock' }));
    pick(form, 'Category', 'Filters (FLT)');
    pick(form, 'Company', 'Example Home Services LLC');
    fireEvent.change(field(form, 'Description'), { target: { value: 'Duct cleaning' } });
    fireEvent.click(add(form));
    await waitFor(() => expect(createItem.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ name: 'Duct cleaning', lineTypeId: 'type-service' })));
  });

  it('is shown in the list, and sent on an edit only when it changed', async () => {
    mount({ lineTypes: LINE_TYPES });
    expect(within(screen.getByRole('table', { name: 'Item codes' })).getByRole('row', { name: /FLT-16251/ }).textContent).toContain('Item');
    fireEvent.click(screen.getByRole('button', { name: 'Edit FLT-16251' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit FLT-16251' });
    fireEvent.change(field(dialog, 'Description'), { target: { value: 'Filter 16x25x1, MERV 8' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateItem.mutateAsync).toHaveBeenCalled());
    expect(updateItem.mutateAsync.mock.calls[0]![0]).not.toHaveProperty('input.lineTypeId');
  });
});

describe('editing an item code', () => {
  it('changes the description, unit and price, and sends the code only when it was changed', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit BAT-9V' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit BAT-9V' });
    expect(field(dialog, 'Item code').value).toBe('BAT-9V');
    expect((within(dialog).getByLabelText('Category') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(field(dialog, 'Description'), { target: { value: 'Battery, 9 V alkaline' } });
    fireEvent.change(field(dialog, /^Price/), { target: { value: '1.85' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateItem.mutateAsync).toHaveBeenCalledWith({ itemId: 'item-battery', input: { name: 'Battery, 9 V alkaline', unit: 'pcs', priceCents: 185 } }));
  });

  it('sends a changed code, and clears the price when it is emptied', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit FLT-16251' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit FLT-16251' });
    fireEvent.change(field(dialog, 'Item code'), { target: { value: 'flt-1625' } });
    fireEvent.change(field(dialog, /^Price/), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateItem.mutateAsync).toHaveBeenCalledWith({ itemId: 'item-filter', input: { code: 'FLT-1625', name: 'Filter 16x25x1', unit: 'pcs', priceCents: null } }));
  });

  it('shows why the server kept the code, and stays open', async () => {
    updateItem.mutateAsync.mockRejectedValueOnce(new Error('refused'));
    updateItem.error = new Error('FLT-16251 has been requested, ordered or stocked, so its code stays.');
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit FLT-16251' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit FLT-16251' });
    fireEvent.change(field(dialog, 'Item code'), { target: { value: 'FLT-1625' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateItem.mutateAsync).toHaveBeenCalled());
    expect(within(dialog).getByText(/so its code stays/)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Edit FLT-16251' })).toBeTruthy();
  });
});
