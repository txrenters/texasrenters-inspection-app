import { DEFAULT_FILE_RULES, DEFAULT_PAGE_LAYOUT, stepsFromLimit, type PurchaseOrderDetail, type PurchaseOrderRow, type RequisitionChoices, type RequisitionDetail, type RequisitionList, type RequisitionRow } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequisitionForm } from '@/components/purchasing/requisition-form';
import { businessToday } from '@/lib/clock';

import PurchaseOrderPage from './orders/[orderId]/page';
import PurchasingPage from './page';
import NewRequisitionPage from './requisitions/new/page';
import RequisitionPage from './requisitions/[requisitionId]/page';

/** Purchase requisitions, phase 2 (2026-11-19). Every item, person, vendor and price invented. */

const mutation = () => ({ mutateAsync: vi.fn(async () => ({})), isPending: false, error: null, reset: vi.fn(), data: undefined });
const hooks = vi.hoisted(() => ({
  useRequisitions: vi.fn(),
  useRequisition: vi.fn(),
  useRequisitionChoices: vi.fn(),
  usePurchasingEdits: vi.fn(),
  usePurchaseOrders: vi.fn(),
  usePurchaseOrder: vi.fn(),
  usePurchaseOrderEdits: vi.fn(),
  usePurchaseReceivingEdits: vi.fn(),
  // The Attachments FactBox has its own tests (attachments-factbox.test.tsx): here it only draws.
  useRequisitionFiles: vi.fn(),
  openRequisitionFile: vi.fn(),
  // The ribbon's Show Attached, Previous and Next, and Copy Document (2026-11-20).
  useRequisitionNotes: vi.fn(),
  useRequisitionSiblings: vi.fn(),
  readRequisition: vi.fn(),
  // The Setup tab has its own tests (setup-tab.test.tsx): here it only reads.
  usePurchasingSetup: vi.fn(() => ({ isLoading: true })),
  usePurchasingSetupEdits: vi.fn(),
}));
vi.mock('@/lib/purchasing-queries', () => hooks);
// The bill's Xero card and the bills panel have their own tests (bill-in-xero.test.tsx): here they read nothing.
vi.mock('@/lib/vendor-bills-xero-queries', () => ({
  useBillInXero: () => ({ isError: false, data: undefined }),
  useBillInXeroActions: () => ({ send: { mutate: vi.fn(), isPending: false, error: null }, sendPayment: { mutate: vi.fn(), isPending: false, error: null } }),
  useXeroBillSettings: () => ({ isError: false, data: undefined }),
  useSaveXeroBillSettings: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false, error: null }),
}));
const url = vi.hoisted(() => ({ state: { tab: 'requisitions', show: 'open', status: 'all', q: '' }, set: vi.fn() }));
vi.mock('@/lib/url-state', () => ({ useUrlState: () => [url.state, url.set, vi.fn()] }));
const account = vi.hoisted(() => ({ permissions: new Set<string>() }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ permissions: [...account.permissions], has: (permission: string) => account.permissions.has(permission), hasAny: (...permissions: string[]) => permissions.some((permission) => account.permissions.has(permission)) }), useAuth: () => ({ profile: { displayName: 'Sample Purchaser' } }) }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), query: '' }));
vi.mock('next/navigation', () => ({ useParams: () => ({ requisitionId: 'req-12', orderId: 'order-9' }), useRouter: () => router, useSearchParams: () => new URLSearchParams(router.query) }));
const pdf = vi.hoisted(() => ({ downloadOrder: vi.fn(async () => undefined), orderAttachment: vi.fn(async () => ({ fileName: 'PO-0009 Hill Country Supply.pdf', contentBase64: 'JVBERi0=' })) }));
vi.mock('@/lib/purchase-order-pdf/download-order', () => pdf);
const printed = vi.hoisted(() => ({ downloadRequisition: vi.fn(async () => undefined) }));
vi.mock('@/lib/requisition-pdf/download-requisition', () => printed);

