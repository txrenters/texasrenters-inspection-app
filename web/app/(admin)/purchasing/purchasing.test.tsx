import type { PurchaseOrderDetail, PurchaseOrderRow, RequisitionChoices, RequisitionDetail, RequisitionList, RequisitionRow } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequisitionForm } from '@/components/purchasing/requisition-form';

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
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: (permission: string) => account.permissions.has(permission) }) }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), query: '' }));
vi.mock('next/navigation', () => ({ useParams: () => ({ requisitionId: 'req-12', orderId: 'order-9' }), useRouter: () => router, useSearchParams: () => new URLSearchParams(router.query) }));
const pdf = vi.hoisted(() => ({ downloadOrder: vi.fn(async () => undefined), orderAttachment: vi.fn(async () => ({ fileName: 'PO-0009 Hill Country Supply.pdf', contentBase64: 'JVBERi0=' })) }));
vi.mock('@/lib/purchase-order-pdf/download-order', () => pdf);

const SETTINGS = { approvalLimitCents: 50000, quotesAboveLimit: 2 };
const row = (over: Partial<RequisitionRow> = {}): RequisitionRow => ({
  id: 'req-12',
  number: 'PR-0012',
  status: 'SUBMITTED',
  requestedBy: { id: 'user-vance', name: 'Sample Requester' },
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
const detail = (over: Partial<RequisitionDetail> = {}): RequisitionDetail => ({
  ...row(),
  reason: 'Filters are out and next week has 14 inspections booked.',
  deliverTo: { id: 'place-stockroom', name: 'Stockroom' },
  lines: [
    { id: 'line-1', item: { id: 'item-filter', code: 'FLT-20251', name: 'Filter 20x25x1', unit: 'each' }, description: null, quantity: 36, estimatedUnitCostCents: 390, onHand: 0, reorderLevel: 18 },
    { id: 'line-2', item: { id: 'item-battery', code: 'BAT-9V', name: 'Battery, 9 V', unit: 'each' }, description: null, quantity: 24, estimatedUnitCostCents: 185, onHand: 5, reorderLevel: 12 },
  ],
  quotes: [],
  decidedBy: null,
  decidedAt: null,
  order: null,
  history: [
    { at: '2026-11-17T15:12:00.000Z', by: 'Sample Requester', what: 'submitted it' },
    { at: '2026-11-17T14:58:00.000Z', by: 'Sample Requester', what: 'started it' },
  ],
  can: { edit: false, submit: false, cancel: false, approve: true, sendBack: true, reject: true, order: false, approveBlocked: null },
  settings: SETTINGS,
  ...over,
});
const CHOICES: RequisitionChoices = {
  items: [
    { id: 'item-filter', code: 'FLT-20251', name: 'Filter 20x25x1', unit: 'each', companyTenantId: 'tenant-thmp', onHand: 0, reorderLevel: 18, reorderQuantity: 36, averageCostCents: 390, priceCents: null },
    { id: 'item-battery', code: 'BAT-9V', name: 'Battery, 9 V', unit: 'each', companyTenantId: 'tenant-thmp', onHand: 5, reorderLevel: 12, reorderQuantity: 24, averageCostCents: 185, priceCents: null },
    { id: 'item-alarm', code: 'SMK-10', name: 'Smoke alarm', unit: 'each', companyTenantId: 'tenant-thmp', onHand: 40, reorderLevel: 6, reorderQuantity: 12, averageCostCents: 1530, priceCents: null },
    { id: 'item-glue', code: 'PST-GLUE', name: 'Glue boards', unit: 'pack', companyTenantId: 'tenant-pest', onHand: 0, reorderLevel: 8, reorderQuantity: 12, averageCostCents: 910, priceCents: null },
  ],
  places: [{ id: 'place-stockroom', name: 'Stockroom' }],
  companies: [{ tenantId: 'tenant-thmp', name: 'THMP' }, { tenantId: 'tenant-pest', name: 'Crystal Creek Pest' }],
  vendors: [{ id: 'vendor-hill', name: 'Hill Country Supply' }],
  settings: SETTINGS,
};

let edits: Record<string, ReturnType<typeof mutation>>;
let orderEdits: Record<string, ReturnType<typeof mutation>>;
const list = (requisitions: RequisitionRow[], seesAll = true): RequisitionList => ({ requisitions, settings: SETTINGS, seesAll });

beforeEach(() => {
  url.state = { tab: 'requisitions', show: 'open', status: 'all', q: '' };
  router.push.mockReset();
  router.query = '';
  pdf.orderAttachment.mockClear();
  pdf.downloadOrder.mockClear();
  orderEdits = { create: mutation(), update: mutation(), step: mutation(), send: mutation() };
  hooks.usePurchaseOrderEdits.mockReturnValue(orderEdits);
  hooks.usePurchaseReceivingEdits.mockReturnValue(Object.fromEntries(['receive', 'reverseReceipt', 'closeShort', 'saveBill', 'approveBill', 'approveBillAnyway', 'payBill'].map((name) => [name, mutation()])));
  account.permissions = new Set(['purchasing:request']);
  edits = { create: mutation(), update: mutation(), step: mutation(), saveSettings: mutation() };
  hooks.usePurchasingEdits.mockReturnValue(edits);
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

  it('offers the approval limits only to somebody who may approve any amount', () => {
    const first = mount(list([row()]));
    expect(screen.queryByRole('button', { name: 'Approval limits' })).toBeNull();
    expect(screen.getByRole('link', { name: 'New requisition' }).getAttribute('href')).toBe('/purchasing/requisitions/new');
    first.unmount();

    account.permissions = new Set(['purchasing:request', 'purchasing:approve', 'purchasing:approve-any']);
    mount(list([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Approval limits' }));
    const dialog = screen.getByRole('dialog', { name: 'Approval limits' });
    fireEvent.change(within(dialog).getByLabelText('Approval limit'), { target: { value: '1,000.00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save limits' }));
    return waitFor(() => expect(edits.saveSettings!.mutateAsync).toHaveBeenCalledWith({ approvalLimitCents: 100000, quotesAboveLimit: 2 }));
  });
});

describe('a requisition begun from the Reorder list', () => {
  it('starts with the ticked items at the quantities asked, for their company, at what one cost', () => {
    router.query = 'items=item-glue:12,item-nothing:5,item-filter:9,item-glue:x';
    render(<NewRequisitionPage />);

    // The first item on it is the pest company's, so the request is that company's: the filter is another's and is left off.
    const table = screen.getByRole('table', { name: 'What is asked for' });
    expect((within(table).getByLabelText('Quantity of Glue boards') as HTMLInputElement).value).toBe('12');
    expect((within(table).getByLabelText('Estimated cost of one Glue boards') as HTMLInputElement).value).toBe('9.10');
    expect(within(table).queryByLabelText('Quantity of Filter 20x25x1')).toBeNull();
    expect(screen.getByLabelText('Company it is for').textContent).toContain('Crystal Creek Pest');
    // Nothing is saved by opening it.
    expect(edits.create!.mutateAsync).not.toHaveBeenCalled();
  });

  it('is an empty requisition when nothing was ticked', () => {
    render(<NewRequisitionPage />);
    expect(screen.queryByLabelText(/^Quantity of/)).toBeNull();
    expect(screen.getByLabelText('Company it is for').textContent).toContain('THMP');
  });
});

describe("a line's cost", () => {
  it('starts from the usual price the stock keeper gave the item, and from the average cost when it has none', () => {
    const priced: RequisitionChoices = { ...CHOICES, items: CHOICES.items.map((item) => (item.id === 'item-filter' ? { ...item, priceCents: 425 } : item)) };
    render(<RequisitionForm choices={priced} discardLabel="Discard" error={null} onDiscard={vi.fn()} onSave={vi.fn(async () => undefined)} pending={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add everything that is low' }));
    const table = screen.getByRole('table', { name: 'What is asked for' });
    // The filter has a price of $4.25 and cost $3.90 on average: the price is what the line starts from.
    expect((within(table).getByLabelText('Estimated cost of one Filter 20x25x1') as HTMLInputElement).value).toBe('4.25');
    // The battery has no price: what one cost on average.
    expect((within(table).getByLabelText('Estimated cost of one Battery, 9 V') as HTMLInputElement).value).toBe('1.85');
  });
});

describe('filling a requisition in', () => {
  const mount = (requisition?: RequisitionDetail) => {
    const onSave = vi.fn(async () => undefined);
    render(<RequisitionForm choices={CHOICES} discardLabel="Discard" error={null} onDiscard={vi.fn()} onSave={onSave} pending={false} requisition={requisition} />);
    return onSave;
  };
  const submit = () => screen.getByRole('button', { name: 'Submit for approval' }) as HTMLButtonElement;

  it('adds everything of the company that is low, at what the office usually orders and what one cost', async () => {
    const onSave = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add everything that is low' }));

    const table = screen.getByRole('table', { name: 'What is asked for' });
    expect((within(table).getByLabelText('Quantity of Filter 20x25x1') as HTMLInputElement).value).toBe('36');
    expect((within(table).getByLabelText('Estimated cost of one Battery, 9 V') as HTMLInputElement).value).toBe('1.85');
    expect(within(table).queryByLabelText('Quantity of Smoke alarm')).toBeNull();
    expect(within(table).queryByLabelText('Quantity of Glue boards')).toBeNull();
    expect(within(table).getByRole('row', { name: /Estimated total/ }).textContent).toContain('$184.80');

    expect(submit().disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Say why it is needed.');
    fireEvent.change(screen.getByLabelText('Why it is needed'), { target: { value: ' Filters are out. ' } });
    fireEvent.click(submit());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      {
        xeroTenantId: 'tenant-thmp',
        neededBy: null,
        deliverToPlaceId: 'place-stockroom',
        reason: 'Filters are out.',
        lines: [
          { itemId: 'item-filter', quantity: 36, estimatedUnitCostCents: 390 },
          { itemId: 'item-battery', quantity: 24, estimatedUnitCostCents: 185 },
        ],
        quotes: [],
      },
      true,
    );
  });

  it('says who approves, and asks for quotes once it is above the limit', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add an item' }));
    fireEvent.keyDown(screen.getByLabelText('Item on line 1'), { key: 'ArrowDown' });
    expect(screen.queryByRole('option', { name: /Glue boards/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'SMK-10 · Smoke alarm' }));
    expect((screen.getByLabelText('Estimated cost of one Smoke alarm') as HTMLInputElement).value).toBe('15.30');
    fireEvent.change(screen.getByLabelText('Quantity of Smoke alarm'), { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText('Why it is needed'), { target: { value: 'Replacing expired alarms.' } });

    expect(screen.getByText('Somebody who may approve any amount')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Above the approval limit, 2 quotes are needed.');
    expect(submit().disabled).toBe(true);
  });

  it('asks for every line by an item code: nothing is written in words', async () => {
    const onSave = mount();
    expect(screen.queryByRole('button', { name: /not in the list/i })).toBeNull();
    expect(screen.getByText(/Every line uses an item code/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add an item' }));
    const draft = screen.getByRole('button', { name: 'Save as a draft' }) as HTMLButtonElement;
    expect(draft.disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Finish or remove the rows that are not filled in.');

    fireEvent.click(screen.getByRole('button', { name: 'Remove line 1' }));
    expect(draft.disabled).toBe(false);
    fireEvent.click(draft);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ lines: [], reason: '' }), false));
  });

  it('opens a sent-back requisition with what it asked for', () => {
    mount(detail({ status: 'SENT_BACK', can: { edit: true, submit: true, cancel: true, approve: false, sendBack: false, reject: false, order: false, approveBlocked: null } }));

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

  it('lets an approver approve, and send back or reject only with a note', async () => {
    mount(detail());

    expect(screen.getByRole('heading', { name: 'Purchase requisition PR-0012' })).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'What is asked for' })).getByRole('row', { name: /Filter 20x25x1/ }).textContent).toContain('$140.40');
    const sendBack = screen.getByRole('button', { name: 'Send back with the note' }) as HTMLButtonElement;
    expect(sendBack.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Note to Sample Requester'), { target: { value: ' Fewer batteries. ' } });
    fireEvent.click(sendBack);
    await waitFor(() => expect(edits.step!.mutateAsync).toHaveBeenCalledWith({ requisitionId: 'req-12', step: 'send-back', input: { note: 'Fewer batteries.' } }));

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(edits.step!.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ step: 'approve' })));
    expect(hooks.useRequisitionChoices).toHaveBeenCalledWith(false);
  });

  it('says why somebody cannot approve it, and offers no Approve', () => {
    mount(detail({ can: { edit: false, submit: false, cancel: false, approve: false, sendBack: true, reject: true, order: false, approveBlocked: 'It is above the $500.00 approval limit, so it needs somebody who may approve any amount.' } }));

    expect(screen.getByText(/above the \$500\.00 approval limit/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send back with the note' })).toBeTruthy();
  });

  it('shows its author a submitted requisition as it stands, with only Cancel to press', async () => {
    mount(detail({ can: { edit: false, submit: false, cancel: true, approve: false, sendBack: false, reject: false, order: false, approveBlocked: null } }));

    expect(screen.queryByRole('heading', { name: 'Your decision' })).toBeNull();
    expect(screen.queryByLabelText('Why it is needed')).toBeNull();
    expect(screen.getByText('Sample Requester submitted it')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this requisition' }));
    await waitFor(() => expect(edits.step!.mutateAsync).toHaveBeenCalledWith({ requisitionId: 'req-12', step: 'cancel', input: {} }));
  });

  it('opens the form for its author when it was sent back, with the approver\'s note above it', () => {
    mount(
      detail({
        status: 'SENT_BACK',
        decidedBy: 'Sample Manager',
        decisionNote: 'Fewer batteries.',
        can: { edit: true, submit: true, cancel: true, approve: false, sendBack: false, reject: false, order: false, approveBlocked: null },
      }),
    );

    expect(screen.getByText(/Sample Manager sent it back: “Fewer batteries\.”/)).toBeTruthy();
    expect(screen.getByLabelText('Why it is needed')).toBeTruthy();
    expect(hooks.useRequisitionChoices).toHaveBeenCalledWith(true);
  });
});

describe('a requisition and its order', () => {
  const mount = (data: RequisitionDetail) => {
    hooks.useRequisition.mockReturnValue({ isLoading: false, isError: false, data });
    return render(<RequisitionPage />);
  };
  const approved = { edit: false, submit: false, cancel: false, approve: false, sendBack: false, reject: false, approveBlocked: null };

  it('offers a purchaser the order to make, and opens it once made', async () => {
    orderEdits.create!.mutateAsync.mockResolvedValue({ id: 'order-9' } as never);
    mount(detail({ status: 'APPROVED', can: { ...approved, order: true } }));

    fireEvent.click(screen.getByRole('button', { name: 'Make purchase order' }));
    await waitFor(() => expect(orderEdits.create!.mutateAsync).toHaveBeenCalledWith('req-12'));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/purchasing/orders/order-9'));
  });

  it('links the order made from it, and offers no second one', () => {
    mount(detail({ status: 'ORDERED', order: { id: 'order-9', number: 'PO-0009' }, can: { ...approved, order: false } }));

    expect(screen.getByRole('link', { name: 'PO-0009' }).getAttribute('href')).toBe('/purchasing/orders/order-9');
    expect(screen.queryByRole('button', { name: 'Make purchase order' })).toBeNull();
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
const NOTHING = { edit: false, submit: false, approve: false, sendBack: false, send: false, cancel: false, receive: false, reverseReceipt: false, bill: false, approveBill: false, overrideBill: false, pay: false, closeShort: false, approveBlocked: null };
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
  deliveries: [],
  receipts: [],
  bill: null,
  shortCloseReason: null,
  history: [{ at: '2026-11-18T16:10:00.000Z', by: 'Sample Purchaser', what: 'submitted it for approval' }],
  can: { ...NOTHING, approve: true, sendBack: true },
  approvalLimitCents: 50000,
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
