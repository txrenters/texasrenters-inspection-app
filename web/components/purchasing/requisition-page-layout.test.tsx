import { DEFAULT_FILE_RULES, DEFAULT_PAGE_LAYOUT, stepsFromLimit, type RequisitionChoices, type RequisitionPageLayout } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequisitionForm } from './requisition-form';

/**
 * The requisition page as Purchasing Setup lays it out (2026-11-21, part 5c):
 * the fields shown and required, and the FactBoxes in the office's order,
 * each to the roles it names. Every item, vendor and figure invented.
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

const EXTRAS = { lineTypeId: 'type-item', held: [], onOrder: 0, lastOrdered: null, priceCents: null };
const choicesWith = (page: RequisitionPageLayout): RequisitionChoices => ({
  items: [
    { id: 'item-battery', code: 'BAT-9V', name: 'Battery, 9 V', unit: 'each', companyTenantId: 'tenant-thmp', onHand: 40, reorderLevel: 12, reorderQuantity: 24, averageCostCents: 185, categoryId: 'cat-parts', usualVendorId: 'vendor-hill', ...EXTRAS },
  ],
  places: [{ id: 'place-store', name: 'Office Storeroom', code: 'STORE' }],
  companies: [{ tenantId: 'tenant-thmp', name: 'THMP', purchaserCode: 'THMP' }],
  vendors: [{ id: 'vendor-hill', name: 'Hill Country Supply', number: 'V-00003' }],
  settings: { steps: stepsFromLimit(50000, 2), files: DEFAULT_FILE_RULES, page },
  lineTypes: [{ id: 'type-item', code: 'ITEM', name: 'Item', keepsStock: true }],
  requestCodes: [{ id: 'request-restock', code: 'RESTOCK', name: 'Restock the storeroom' }],
  costCenters: [],
  departments: [{ id: 'department-maint', code: 'MAINT', name: 'Maintenance' }],
  categories: [{ id: 'cat-parts', name: 'Parts' }],
  me: { id: 'user-1', name: 'Sample Requester', code: 'SREQUESTER' },
  canMakeItemCodes: false,
  vendorStats: { 'vendor-hill': { openOrders: 2, openCents: 123400, orderedThisYearCents: 456700, lastOrder: { number: 'PO-00031', on: '2026-11-18' } } },
});
const layout = (change: { fields?: Partial<RequisitionPageLayout['fields']>; factBoxes?: RequisitionPageLayout['factBoxes'] }): RequisitionPageLayout => ({
  fields: { ...DEFAULT_PAGE_LAYOUT.fields, ...change.fields },
  factBoxes: change.factBoxes ?? DEFAULT_PAGE_LAYOUT.factBoxes,
});

const mount = (page: RequisitionPageLayout, permissions: string[] = []) =>
  render(<RequisitionForm choices={choicesWith(page)} error={null} onDiscard={vi.fn()} onSave={vi.fn(async () => undefined)} pending={false} permissions={permissions} />);
const pick = (line: number, typed: string) => {
  const input = screen.getByLabelText(`Item on line ${line}`);
  fireEvent.change(input, { target: { value: typed } });
  fireEvent.keyDown(input, { key: 'Enter' });
};
const factBoxes = () => within(document.querySelector('aside')!).getAllByRole('region').map((box) => box.getAttribute('aria-label'));

beforeEach(() => {
  hooks.useRequisitionFiles.mockReturnValue({ attach: mutation(), setForVendor: mutation(), remove: mutation() });
  hooks.useRequisitionNotes.mockReturnValue(Object.fromEntries(['addNote', 'removeNote', 'comment', 'addLink', 'removeLink'].map((name) => [name, mutation()])));
  hooks.useRequisitionSiblings.mockReturnValue(vi.fn(async () => null));
  hooks.useRequisitions.mockReturnValue({ isLoading: false, data: { requisitions: [], seesAll: true } });
});

describe('the fields', () => {
  it('leaves out the fields the office hides, on the General tab and on the lines', () => {
    mount(layout({ fields: { REQUEST_CODE: { shown: false, required: false }, LINE_NOTES: { shown: false, required: false } } }));
    pick(1, 'BAT-9V');
    expect(screen.queryByText('Request Code:')).toBeNull();
    expect(screen.getByText('Cost Center Code:')).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Notes' })).toBeNull();
    expect(screen.queryByLabelText('Notes on Battery, 9 V')).toBeNull();
    expect(screen.getByLabelText('Department of Battery, 9 V')).toBeTruthy();
  });

  it('marks the required fields, and says the first one empty until it is filled', () => {
    mount(layout({ fields: { EXPECTED_RECEIPT: { shown: true, required: true }, LINE_DEPARTMENT: { shown: true, required: true } } }));
    pick(1, 'BAT-9V');
    // The General field and the lines column each carry the mark, and the Purchaser Code always (2026-11-24).
    expect(screen.getAllByText('(required)')).toHaveLength(3);
    expect(screen.getByRole('columnheader', { name: /Department Code/ }).textContent).toContain('*');
    expect(screen.getByRole('status').textContent).toBe('Give the expected receipt date.');
    // Greyed, and pressed it says why (2026-11-21).
    expect(screen.getByRole('button', { name: 'Send Approval Request' }).getAttribute('aria-disabled')).toBe('true');

    fireEvent.change(screen.getByLabelText('Expected Receipt Date'), { target: { value: '2026-12-01' } });
    expect(screen.getByRole('status').textContent).toBe('Choose a department code on every line.');
  });

  it('asks for nothing more than before while the office has required nothing', () => {
    mount(DEFAULT_PAGE_LAYOUT);
    pick(1, 'BAT-9V');
    // Only the Purchaser Code, always (2026-11-24): an order of no company reaches no books.
    expect(screen.queryAllByText('(required)')).toHaveLength(1);
  });
});

describe('the FactBoxes', () => {
  const ordered = layout({
    factBoxes: [
      { key: 'VENDOR_STATISTICS', shown: true, audience: ['PURCHASER', 'APPROVER'] },
      { key: 'LINE_DETAILS', shown: true, audience: [] },
      { key: 'STATISTICS', shown: true, audience: [] },
      { key: 'ATTACHMENTS', shown: true, audience: [] },
      { key: 'ITEM_AVAILABILITY', shown: false, audience: [] },
    ],
  });

  it('come in the office order, each only to the roles it names', () => {
    mount(ordered, ['purchasing:request', 'purchasing:order']);
    expect(factBoxes()).toEqual(['Vendor Statistics', 'Line Details', 'Requisition Statistics', 'Attachments']);
    expect(screen.getByText('Vendor Statistics and Line Details follow the line the cursor is on, and the item the dropdown is on.')).toBeTruthy();
  });

  it('leave Vendor Statistics out for somebody who is neither purchaser nor approver', () => {
    mount(ordered, ['purchasing:request']);
    expect(factBoxes()).toEqual(['Line Details', 'Requisition Statistics', 'Attachments']);
  });

  it('as the board starts them: Vendor Statistics off for everybody', () => {
    mount(DEFAULT_PAGE_LAYOUT, ['purchasing:order', 'purchasing:approve']);
    expect(factBoxes()).toEqual(['Requisition Statistics', 'Attachments', 'Line Details', 'Item Availability']);
  });

  it('say why it cannot be sent even with Requisition Statistics hidden', () => {
    mount(layout({ fields: { EXPECTED_RECEIPT: { shown: true, required: true } }, factBoxes: [{ key: 'ATTACHMENTS', shown: true, audience: [] }, { key: 'STATISTICS', shown: false, audience: [] }] }));
    pick(1, 'BAT-9V');
    expect(factBoxes()).toEqual(['Attachments']);
    expect(screen.getByRole('status').textContent).toBe('Give the expected receipt date.');
  });

  it('Vendor Statistics follows the line: its vendor, else its item usual vendor', () => {
    mount(ordered, ['purchasing:order']);
    pick(1, 'BAT-9V');
    fireEvent.focus(screen.getByLabelText('Quantity of Battery, 9 V'));
    const box = within(screen.getByRole('region', { name: 'Vendor Statistics' }));
    expect(box.getByText('V-00003')).toBeTruthy();
    expect(box.getByText('Hill Country Supply')).toBeTruthy();
    expect(box.getByText('$1,234.00')).toBeTruthy();
    expect(box.getByText('$4,567.00')).toBeTruthy();
    expect(box.getByText(/^PO-00031 · /)).toBeTruthy();
  });
});