// The office before Purchasing Setup (2026-11-20): $500.00, and two quotes above it, as two steps.
const SETTINGS = { steps: stepsFromLimit(50000, 2), files: DEFAULT_FILE_RULES, page: DEFAULT_PAGE_LAYOUT };
const row = (over: Partial<RequisitionRow> = {}): RequisitionRow => ({
  id: 'req-12',
  number: 'PR-0012',
  status: 'SUBMITTED',
  requestedBy: { id: 'user-vance', name: 'Sample Requester', code: 'SREQUESTER' },
  submittedAt: '2026-11-17T15:12:00.000Z',
  createdAt: '2026-11-17T14:58:00.000Z',
  company: { tenantId: 'tenant-thmp', name: 'THMP' },
  neededBy: '2026-11-24',
  summary: 'Filter 20x25x1 × 36, Battery, 9 V × 24',
  lineCount: 2,
  quoteCount: 0,
  estimatedTotalCents: 18480,
  decisionNote: null,
  ...over,
});
const NO_LINE_CODES = { lineType: null, place: null, expectedOn: null, vendor: null, department: null, notes: null };
const detail = (over: Partial<RequisitionDetail> = {}): RequisitionDetail => ({
  ...row(),
  reason: 'Filters are out and next week has 14 inspections booked.',
  deliverTo: { id: 'place-stockroom', name: 'Stockroom' },
  lines: [
    { id: 'line-1', item: { id: 'item-filter', code: 'FLT-20251', name: 'Filter 20x25x1', unit: 'each' }, description: 'Filter 20x25x1', quantity: 36, estimatedUnitCostCents: 390, onHand: 0, reorderLevel: 18, ...NO_LINE_CODES },
    { id: 'line-2', item: { id: 'item-battery', code: 'BAT-9V', name: 'Battery, 9 V', unit: 'each' }, description: 'Battery, 9 V', quantity: 24, estimatedUnitCostCents: 185, onHand: 5, reorderLevel: 12, ...NO_LINE_CODES },
  ],
  requestCode: null,
  costCenter: null,
  requisitionDate: '2026-11-17',
  documentDate: '2026-11-17',
  quotes: [],
  decidedBy: null,
  decidedAt: null,
  orders: [],
  from: { name: 'THMP', addressLine1: '1 Example Plaza', addressLine2: null, phone: null, email: null },
  files: [],
  notes: [],
  comments: [],
  links: [],
  history: [
    { at: '2026-11-17T15:12:00.000Z', by: 'Sample Requester', what: 'submitted it' },
    { at: '2026-11-17T14:58:00.000Z', by: 'Sample Requester', what: 'started it' },
  ],
  can: { edit: false, submit: false, cancel: false, approve: true, sendBack: true, reject: true, order: false, approveBlocked: null, attach: true, recall: false, reopen: false },
  settings: SETTINGS,
  ...over,
});
const ITEM_EXTRAS = { lineTypeId: 'type-item', categoryId: 'cat-filters', usualVendorId: null, held: [], onOrder: 0, lastOrdered: null };
const CHOICES: RequisitionChoices = {
  items: [
    { id: 'item-filter', code: 'FLT-20251', name: 'Filter 20x25x1', unit: 'each', companyTenantId: 'tenant-thmp', onHand: 0, reorderLevel: 18, reorderQuantity: 36, averageCostCents: 390, priceCents: null, ...ITEM_EXTRAS, usualVendorId: 'vendor-hill', onOrder: 24, lastOrdered: 'PO-0007' },
    { id: 'item-battery', code: 'BAT-9V', name: 'Battery, 9 V', unit: 'each', companyTenantId: 'tenant-thmp', onHand: 5, reorderLevel: 12, reorderQuantity: 24, averageCostCents: 185, priceCents: null, ...ITEM_EXTRAS, held: [{ placeId: 'place-stockroom', quantity: 5 }] },
    { id: 'item-alarm', code: 'SMK-10', name: 'Smoke alarm', unit: 'each', companyTenantId: 'tenant-thmp', onHand: 40, reorderLevel: 6, reorderQuantity: 12, averageCostCents: 1530, priceCents: null, ...ITEM_EXTRAS, categoryId: 'cat-parts' },
    { id: 'item-glue', code: 'PST-GLUE', name: 'Glue boards', unit: 'pack', companyTenantId: 'tenant-pest', onHand: 0, reorderLevel: 8, reorderQuantity: 12, averageCostCents: 910, priceCents: null, ...ITEM_EXTRAS },
  ],
  places: [{ id: 'place-stockroom', name: 'Stockroom', code: 'STORE' }],
  companies: [{ tenantId: 'tenant-thmp', name: 'THMP', purchaserCode: 'THMP' }, { tenantId: 'tenant-pest', name: 'Crystal Creek Pest', purchaserCode: 'CCP' }],
  vendors: [{ id: 'vendor-hill', name: 'Hill Country Supply', number: 'V-00003' }],
  settings: SETTINGS,
  lineTypes: [{ id: 'type-item', code: 'ITEM', name: 'Item', keepsStock: true }],
  requestCodes: [{ id: 'code-restock', code: 'RESTOCK', name: 'Restock the storeroom' }],
  costCenters: [{ id: 'code-maint', code: 'MAINT', name: 'Maintenance' }],
  departments: [{ id: 'code-hvac', code: 'HVAC', name: 'HVAC' }],
  categories: [{ id: 'cat-filters', name: 'Filters' }, { id: 'cat-parts', name: 'Parts' }],
  me: { id: 'user-vance', name: 'Sample Requester', code: 'SREQUESTER' },
  canMakeItemCodes: false,
};

let edits: Record<string, ReturnType<typeof mutation>>;
let orderEdits: Record<string, ReturnType<typeof mutation>>;
const list = (requisitions: RequisitionRow[], seesAll = true): RequisitionList => ({ requisitions, settings: SETTINGS, seesAll });

beforeEach(() => {
  url.state = { tab: 'requisitions', show: 'open', status: 'all', q: '' };
  router.push.mockReset();
  router.replace.mockReset();
  router.query = '';
  pdf.orderAttachment.mockClear();
  pdf.downloadOrder.mockClear();
  orderEdits = { create: mutation(), update: mutation(), step: mutation(), send: mutation() };
  hooks.usePurchaseOrderEdits.mockReturnValue(orderEdits);
  hooks.usePurchaseReceivingEdits.mockReturnValue(Object.fromEntries(['receive', 'reverseReceipt', 'closeShort', 'saveBill', 'approveBill', 'approveBillAnyway', 'payBill'].map((name) => [name, mutation()])));
  account.permissions = new Set(['purchasing:request']);
  edits = { create: mutation(), update: mutation(), step: mutation() };
  hooks.usePurchasingEdits.mockReturnValue(edits);
  hooks.useRequisitionFiles.mockReturnValue({ attach: mutation(), setForVendor: { ...mutation(), mutate: vi.fn() }, remove: { ...mutation(), mutate: vi.fn() } });
  hooks.useRequisitionNotes.mockReturnValue(Object.fromEntries(['addNote', 'removeNote', 'comment', 'addLink', 'removeLink'].map((name) => [name, { ...mutation(), mutate: vi.fn() }])));
  hooks.useRequisitionSiblings.mockReturnValue(vi.fn(async () => null));
  hooks.useRequisitionChoices.mockReturnValue({ isLoading: false, isError: false, data: CHOICES });
});

