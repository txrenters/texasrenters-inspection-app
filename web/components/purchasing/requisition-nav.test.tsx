import { DEFAULT_FILE_RULES, DEFAULT_PAGE_LAYOUT, stepsFromLimit, type RequisitionChoices, type RequisitionDetail } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequisitionForm } from './requisition-form';

/**
 * The requisition finished to the canvas (2026-11-20): the Lines as a
 * spreadsheet, Find, Select From Item Categories, Copy Document, and Show
 * Attached. Every item, person and price invented.
 */

const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(async () => ({})), isPending: false, error: null });
const hooks = vi.hoisted(() => ({
  useRequisitionFiles: vi.fn(),
  openRequisitionFile: vi.fn(),
  useRequisitionNotes: vi.fn(),
  useRequisitionSiblings: vi.fn(),
  useRequisitions: vi.fn(),
  readRequisition: vi.fn(),
}));
vi.mock('@/lib/purchasing-queries', () => hooks);
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

const SETTINGS = { steps: stepsFromLimit(50000, 2), files: DEFAULT_FILE_RULES, page: DEFAULT_PAGE_LAYOUT };
const EXTRAS = { lineTypeId: 'type-item', usualVendorId: null, held: [], onOrder: 0, lastOrdered: null, priceCents: null };
const CHOICES: RequisitionChoices = {
  items: [
    { id: 'item-filter', code: 'FLT-20251', name: 'Filter 20x25x1', unit: 'each', companyTenantId: 'tenant-thmp', onHand: 0, reorderLevel: 18, reorderQuantity: 36, averageCostCents: 390, categoryId: 'cat-filters', ...EXTRAS },
    { id: 'item-filter-2', code: 'FLT-20201', name: 'Filter 20x20x1', unit: 'each', companyTenantId: 'tenant-thmp', onHand: 11, reorderLevel: 24, reorderQuantity: 48, averageCostCents: 360, categoryId: 'cat-filters', ...EXTRAS },
    { id: 'item-battery', code: 'BAT-9V', name: 'Battery, 9 V', unit: 'each', companyTenantId: 'tenant-thmp', onHand: 40, reorderLevel: 12, reorderQuantity: 24, averageCostCents: 185, categoryId: 'cat-parts', ...EXTRAS },
  ],
  places: [{ id: 'place-store', name: 'Office Storeroom', code: 'STORE' }],
  companies: [{ tenantId: 'tenant-thmp', name: 'THMP', purchaserCode: 'THMP' }],
  vendors: [{ id: 'vendor-hill', name: 'Hill Country Supply', number: 'V-00003' }],
  settings: SETTINGS,
  lineTypes: [{ id: 'type-item', code: 'ITEM', name: 'Item', keepsStock: true }],
  requestCodes: [],
  costCenters: [],
  departments: [],
  categories: [
    { id: 'cat-filters', name: 'Filters' },
    { id: 'cat-parts', name: 'Parts' },
  ],
  me: { id: 'user-1', name: 'Sample Requester', code: 'SREQUESTER' },
  canMakeItemCodes: false,
};

const mount = () => {
  const onSave = vi.fn(async () => undefined);
  render(<RequisitionForm choices={CHOICES} error={null} onDiscard={vi.fn()} onSave={onSave} pending={false} />);
  return onSave;
};
const pick = (line: number, typed: string) => {
  const input = screen.getByLabelText(`Item on line ${line}`);
  fireEvent.change(input, { target: { value: typed } });
  fireEvent.keyDown(input, { key: 'Enter' });
};

beforeEach(() => {
  hooks.useRequisitionFiles.mockReturnValue({ attach: mutation(), setForVendor: mutation(), remove: mutation() });
  hooks.useRequisitionNotes.mockReturnValue(Object.fromEntries(['addNote', 'removeNote', 'comment', 'addLink', 'removeLink'].map((name) => [name, mutation()])));
  hooks.useRequisitionSiblings.mockReturnValue(vi.fn(async () => null));
  hooks.useRequisitions.mockReturnValue({ isLoading: false, data: { requisitions: [], settings: SETTINGS, seesAll: true } });
});

