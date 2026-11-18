import type { RequisitionChoices, RequisitionDetail, RequisitionList, RequisitionRow } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequisitionForm } from '@/components/purchasing/requisition-form';

import PurchasingPage from './page';
import RequisitionPage from './requisitions/[requisitionId]/page';

/** Purchase requisitions, phase 2 (2026-11-19). Every item, person, vendor and price invented. */

const mutation = () => ({ mutateAsync: vi.fn(async () => ({})), isPending: false, error: null, reset: vi.fn(), data: undefined });
const hooks = vi.hoisted(() => ({ useRequisitions: vi.fn(), useRequisition: vi.fn(), useRequisitionChoices: vi.fn(), usePurchasingEdits: vi.fn() }));
vi.mock('@/lib/purchasing-queries', () => hooks);
const url = vi.hoisted(() => ({ state: { show: 'open', status: 'all', q: '' }, set: vi.fn() }));
vi.mock('@/lib/url-state', () => ({ useUrlState: () => [url.state, url.set, vi.fn()] }));
const account = vi.hoisted(() => ({ permissions: new Set<string>() }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: (permission: string) => account.permissions.has(permission) }) }));
vi.mock('next/navigation', () => ({ useParams: () => ({ requisitionId: 'req-12' }), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

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
  history: [
    { at: '2026-11-17T15:12:00.000Z', by: 'Sample Requester', what: 'submitted it' },
    { at: '2026-11-17T14:58:00.000Z', by: 'Sample Requester', what: 'started it' },
  ],
  can: { edit: false, submit: false, cancel: false, approve: true, sendBack: true, reject: true, approveBlocked: null },
  settings: SETTINGS,
  ...over,
});
const CHOICES: RequisitionChoices = {
  items: [
    { id: 'item-filter', code: 'FLT-20251', name: 'Filter 20x25x1', unit: 'each', companyTenantId: 'tenant-thmp', onHand: 0, reorderLevel: 18, reorderQuantity: 36, averageCostCents: 390 },
    { id: 'item-battery', code: 'BAT-9V', name: 'Battery, 9 V', unit: 'each', companyTenantId: 'tenant-thmp', onHand: 5, reorderLevel: 12, reorderQuantity: 24, averageCostCents: 185 },
    { id: 'item-alarm', code: 'SMK-10', name: 'Smoke alarm', unit: 'each', companyTenantId: 'tenant-thmp', onHand: 40, reorderLevel: 6, reorderQuantity: 12, averageCostCents: 1530 },
    { id: 'item-glue', code: 'PST-GLUE', name: 'Glue boards', unit: 'pack', companyTenantId: 'tenant-pest', onHand: 0, reorderLevel: 8, reorderQuantity: 12, averageCostCents: 910 },
  ],
  places: [{ id: 'place-stockroom', name: 'Stockroom' }],
  companies: [{ tenantId: 'tenant-thmp', name: 'THMP' }, { tenantId: 'tenant-pest', name: 'Crystal Creek Pest' }],
  vendors: [{ id: 'vendor-hill', name: 'Hill Country Supply' }],
  settings: SETTINGS,
};

let edits: Record<string, ReturnType<typeof mutation>>;
const list = (requisitions: RequisitionRow[], seesAll = true): RequisitionList => ({ requisitions, settings: SETTINGS, seesAll });

beforeEach(() => {
  url.state = { show: 'open', status: 'all', q: '' };
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
    expect(within(table).getByRole('row', { name: /PR-0011/ }).textContent).toContain('To be ordered');
    expect(within(table).getByRole('row', { name: /PR-0010/ }).textContent).toContain('Sent back: “Which model? Add a quote.”');
    expect(screen.getByText('Waiting for approval', { selector: ':not(span)' }).parentElement?.textContent).toContain('2');
    expect(hooks.useRequisitions).toHaveBeenCalledWith('open');
  });

  it('narrows by a search from the rows in hand, and says whose requisitions these are', () => {
    url.state = { show: 'open', status: 'all', q: 'pr-0011' };
    mount(list([row(), row({ id: 'req-11', number: 'PR-0011', summary: 'Smoke alarm × 40' })], false));

    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText('Your purchase requisitions.')).toBeTruthy();
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
          { itemId: 'item-filter', description: null, quantity: 36, estimatedUnitCostCents: 390 },
          { itemId: 'item-battery', description: null, quantity: 24, estimatedUnitCostCents: 185 },
        ],
        quotes: [],
      },
      true,
    );
  });

  it('says who approves, and asks for quotes once it is above the limit', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Ask for something not in the list' }));
    fireEvent.change(screen.getByLabelText('What is asked for on line 1'), { target: { value: 'Smoke alarm, 10-year' } });
    fireEvent.change(screen.getByLabelText('Quantity of Smoke alarm, 10-year'), { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText('Estimated cost of one Smoke alarm, 10-year'), { target: { value: '15.30' } });
    fireEvent.change(screen.getByLabelText('Why it is needed'), { target: { value: 'Replacing expired alarms.' } });

    expect(screen.getByText('Somebody who may approve any amount')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Above the approval limit, 2 quotes are needed.');
    expect(submit().disabled).toBe(true);
  });

  it('saves a draft with a row unfinished nowhere, and never while one is', async () => {
    const onSave = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Ask for something not in the list' }));
    const draft = screen.getByRole('button', { name: 'Save as a draft' }) as HTMLButtonElement;
    expect(draft.disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Finish or remove the rows that are not filled in.');

    fireEvent.click(screen.getByRole('button', { name: 'Remove line 1' }));
    expect(draft.disabled).toBe(false);
    fireEvent.click(draft);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ lines: [], reason: '' }), false));
  });

  it('opens a sent-back requisition with what it asked for', () => {
    mount(detail({ status: 'SENT_BACK', can: { edit: true, submit: true, cancel: true, approve: false, sendBack: false, reject: false, approveBlocked: null } }));

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
    mount(detail({ can: { edit: false, submit: false, cancel: false, approve: false, sendBack: true, reject: true, approveBlocked: 'It is above the $500.00 approval limit, so it needs somebody who may approve any amount.' } }));

    expect(screen.getByText(/above the \$500\.00 approval limit/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send back with the note' })).toBeTruthy();
  });

  it('shows its author a submitted requisition as it stands, with only Cancel to press', async () => {
    mount(detail({ can: { edit: false, submit: false, cancel: true, approve: false, sendBack: false, reject: false, approveBlocked: null } }));

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
        can: { edit: true, submit: true, cancel: true, approve: false, sendBack: false, reject: false, approveBlocked: null },
      }),
    );

    expect(screen.getByText(/Sample Manager sent it back: “Fewer batteries\.”/)).toBeTruthy();
    expect(screen.getByLabelText('Why it is needed')).toBeTruthy();
    expect(hooks.useRequisitionChoices).toHaveBeenCalledWith(true);
  });
});