describe('the requisitions list', () => {
  const mount = (data: RequisitionList) => {
    hooks.useRequisitions.mockReturnValue({ isLoading: false, isError: false, data });
    return render(<PurchasingPage />);
  };

  it('shows each requisition with who it waits on, and opens it', () => {
    mount(
      list([
        row(),
        row({ id: 'req-11', number: 'PR-0011', status: 'APPROVED', summary: 'Smoke alarm × 40', lineCount: 1, quoteCount: 2, estimatedTotalCents: 61200 }),
        row({ id: 'req-10', number: 'PR-0010', status: 'SENT_BACK', summary: 'Sprayer × 1', lineCount: 1, decisionNote: 'Which model? Add a quote.' }),
        row({ id: 'req-13', number: 'PR-0013', summary: 'Smoke alarm × 60', lineCount: 1, quoteCount: 2, estimatedTotalCents: 91800 }),
      ]),
    );

    const table = screen.getByRole('table', { name: 'Purchase requisitions' });
    expect(within(table).getByRole('link', { name: /Filter 20x25x1 × 36/ }).getAttribute('href')).toBe('/purchasing/requisitions/req-12');
    expect(within(table).getByRole('row', { name: /PR-0012/ }).textContent).toContain('An approver');
    expect(within(table).getByRole('row', { name: /PR-0013/ }).textContent).toContain('Somebody who may approve any amount');
    expect(within(table).getByRole('row', { name: /PR-0011/ }).textContent).toContain('A purchaser, to make the order');
    expect(hooks.usePurchaseOrders).not.toHaveBeenCalled();
    expect(within(table).getByRole('row', { name: /PR-0010/ }).textContent).toContain('Sent back: “Which model? Add a quote.”');
    expect(screen.getByText('Waiting for approval', { selector: ':not(span)' }).parentElement?.textContent).toContain('2');
    expect(hooks.useRequisitions).toHaveBeenCalledWith('open');
  });

  it('narrows by a search from the rows in hand, and says whose requisitions these are', () => {
    url.state = { tab: 'requisitions', show: 'open', status: 'all', q: 'pr-0011' };
    mount(list([row(), row({ id: 'req-11', number: 'PR-0011', summary: 'Smoke alarm × 40' })], false));

    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText('Your purchase requisitions, and the orders made from them.')).toBeTruthy();
  });

  // Purchasing Setup (2026-11-20) replaces the approval limits dialog: a tab for a system admin or Purchasing admin only.
  it('offers Setup only to a Purchasing admin, even one who may approve any amount', () => {
    account.permissions = new Set(['purchasing:request', 'purchasing:approve', 'purchasing:approve-any']);
    const first = mount(list([row()]));
    expect(screen.queryByRole('tab', { name: 'Setup' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approval limits' })).toBeNull();
    expect(screen.getByRole('link', { name: 'New requisition' }).getAttribute('href')).toBe('/purchasing/requisitions/new');
    first.unmount();

    account.permissions = new Set(['purchasing:request', 'purchasing:setup']);
    url.state = { ...url.state, tab: 'setup' };
    mount(list([row()]));
    expect(screen.getByRole('tab', { name: 'Setup', selected: true })).toBeTruthy();
  });
});

// New makes the draft at once, as NAV does, so its PR number shows from the start (2026-11-21).
describe('a new requisition', () => {
  it('is made blank, numbered, and opened, with nothing chosen for the person', async () => {
    edits.create!.mutateAsync.mockResolvedValue({ id: 'req-new' });
    render(<NewRequisitionPage />);

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/purchasing/requisitions/req-new'));
    expect(edits.create!.mutateAsync).toHaveBeenCalledTimes(1);
    expect(edits.create!.mutateAsync).toHaveBeenCalledWith({ xeroTenantId: null, neededBy: null, deliverToPlaceId: null, requestCodeId: null, costCenterId: null, documentDate: null, reason: '', lines: [], quotes: [] });
  });

  it('from the Reorder list, starts with the ticked items at the quantities asked, for their company, at what one cost', async () => {
    router.query = 'items=item-glue:12,item-nothing:5,item-filter:9,item-glue:x';
    edits.create!.mutateAsync.mockResolvedValue({ id: 'req-new' });
    render(<NewRequisitionPage />);

    // The first item on it is the pest company's, so the request is that company's: the filter is another's and is left off.
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/purchasing/requisitions/req-new'));
    expect(edits.create!.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ xeroTenantId: 'tenant-pest', deliverToPlaceId: null, documentDate: null, lines: [{ itemId: 'item-glue', quantity: 12, estimatedUnitCostCents: 910, vendorId: null }] }),
    );
  });

  it('says why it could not be made, and tries again', async () => {
    edits.create!.mutateAsync.mockRejectedValueOnce(new Error('Somebody is offline.')).mockResolvedValue({ id: 'req-new' });
    const { rerender } = render(<NewRequisitionPage />);
    await waitFor(() => expect(edits.create!.mutateAsync).toHaveBeenCalledTimes(1));
    hooks.usePurchasingEdits.mockReturnValue({ ...edits, create: { ...edits.create!, error: new Error('Somebody is offline.') } });
    rerender(<NewRequisitionPage />);
    expect(screen.getByText('Somebody is offline.')).toBeTruthy();
    hooks.usePurchasingEdits.mockReturnValue(edits);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/purchasing/requisitions/req-new'));
    expect(edits.create!.mutateAsync).toHaveBeenCalledTimes(2);
  });
});

const choose = (label: string, option: string) => {
  fireEvent.keyDown(screen.getByLabelText(label), { key: 'ArrowDown' });
  fireEvent.click(screen.getByRole('option', { name: option }));
};

/** Greyed: a button not open now, pressed only to say why (2026-11-21), or one with no reason that cannot be pressed at all. */
const greyed = (button: HTMLElement) => (button as HTMLButtonElement).disabled || button.getAttribute('aria-disabled') === 'true';

describe("a line's cost", () => {
  it('starts from the usual price the stock keeper gave the item, and from the average cost when it has none', () => {
    const priced: RequisitionChoices = { ...CHOICES, items: CHOICES.items.map((item) => (item.id === 'item-filter' ? { ...item, priceCents: 425 } : item)) };
    render(<RequisitionForm choices={priced} discardLabel="Discard" error={null} onDiscard={vi.fn()} onSave={vi.fn(async () => undefined)} pending={false} />);
    choose('Purchaser Code', 'THMP · THMP');
    fireEvent.click(screen.getByRole('button', { name: 'Add Everything That Is Low' }));
    const table = screen.getByRole('table', { name: 'Lines' });
    // The filter has a price of $4.25 and cost $3.90 on average: the price is what the line starts from.
    expect((within(table).getByLabelText('Direct unit cost of Filter 20x25x1') as HTMLInputElement).value).toBe('4.25');
    // The battery has no price: what one cost on average.
    expect((within(table).getByLabelText('Direct unit cost of Battery, 9 V') as HTMLInputElement).value).toBe('1.85');
  });
});