describe('the Lines, as a spreadsheet', () => {
  it('starts with one blank line, opens the next as the last is filled, and moves down a column with ↓', () => {
    mount();
    expect(screen.getAllByLabelText(/^Item on line/)).toHaveLength(1);

    pick(1, 'FLT-20251');
    pick(2, 'BAT-9V');
    // Each line filled opens the next, ready to type in.
    expect(screen.getAllByLabelText(/^Item on line/)).toHaveLength(3);

    const first = screen.getByLabelText('Quantity of Filter 20x25x1');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByLabelText('Quantity of Battery, 9 V'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
  });

  it('finds lines by what they say, counting only the lines filled in', () => {
    mount();
    pick(1, 'FLT-20251');
    pick(2, 'BAT-9V');

    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.change(screen.getByLabelText('Find in the lines'), { target: { value: 'battery' } });
    expect(screen.getByText(/Showing 1 of 2 lines/)).toBeTruthy();
    expect(screen.queryByLabelText('Quantity of Filter 20x25x1')).toBeNull();
    // The blank next row stays, to type in.
    expect(screen.getByLabelText('Item on line 3')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show them all' }));
    expect(screen.getByLabelText('Quantity of Filter 20x25x1')).toBeTruthy();
  });
});

describe('Select From Item Categories', () => {
  it('adds the ticked category items at their reorder quantities, after the lines already there', async () => {
    const onSave = mount();
    pick(1, 'BAT-9V');

    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Requisition actions' })).getByRole('button', { name: 'Select From Item Categories' }));
    const dialog = screen.getByRole('dialog', { name: 'Select From Item Categories' });
    // The battery is on a line already, so Parts has nothing more to offer.
    expect(within(dialog).queryByText(/Parts/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Filters/ }));
    fireEvent.change(within(dialog).getByLabelText('How many FLT-20201'), { target: { value: '12' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 2 lines' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          lines: [expect.objectContaining({ itemId: 'item-battery' }), expect.objectContaining({ itemId: 'item-filter', quantity: 36 }), expect.objectContaining({ itemId: 'item-filter-2', quantity: 12 })],
        }),
        false,
      ),
    );
  });
});

describe('Copy Document', () => {
  const other = {
    id: 'req-7',
    number: 'PR-00007',
    company: { tenantId: 'tenant-thmp', name: 'THMP' },
    deliverTo: null,
    requestCode: null,
    costCenter: null,
    neededBy: null,
    lines: [
      { id: 'l1', item: { id: 'item-filter-2', code: 'FLT-20201', name: 'Filter 20x20x1', unit: 'each' }, description: null, quantity: 24, estimatedUnitCostCents: 360, lineType: null, place: null, expectedOn: null, vendor: null, department: null, notes: 'Pleated', onHand: 11, reorderLevel: 24 },
      { id: 'l2', item: { id: 'item-elsewhere', code: 'PST-1', name: 'Glue boards', unit: 'pack' }, description: null, quantity: 4, estimatedUnitCostCents: 910, lineType: null, place: null, expectedOn: null, vendor: null, department: null, notes: null, onHand: 0, reorderLevel: 0 },
    ],
  } as unknown as RequisitionDetail;

  it('copies another requisition lines that this company buys, saying what was left out', async () => {
    // A closed one: the open list has none.
    hooks.useRequisitions.mockImplementation((show: string) => ({
      isLoading: false,
      data: { requisitions: show === 'closed' ? [{ id: 'req-7', number: 'PR-00007', status: 'CLOSED', summary: 'Filter 20x20x1 × 24', estimatedTotalCents: 8640, requestedBy: { name: 'Another' } }] : [], settings: SETTINGS, seesAll: true },
    }));
    hooks.readRequisition.mockResolvedValue(other);
    const onSave = mount();

    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Requisition actions' })).getByRole('button', { name: 'Copy Document...' }));
    const dialog = screen.getByRole('dialog', { name: 'Copy Document' });
    fireEvent.click(within(dialog).getByRole('option', { name: /PR-00007/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(screen.getByText(/Copied 1 line from PR-00007; 1 for another company left out\./)).toBeTruthy());
    expect(hooks.readRequisition).toHaveBeenCalledWith('req-7');
    expect((screen.getByLabelText('Notes on Filter 20x20x1') as HTMLInputElement).value).toBe('Pleated');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ lines: [expect.objectContaining({ itemId: 'item-filter-2', quantity: 24 })] }), false));
  });
});

describe('Show Attached', () => {
  it('says to save first on a requisition not yet saved, and keeps only http(s) links', () => {
    mount();
    const ribbon = within(screen.getByRole('toolbar', { name: 'Requisition actions' }));
    fireEvent.click(ribbon.getByRole('button', { name: 'Notes' }));
    fireEvent.click(ribbon.getByRole('button', { name: 'Links' }));
    expect(ribbon.getByRole('button', { name: 'Notes' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(screen.getByRole('region', { name: 'Notes' })).getByText('Save the requisition first.')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Links' })).getByText('Save the requisition first.')).toBeTruthy();
  });
});