describe('filling a requisition in', () => {
  const mount = (requisition?: RequisitionDetail) => {
    const onSave = vi.fn(async () => undefined);
    render(<RequisitionForm choices={CHOICES} discardLabel="Discard" error={null} onDiscard={vi.fn()} onSave={onSave} pending={false} requisition={requisition} />);
    return onSave;
  };
  const submit = () => screen.getByRole('button', { name: 'Send Approval Request' }) as HTMLButtonElement;

  it('starts with every field and its one line blank (2026-11-21) but the Document Date, the day it was made', () => {
    mount();
    // Nothing chosen reads as blank; each list still offers its "none" to clear a choice.
    for (const field of ['Purchaser Code', 'Request Code', 'Location Code', 'Cost Center Code']) expect(screen.getByLabelText(field).textContent).toBe('');
    expect((screen.getByLabelText('Document Date:') as HTMLInputElement).value).toBe(businessToday());
    // The approval step is not shown (2026-11-21); who approves still is.
    expect(screen.queryByText('Approval Step:')).toBeNull();
    expect(screen.queryByText('Approval Step')).toBeNull();
    expect(screen.getAllByLabelText(/^Item on line/)).toHaveLength(1);
    expect(screen.getByLabelText('Type of line 1').textContent).toBe('');
    expect((screen.getByLabelText('Item on line 1') as HTMLInputElement).placeholder).toBe('');
    // Nothing to add from Everything That Is Low until the requisition is for a company.
    expect(greyed(screen.getByRole('button', { name: 'Add Everything That Is Low' }))).toBe(true);
  });

  it("carries General's Location Code and Expected Receipt Date to each line that goes with it, never over a line's own (2026-11-21)", () => {
    const choices: RequisitionChoices = { ...CHOICES, places: [...CHOICES.places, { id: 'place-truck', name: 'Truck 2', code: 'TRK2' }] };
    render(<RequisitionForm choices={choices} discardLabel="Discard" error={null} onDiscard={vi.fn()} onSave={vi.fn(async () => undefined)} pending={false} />);
    // The blank line goes with General from the start.
    choose('Location Code', 'STORE · Stockroom');
    expect(screen.getByLabelText('Location of line 1').textContent).toBe('STORE');
    choose('Purchaser Code', 'THMP · THMP');
    fireEvent.click(screen.getByRole('button', { name: 'Add Everything That Is Low' }));
    const date = (name: string) => (screen.getByLabelText(`Expected receipt date of ${name}`) as HTMLInputElement).value;

    fireEvent.change(screen.getByLabelText('Expected Receipt Date'), { target: { value: '2026-12-01' } });
    expect([date('Filter 20x25x1'), date('Battery, 9 V')]).toEqual(['2026-12-01', '2026-12-01']);
    // The battery is given its own location and date.
    choose('Location of Battery, 9 V', 'TRK2');
    fireEvent.change(screen.getByLabelText('Expected receipt date of Battery, 9 V'), { target: { value: '2026-12-05' } });

    choose('Location Code', 'TRK2 · Truck 2');
    fireEvent.change(screen.getByLabelText('Expected Receipt Date'), { target: { value: '2026-12-03' } });
    expect(screen.getByLabelText('Location of Filter 20x25x1').textContent).toBe('TRK2');
    expect(date('Filter 20x25x1')).toBe('2026-12-03');
    expect(date('Battery, 9 V')).toBe('2026-12-05');
    choose('Location Code', 'STORE · Stockroom');
    expect(screen.getByLabelText('Location of Filter 20x25x1').textContent).toBe('STORE');
    // The battery went to the truck on its own, and stays.
    expect(screen.getByLabelText('Location of Battery, 9 V').textContent).toBe('TRK2');
  });

  it("reopened, a saved line at General's location goes with it still, and one somewhere else keeps its own", () => {
    const choices: RequisitionChoices = { ...CHOICES, places: [...CHOICES.places, { id: 'place-truck', name: 'Truck 2', code: 'TRK2' }] };
    const saved = detail({
      status: 'DRAFT',
      can: { ...detail().can, edit: true, submit: true },
      lines: detail().lines.map((line, index) =>
        index === 0 ? { ...line, place: { id: 'place-stockroom', name: 'Stockroom', code: 'STORE' }, expectedOn: '2026-11-24' } : { ...line, place: { id: 'place-truck', name: 'Truck 2', code: 'TRK2' }, expectedOn: '2026-11-30' },
      ),
    });
    render(<RequisitionForm choices={choices} discardLabel="Discard" error={null} onDiscard={vi.fn()} onSave={vi.fn(async () => undefined)} pending={false} requisition={saved} />);
    choose('Location Code', 'TRK2 · Truck 2');
    fireEvent.change(screen.getByLabelText('Expected Receipt Date'), { target: { value: '2026-12-02' } });
    choose('Location Code', 'STORE · Stockroom');
    expect(screen.getByLabelText('Location of Filter 20x25x1').textContent).toBe('STORE');
    expect((screen.getByLabelText('Expected receipt date of Filter 20x25x1') as HTMLInputElement).value).toBe('2026-12-02');
    expect(screen.getByLabelText('Location of Battery, 9 V').textContent).toBe('TRK2');
    expect((screen.getByLabelText('Expected receipt date of Battery, 9 V') as HTMLInputElement).value).toBe('2026-11-30');
  });

  it('adds everything of the company that is low, at what the office usually orders and what one cost', async () => {
    const onSave = mount();
    choose('Purchaser Code', 'THMP · THMP');
    choose('Location Code', 'STORE · Stockroom');
    fireEvent.click(screen.getByRole('button', { name: 'Add Everything That Is Low' }));

    const table = screen.getByRole('table', { name: 'Lines' });
    expect((within(table).getByLabelText('Quantity of Filter 20x25x1') as HTMLInputElement).value).toBe('36');
    expect((within(table).getByLabelText('Direct unit cost of Battery, 9 V') as HTMLInputElement).value).toBe('1.85');
    expect(within(table).queryByLabelText('Quantity of Smoke alarm')).toBeNull();
    expect(within(table).queryByLabelText('Quantity of Glue boards')).toBeNull();
    expect(screen.getByText('Total Incl. Tax (USD):').parentElement!.textContent).toContain('184.80');

    // Why it is needed is a note now, not a requirement (2026-11-20).
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(submit());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        xeroTenantId: 'tenant-thmp',
        neededBy: null,
        deliverToPlaceId: 'place-stockroom',
        requestCodeId: null,
        costCenterId: null,
        reason: '',
        lines: [
          // Each line goes to the requisition's location, and the filter to its usual vendor.
          { itemId: 'item-filter', quantity: 36, estimatedUnitCostCents: 390, description: null, placeId: 'place-stockroom', expectedOn: null, vendorId: 'vendor-hill', departmentId: null, notes: null },
          { itemId: 'item-battery', quantity: 24, estimatedUnitCostCents: 185, description: null, placeId: 'place-stockroom', expectedOn: null, vendorId: null, departmentId: null, notes: null },
        ],
        quotes: [],
      }),
      true,
    );
  });

  it('says who approves, and asks for quotes once it is above the limit', () => {
    mount();
    // Before the Purchaser Code is chosen, every company's codes are offered, and the one picked decides it (2026-11-21).
    fireEvent.keyDown(screen.getByLabelText('Item on line 1'), { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Glue boards/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /SMK-10/ }));
    expect(screen.getByLabelText('Purchaser Code').textContent).toContain('THMP');
    // Then only that company's codes are.
    fireEvent.click(screen.getByRole('button', { name: 'Add New Line' }));
    fireEvent.keyDown(screen.getByLabelText('Item on line 2'), { key: 'ArrowDown' });
    expect(screen.queryByRole('option', { name: /Glue boards/ })).toBeNull();
    fireEvent.keyDown(screen.getByLabelText('Item on line 2'), { key: 'Escape' });
    expect((screen.getByLabelText('Direct unit cost of Smoke alarm') as HTMLInputElement).value).toBe('15.30');
    fireEvent.change(screen.getByLabelText('Quantity of Smoke alarm'), { target: { value: '40' } });

    expect(screen.getByText('Somebody who may approve any amount')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('At this amount, 2 quotes are needed.');
    expect(greyed(submit())).toBe(true);
    // Pressed, greyed, it says why rather than nothing (2026-11-21).
    fireEvent.click(submit());
    expect(screen.getByRole('dialog', { name: 'Why Send Approval Request cannot be pressed' }).textContent).toContain('At this amount, 2 quotes are needed.');
  });

  it('asks for every line by an item code, and never saves a blank line (2026-11-20)', async () => {
    const onSave = mount();
    expect(screen.queryByRole('button', { name: /not in the list/i })).toBeNull();
    expect(screen.getByText(/a blank line is not saved/)).toBeTruthy();
    // A new one starts with one blank line, ready to type in, as a spreadsheet's next row.
    expect(screen.getAllByLabelText(/^Item on line/)).toHaveLength(1);
    const draft = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(greyed(draft)).toBe(false);

    // Something typed on a line with no item code is not a line yet.
    fireEvent.change(screen.getByLabelText('Notes on line 1'), { target: { value: 'Something' } });
    expect(greyed(draft)).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Finish or delete the lines that are not filled in.');

    // Delete Line takes the line the cursor is on.
    fireEvent.focus(screen.getByLabelText('Notes on line 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Line' }));
    expect(greyed(draft)).toBe(false);
    fireEvent.click(draft);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ lines: [], reason: '' }), false));
  });

  it('takes an item typed by part of its description, and fills the line from it in yellow (2026-11-20)', async () => {
    const onSave = mount();
    choose('Location Code', 'STORE · Stockroom');
    fireEvent.change(screen.getByLabelText('Expected Receipt Date'), { target: { value: '2026-11-26' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add New Line' }));
    const picker = screen.getByLabelText('Item on line 1');
    fireEvent.change(picker, { target: { value: 'filt' } });
    // The dropdown shows what matches by code or description, with what is on hand.
    expect(screen.getByRole('option', { name: /FLT-20251/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /BAT-9V/ })).toBeNull();
    fireEvent.keyDown(picker, { key: 'Enter' });

    expect((picker as HTMLInputElement).value).toBe('FLT-20251');
    const description = screen.getByLabelText('Description of Filter 20x25x1') as HTMLInputElement;
    expect(description.value).toBe('Filter 20x25x1');
    expect(description.closest('td')!.className).toContain('bg-warning');
    expect(screen.getByLabelText('Vendor of Filter 20x25x1').textContent).toContain('V-00003');
    expect((screen.getByLabelText('Expected receipt date of Filter 20x25x1') as HTMLInputElement).value).toBe('2026-11-26');
    // Changed by hand, a field is no longer marked.
    fireEvent.change(description, { target: { value: 'Filter 20x25x1, MERV 8' } });
    expect(description.closest('td')!.className).not.toContain('bg-warning');
    // The FactBoxes follow the line: what is on order, and the order that last asked.
    expect(screen.getByRole('region', { name: 'Item Availability' }).textContent).toContain('24');
    expect(screen.getByRole('region', { name: 'Line Details' }).textContent).toContain('PO-0007');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ lines: [expect.objectContaining({ itemId: 'item-filter', description: 'Filter 20x25x1, MERV 8', expectedOn: '2026-11-26', vendorId: 'vendor-hill', placeId: 'place-stockroom' })] }),
        false,
      ),
    );
  });

  it('takes a code typed whole, or scanned, with Enter', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add New Line' }));
    const picker = screen.getByLabelText('Item on line 1');
    fireEvent.change(picker, { target: { value: 'bat-9v' } });
    fireEvent.keyDown(picker, { key: 'Enter' });
    expect((screen.getByLabelText('Quantity of Battery, 9 V') as HTMLInputElement).value).toBe('24');
  });

  it('opens the whole list from Advanced, to filter and choose', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add New Line' }));
    fireEvent.keyDown(screen.getByLabelText('Item on line 1'), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    const dialog = screen.getByRole('dialog', { name: 'Select – Item Codes' });
    // No company chosen yet: every company's codes, with the header row.
    expect(within(dialog).getAllByRole('row')).toHaveLength(5);
    fireEvent.change(within(dialog).getByPlaceholderText('*filter*'), { target: { value: '*alarm*' } });
    expect(within(dialog).getAllByRole('row')).toHaveLength(2);
    expect((within(dialog).getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('row', { name: /SMK-10/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    expect(screen.queryByRole('dialog', { name: 'Select – Item Codes' })).toBeNull();
    expect((screen.getByLabelText('Item on line 1') as HTMLInputElement).value).toBe('SMK-10');
  });

  it('sends the General codes and the document date', async () => {
    const onSave = mount();
    expect(screen.getByText('SREQUESTER')).toBeTruthy();
    expect(screen.getByText('Given when it is saved')).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText('Request Code'), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: 'RESTOCK · Restock the storeroom' }));
    fireEvent.keyDown(screen.getByLabelText('Cost Center Code'), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: 'MAINT · Maintenance' }));
    fireEvent.change(screen.getByLabelText('Document Date:'), { target: { value: '2026-11-18' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ requestCodeId: 'code-restock', costCenterId: 'code-maint', documentDate: '2026-11-18' }), false));
  });

  it('opens a sent-back requisition with what it asked for', () => {
    mount(detail({ status: 'SENT_BACK', can: { edit: true, submit: true, cancel: true, approve: false, sendBack: false, reject: false, order: false, approveBlocked: null, attach: true, recall: false, reopen: false } }));

    expect((screen.getByLabelText('Why it is needed') as HTMLTextAreaElement).value).toContain('14 inspections');
    expect((screen.getByLabelText('Quantity of Battery, 9 V') as HTMLInputElement).value).toBe('24');
    expect(submit().disabled).toBe(false);
  });
});

describe('one requisition', () => {
  const mount = (data: RequisitionDetail) => {
    hooks.useRequisition.mockReturnValue({ isLoading: false, isError: false, data });
    return render(<RequisitionPage />);
  };
  const ribbon = () => within(screen.getByRole('toolbar', { name: 'Requisition actions' }));
  const pressed = (name: string) => fireEvent.click(ribbon().getByRole('button', { name }));

  it('reads as the same NAV page, and lets an approver approve, or send back or reject only with a note', async () => {
    mount(detail());

    expect(screen.getByRole('heading', { name: 'PR-0012' })).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'Lines' })).getByRole('row', { name: /FLT-20251/ }).textContent).toContain('$140.40');
    // The General FastTab, read as it stands, and nothing to type in.
    expect(screen.getByText('SREQUESTER')).toBeTruthy();
    expect(screen.getByText('Requisitioner Name:')).toBeTruthy();
    expect(screen.queryByLabelText('Item on line 1')).toBeNull();
    // What it chooses from is read either way, for the FactBoxes.
    expect(hooks.useRequisitionChoices).toHaveBeenCalledWith(true);

    pressed('Send Back');
    const dialog = screen.getByRole('dialog', { name: 'Send it back' });
    const send = within(dialog).getByRole('button', { name: 'Send Back' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Note, needed'), { target: { value: ' Fewer batteries. ' } });
    fireEvent.click(send);
    await waitFor(() => expect(edits.step!.mutateAsync).toHaveBeenCalledWith({ requisitionId: 'req-12', step: 'send-back', input: { note: 'Fewer batteries.' } }));

    // Release is NAV's name for approving it.
    pressed('Release');
    await waitFor(() => expect(edits.step!.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ step: 'approve' })));
    pressed('Approve');
    await waitFor(() => expect(edits.step!.mutateAsync).toHaveBeenCalledTimes(3));
  });

  it('greys Approve out, saying why, for somebody who may not approve this much', () => {
    mount(detail({ can: { edit: false, submit: false, cancel: false, approve: false, sendBack: true, reject: true, order: false, approveBlocked: 'It is above the $500.00 approval limit, so it needs somebody who may approve any amount.', attach: true, recall: false, reopen: false } }));

    const approve = ribbon().getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(greyed(approve)).toBe(true);
    expect(approve.title).toMatch(/above the \$500\.00 approval limit/);
    fireEvent.click(approve);
    expect(edits.step!.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Why Approve cannot be pressed' }).textContent).toMatch(/above the \$500\.00 approval limit/);
    expect((ribbon().getByRole('button', { name: 'Send Back' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows its author a submitted requisition as it stands: no decision, but Cancel Approval Request and Delete', async () => {
    mount(detail({ can: { edit: false, submit: false, cancel: true, approve: false, sendBack: false, reject: false, order: false, approveBlocked: null, attach: true, recall: true, reopen: false } }));

    expect(ribbon().queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByLabelText('Why it is needed')).toBeNull();
    expect(screen.getByText('Sample Requester submitted it')).toBeTruthy();

    pressed('Cancel Approval Request');
    await waitFor(() => expect(edits.step!.mutateAsync).toHaveBeenCalledWith({ requisitionId: 'req-12', step: 'recall', input: {} }));

    pressed('Delete');
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Delete PR-0012?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(edits.step!.mutateAsync).toHaveBeenCalledWith({ requisitionId: 'req-12', step: 'cancel', input: {} }));
  });

  it('reopens an approved one, with a note if one is given', async () => {
    mount(detail({ status: 'APPROVED', can: { edit: false, submit: false, cancel: false, approve: false, sendBack: false, reject: false, order: false, approveBlocked: null, attach: true, recall: false, reopen: true } }));

    pressed('Reopen');
    const dialog = screen.getByRole('dialog', { name: 'Reopen PR-0012' });
    fireEvent.change(within(dialog).getByLabelText('Note'), { target: { value: 'Add the 9 V batteries.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(edits.step!.mutateAsync).toHaveBeenCalledWith({ requisitionId: 'req-12', step: 'reopen', input: { note: 'Add the 9 V batteries.' } }));
  });

  it('opens the form for its author when it was sent back, with the approver note above it', () => {
    mount(
      detail({
        status: 'SENT_BACK',
        decidedBy: 'Sample Manager',
        decisionNote: 'Fewer batteries.',
        can: { edit: true, submit: true, cancel: true, approve: false, sendBack: false, reject: false, order: false, approveBlocked: null, attach: true, recall: false, reopen: false },
      }),
    );

    expect(screen.getByText(/Sample Manager sent it back: “Fewer batteries\.”/)).toBeTruthy();
    expect(screen.getByLabelText('Why it is needed')).toBeTruthy();
    expect(screen.getByLabelText('Item on line 1')).toBeTruthy();
  });
});

describe('a requisition and its order', () => {
  const mount = (data: RequisitionDetail) => {
    hooks.useRequisition.mockReturnValue({ isLoading: false, isError: false, data });
    return render(<RequisitionPage />);
  };
  const approved = { edit: false, submit: false, cancel: false, approve: false, sendBack: false, reject: false, approveBlocked: null, attach: true, recall: false, reopen: false };
  const makeOrder = () => within(screen.getByRole('toolbar', { name: 'Requisition actions' })).getByRole('button', { name: 'Make Purchase Order' }) as HTMLButtonElement;

  it('offers a purchaser the order to make, and opens it once made', async () => {
    orderEdits.create!.mutateAsync.mockResolvedValue({ orders: [{ id: 'order-9', vendor: { id: 'vendor-hill', number: 'V00010', name: 'Hill Country Supply' } }] } as never);
    mount(detail({ status: 'APPROVED', can: { ...approved, order: true } }));

    fireEvent.click(makeOrder());
    await waitFor(() => expect(orderEdits.create!.mutateAsync).toHaveBeenCalledWith('req-12'));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/purchasing/orders/order-9'));
  });

  // One order a vendor (2026-11-20): several made stay on the requisition, each one linked.
  it('lists the orders made when there is one for each of several vendors', async () => {
    router.push.mockClear();
    orderEdits.create!.mutateAsync.mockResolvedValue({
      orders: [
        { id: 'order-9', vendor: { id: 'vendor-hill', number: 'V00010', name: 'Hill Country Supply' } },
        { id: 'order-10', vendor: null },
      ],
    } as never);
    mount(detail({ status: 'APPROVED', can: { ...approved, order: true } }));

    fireEvent.click(makeOrder());
    expect(await screen.findByText('Made 2 draft purchase orders, one a vendor:')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'V00010 Hill Country Supply' }).getAttribute('href')).toBe('/purchasing/orders/order-9');
    expect(screen.getByRole('link', { name: 'Vendor to choose' }).getAttribute('href')).toBe('/purchasing/orders/order-10');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('prints the requisition as it was saved, signed by whoever printed it', async () => {
    const data = detail({ status: 'APPROVED', can: { ...approved, order: true } });
    mount(data);

    const print = within(screen.getByRole('toolbar', { name: 'Requisition actions' })).getByRole('button', { name: 'Print...' }) as HTMLButtonElement;
    expect(print.disabled).toBe(false);
    fireEvent.click(print);
    await waitFor(() => expect(printed.downloadRequisition).toHaveBeenCalledWith(data, 'Sample Purchaser'));
  });

  it('links each order made from it, with its vendor, and offers none while every vendor has one', () => {
    mount(
      detail({
        status: 'ORDERED',
        orders: [
          { id: 'order-9', number: 'PO-0009', status: 'SENT', vendor: { id: 'vendor-hill', number: 'V00010', name: 'Hill Country Supply' } },
          { id: 'order-10', number: null, status: 'DRAFT', vendor: null },
        ],
        can: { ...approved, order: false },
      }),
    );

    expect(screen.getByRole('link', { name: 'PO-0009 · V00010 Hill Country Supply' }).getAttribute('href')).toBe('/purchasing/orders/order-9');
    expect(screen.getByRole('link', { name: 'Draft order · vendor to choose' }).getAttribute('href')).toBe('/purchasing/orders/order-10');
    expect(greyed(makeOrder())).toBe(true);
  });
});

const orderRow = (over: Partial<PurchaseOrderRow> = {}): PurchaseOrderRow => ({
  id: 'order-9',
  number: 'PO-0009',
  status: 'AWAITING_APPROVAL',
  vendor: { id: 'vendor-hill', name: 'Hill Country Supply' },
  requisition: { id: 'req-12', number: 'PR-0012' },
  company: { tenantId: 'tenant-thmp', name: 'THMP' },
  expectedOn: '2026-11-24',
  lineCount: 2,
  totalCents: 20005,
  madeBy: { id: 'user-buyer', name: 'Sample Purchaser' },
  createdAt: '2026-11-18T16:02:00.000Z',
  sentAt: null,
  ...over,
});
const NOTHING = { edit: false, change: false, submit: false, approve: false, sendBack: false, send: false, cancel: false, receive: false, reverseReceipt: false, bill: false, approveBill: false, overrideBill: false, pay: false, closeShort: false, approveBlocked: null };
const orderDetail = (over: Partial<PurchaseOrderDetail> = {}): PurchaseOrderDetail => ({
  ...orderRow(),
  vendorContact: { contactName: 'A Person', email: 'orders@hill.example', phone: null },
  deliverTo: { id: 'place-stockroom', name: 'Stockroom' },
  terms: 'Net 30',
  taxBasisPoints: 825,
  notes: null,
  lines: [
    { id: 'ol-1', item: { id: 'item-filter', code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each' }, quantity: 36, unitPriceCents: 390, requestedQuantity: 36, receivedQuantity: 0 },
    { id: 'ol-2', item: { id: 'item-battery', code: 'PRT-0001', name: 'Battery, 9 V', unit: 'each' }, quantity: 24, unitPriceCents: 185, requestedQuantity: 24, receivedQuantity: 0 },
  ],
  subtotalCents: 18480,
  taxCents: 1525,
  approvedBy: null,
  approvedAt: null,
  decisionNote: null,
  cancelReason: null,
  from: { name: 'THMP', addressLine1: '1 Example Plaza', addressLine2: null, phone: null, email: 'office@example.test' },
  vendorFiles: [],
  deliveries: [],
  receipts: [],
  bill: null,
  shortCloseReason: null,
  history: [{ at: '2026-11-18T16:10:00.000Z', by: 'Sample Purchaser', what: 'submitted it for approval' }],
  can: { ...NOTHING, approve: true, sendBack: true },
  approvalSteps: stepsFromLimit(50000, 2),
  reapproveChangedOrders: false,
  ...over,
});

describe('the orders tab', () => {
  it('lists the orders when it is opened, each opening its page', () => {
    url.state = { tab: 'orders', show: 'open', status: 'all', q: '' };
    hooks.useRequisitions.mockReturnValue({ isLoading: false, isError: false, data: list([]) });
    hooks.usePurchaseOrders.mockReturnValue({ isLoading: false, isError: false, data: { orders: [orderRow(), orderRow({ id: 'order-8', number: 'PO-0008', status: 'SENT', vendor: { id: 'vendor-alamo', name: 'Alamo Trade Parts' } })] } });
    render(<PurchasingPage />);

    const table = screen.getByRole('table', { name: 'Purchase orders' });
    expect(within(table).getByRole('link', { name: /Hill Country Supply/ }).getAttribute('href')).toBe('/purchasing/orders/order-9');
    expect(within(table).getByRole('row', { name: /PO-0009/ }).textContent).toContain('$200.05');
    expect(within(table).getByRole('row', { name: /PO-0008/ }).textContent).toContain('Sent to the vendor');
    expect(hooks.usePurchaseOrders).toHaveBeenCalledWith('open', true);
  });
});

describe('one order', () => {
  const mount = (data: PurchaseOrderDetail) => {
    hooks.usePurchaseOrder.mockReturnValue({ isLoading: false, isError: false, data });
    return render(<PurchaseOrderPage />);
  };

  it('shows an approver the lines and total with tax, to approve or to send back with a note', async () => {
    mount(orderDetail());

    expect(screen.getByRole('heading', { name: 'Purchase order PO-0009' })).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'What is ordered' })).getByRole('row', { name: /Filter 20x25x1/ }).textContent).toContain('$140.40');
    expect(screen.getByText('Sales tax, 8.25%')).toBeTruthy();
    expect(screen.getByText('$200.05', { selector: 'strong' })).toBeTruthy();
    const sendBack = screen.getByRole('button', { name: 'Send back with the note' }) as HTMLButtonElement;
    expect(sendBack.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /vendor/i })).toBeNull();

    fireEvent.change(screen.getByLabelText('Note to Sample Purchaser'), { target: { value: 'Ask Alamo too.' } });
    fireEvent.click(sendBack);
    await waitFor(() => expect(orderEdits.step!.mutateAsync).toHaveBeenCalledWith({ orderId: 'order-9', step: 'send-back', input: { note: 'Ask Alamo too.' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(orderEdits.step!.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ step: 'approve' })));
  });

  it('says why whoever made it cannot approve it', () => {
    mount(orderDetail({ can: { ...NOTHING, approveBlocked: 'You made this order, so somebody else approves it.' } }));

    expect(screen.getByText('You made this order, so somebody else approves it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('sends an approved order to the vendor in one email, with the PDF made on the press', async () => {
    mount(orderDetail({ status: 'APPROVED', approvedBy: 'Sample Owner', can: { ...NOTHING, send: true, cancel: true } }));
    expect(pdf.orderAttachment).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Send to the vendor' }));
    const dialog = screen.getByRole('dialog', { name: 'Send to the vendor' });
    expect((within(dialog).getByLabelText('To') as HTMLInputElement).value).toBe('orders@hill.example');
    fireEvent.change(within(dialog).getByLabelText('Message'), { target: { value: ' Please confirm the day. ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(orderEdits.send!.mutateAsync).toHaveBeenCalledTimes(1));
    expect(pdf.orderAttachment).toHaveBeenCalledTimes(1);
    expect(orderEdits.send!.mutateAsync).toHaveBeenCalledWith({
      orderId: 'order-9',
      input: { to: 'orders@hill.example', message: 'Please confirm the day.', attachment: { fileName: 'PO-0009 Hill Country Supply.pdf', contentBase64: 'JVBERi0=' }, clientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    });
  });

  it('lists the requisition’s files ticked for the vendor under the PDF', () => {
    mount(orderDetail({ status: 'APPROVED', vendorFiles: [{ id: 'f1', fileName: 'Quote - Hill Country Supply.pdf', sizeBytes: 182_000 }], can: { ...NOTHING, send: true } }));
    fireEvent.click(screen.getByRole('button', { name: 'Send to the vendor' }));
    const files = within(screen.getByRole('dialog', { name: 'Send to the vendor' })).getByRole('region', { name: 'Files that go with it' });

    expect(within(files).getByText('Quote - Hill Country Supply.pdf')).toBeTruthy();
    expect(within(files).getByText('182 KB')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not offer to send files ticked past what one email carries', () => {
    mount(orderDetail({ status: 'APPROVED', vendorFiles: [{ id: 'f1', fileName: 'Quote.pdf', sizeBytes: 1_500_000 }, { id: 'f2', fileName: 'Shelf.jpg', sizeBytes: 1_600_000 }], can: { ...NOTHING, send: true } }));
    fireEvent.click(screen.getByRole('button', { name: 'Send to the vendor' }));

    expect(screen.getByText(/These come to 3.1 MB, and one email carries at most 2.5 MB beside the PDF/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('cancels only with a reason, and warns that a sent order is not withdrawn from the vendor', async () => {
    mount(orderDetail({ status: 'SENT', sentAt: '2026-11-18T16:40:00.000Z', deliveries: [{ id: 'd1', recipient: 'orders@hill.example', status: 'SENT', failure: null, at: '2026-11-18T16:40:00.000Z', by: 'Sample Purchaser' }], can: { ...NOTHING, send: true, cancel: true } }));

    expect(screen.getByRole('button', { name: 'Email the vendor again' })).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Emails of this order, newest first' })).getByText('orders@hill.example')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this order' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel this order?' });
    expect(within(dialog).getByText(/does not tell them/)).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Cancel the order' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText('Why'), { target: { value: ' Vendor is out of stock. ' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(orderEdits.step!.mutateAsync).toHaveBeenCalledWith({ orderId: 'order-9', step: 'cancel', input: { reason: 'Vendor is out of stock.' } }));
  });

  it('lets its purchaser set the price and tax of a draft, leave a line out, and submit it', async () => {
    orderEdits.update!.mutateAsync.mockResolvedValue({} as never);
    mount(orderDetail({ status: 'DRAFT', number: null, taxBasisPoints: 0, taxCents: 0, totalCents: 18480, can: { ...NOTHING, edit: true, submit: true, cancel: true } }));

    fireEvent.change(screen.getByLabelText('Price of one Filter 20x25x1'), { target: { value: '3.75' } });
    fireEvent.change(screen.getByLabelText('Sales tax, %'), { target: { value: '8.25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Leave out Battery, 9 V' }));
    expect(screen.getByText('$146.14', { selector: 'strong' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));

    await waitFor(() => expect(orderEdits.step!.mutateAsync).toHaveBeenCalledWith({ orderId: 'order-9', step: 'submit' }));
    expect(orderEdits.update!.mutateAsync).toHaveBeenCalledWith({
      orderId: 'order-9',
      input: { vendorId: 'vendor-hill', deliverToPlaceId: 'place-stockroom', expectedOn: '2026-11-24', terms: 'Net 30', taxBasisPoints: 825, notes: null, lines: [{ itemId: 'item-filter', quantity: 36, unitPriceCents: 375 }] },
    });
  });
});
