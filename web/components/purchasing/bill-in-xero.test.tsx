import type { PurchaseOrderDetail, VendorBillInXero, XeroBillSettingsView } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { XeroBillsPanel } from '@/components/xero/xero-bills-panel';

import { BillInXeroSection } from './bill-in-xero';

/** Vendor bills to Xero, phase 7 (2026-11-19). Every company, account and person invented. */

const hooks = vi.hoisted(() => ({ useBillInXero: vi.fn(), useBillInXeroActions: vi.fn(), useXeroBillSettings: vi.fn(), useSaveXeroBillSettings: vi.fn() }));
vi.mock('@/lib/vendor-bills-xero-queries', () => hooks);

const order = (status: string | null) => ({ id: 'order-9', bill: status ? { status } : null }) as unknown as PurchaseOrderDetail;
const standing = (over: Partial<VendorBillInXero> = {}): VendorBillInXero => ({
  company: { tenantId: 'tenant-homes', name: 'Example Home Services LLC' },
  status: 'NOT_SENT',
  url: null,
  problem: null,
  sentBy: null,
  sentAt: null,
  payment: { status: 'NOT_SENT', problem: null, sentBy: null, sentAt: null },
  waitsOn: null,
  paymentWaitsOn: null,
  can: { send: true, sendPayment: false },
  ...over,
});
const inXero = (over: Partial<VendorBillInXero> = {}) =>
  standing({ status: 'SENT', url: 'https://go.xero.com/AccountsPayable/Edit.aspx?InvoiceID=x1', sentBy: 'Sample Accounts', sentAt: '2026-11-19T16:00:00.000Z', can: { send: false, sendPayment: true }, ...over });
const mutation = () => ({ mutate: vi.fn(), isPending: false, isSuccess: false, error: null as Error | null });
let send: ReturnType<typeof mutation>;
let sendPayment: ReturnType<typeof mutation>;
const show = (view: VendorBillInXero) => hooks.useBillInXero.mockReturnValue({ isError: false, data: view });
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

beforeEach(() => {
  send = mutation();
  sendPayment = mutation();
  hooks.useBillInXero.mockReset();
  hooks.useBillInXeroActions.mockReturnValue({ send, sendPayment });
  show(standing());
});

describe('the bill in Xero', () => {
  it('is not shown, and not read, until the bill is approved', () => {
    hooks.useBillInXero.mockReturnValue({ isError: false, data: undefined });
    const { container, rerender } = render(<BillInXeroSection data={order(null)} />);
    expect(container.textContent).toBe('');
    rerender(<BillInXeroSection data={order('MATCHED')} />);
    expect(container.textContent).toBe('');
    expect(hooks.useBillInXero.mock.calls.every((call) => call[1] === false)).toBe(true);
  });

  it('sends an approved bill once somebody presses, and says what will happen', () => {
    render(<BillInXeroSection data={order('APPROVED')} />);
    expect(hooks.useBillInXero).toHaveBeenCalledWith('order-9', true);
    expect(screen.getByText('Example Home Services LLC')).toBeTruthy();
    expect(screen.getByText('Not sent')).toBeTruthy();
    expect(screen.getByText(/It goes once, as a draft bill/)).toBeTruthy();
    // Nothing went by opening the page.
    expect(send.mutate).not.toHaveBeenCalled();
    fireEvent.click(button('Send to Xero'));
    expect(send.mutate).toHaveBeenCalledTimes(1);
  });

  it('says what it waits on, with no button, when it cannot go yet', () => {
    show(standing({ waitsOn: "Choose the account Example Home Services LLC's bills are booked to, on the Xero page.", can: { send: false, sendPayment: false } }));
    render(<BillInXeroSection data={order('APPROVED')} />);
    expect(screen.getByText(/Choose the account Example Home Services LLC's bills are booked to/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows what Xero objected to, and offers another try', () => {
    show(standing({ status: 'FAILED', problem: 'Xero refused it: Account code 500 is not a valid code for this document.' }));
    render(<BillInXeroSection data={order('APPROVED')} />);
    expect(screen.getByText(/Account code 500 is not a valid code/)).toBeTruthy();
    fireEvent.click(button('Try again'));
    expect(send.mutate).toHaveBeenCalledTimes(1);
  });

  it('shows nothing to press to somebody who does not keep the bills', () => {
    show(standing({ can: { send: false, sendPayment: false } }));
    render(<BillInXeroSection data={order('APPROVED')} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Not sent')).toBeTruthy();
  });

  it('opens the bill in Xero once it is there, with who sent it', () => {
    show(inXero({ can: { send: false, sendPayment: false } }));
    render(<BillInXeroSection data={order('APPROVED')} />);
    expect(screen.getByRole('link', { name: /Open in Xero/ }).getAttribute('href')).toContain('AccountsPayable');
    expect(screen.getByText('In Xero')).toBeTruthy();
    expect(screen.getByText(/Sample Accounts,/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Send/ })).toBeNull();
  });
});

describe('the payment', () => {
  it('is sent by a second press, once the bill is paid here', () => {
    show(inXero());
    render(<BillInXeroSection data={order('PAID')} />);
    expect(screen.getByText(/Xero takes no payment on a draft/)).toBeTruthy();
    fireEvent.click(button('Send the payment to Xero'));
    expect(sendPayment.mutate).toHaveBeenCalledTimes(1);
    expect(send.mutate).not.toHaveBeenCalled();
  });

  it('says what it waits on, and what Xero answered last time', () => {
    show(inXero({ paymentWaitsOn: 'Record the payment here first.', can: { send: false, sendPayment: false } }));
    const { unmount } = render(<BillInXeroSection data={order('APPROVED')} />);
    expect(screen.getByText('Record the payment here first.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /payment/ })).toBeNull();
    unmount();

    show(inXero({ payment: { status: 'FAILED', problem: 'The bill is still a draft in Xero. Approve it there first: Xero takes no payment on a draft.', sentBy: null, sentAt: null } }));
    render(<BillInXeroSection data={order('PAID')} />);
    expect(screen.getByText(/The bill is still a draft in Xero/)).toBeTruthy();
    fireEvent.click(button('Try the payment again'));
    expect(sendPayment.mutate).toHaveBeenCalledTimes(1);
  });

  it('has nothing left to press once both are in Xero', () => {
    show(inXero({ payment: { status: 'SENT', problem: null, sentBy: 'Sample Accounts', sentAt: '2026-11-25T16:00:00.000Z' }, can: { send: false, sendPayment: false } }));
    render(<BillInXeroSection data={order('PAID')} />);
    expect(screen.getByText('Recorded in Xero')).toBeTruthy();
    expect(screen.getByText(/The bill and its payment are in Xero/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Send|Try/ })).toBeNull();
  });
});

describe('a company\'s choices for its bills', () => {
  const view = (over: Partial<XeroBillSettingsView['settings']> = {}): XeroBillSettingsView => ({
    tenantId: 'tenant-homes',
    settings: { purchasesAccountId: null, paymentAccounts: {}, ...over },
    purchaseAccounts: [
      { accountId: 'acct-purchases', code: '500', name: 'Purchases' },
      { accountId: 'acct-inventory', code: '630', name: 'Inventory' },
    ],
    bankAccounts: [{ accountId: 'acct-checking', code: null, name: 'Business Checking' }],
  });
  let save: ReturnType<typeof mutation>;
  const pick = (label: string, option: string) => {
    fireEvent.keyDown(screen.getByLabelText(label), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: option }));
  };
  beforeEach(() => {
    save = mutation();
    hooks.useSaveXeroBillSettings.mockReturnValue(save);
    hooks.useXeroBillSettings.mockReturnValue({ isError: false, data: view() });
  });

  it('saves the account bills are booked to and the account each way of paying comes out of', () => {
    render(<XeroBillsPanel canManage canRead tenantId="tenant-homes" />);
    const form = screen.getByRole('form', { name: 'Vendor bills' });
    expect(within(form).getByText(/Nothing is sent by choosing here/)).toBeTruthy();
    expect(button('Save').disabled).toBe(true);

    // A bank account is not somewhere a bill is booked.
    fireEvent.keyDown(screen.getByLabelText('Account bills are booked to'), { key: 'ArrowDown' });
    expect(screen.queryByRole('option', { name: 'Business Checking' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: '630 Inventory' }));
    pick('Check', 'Business Checking');
    fireEvent.click(button('Save'));
    expect(save.mutate).toHaveBeenCalledWith({ purchasesAccountId: 'acct-inventory', paymentAccounts: { CHECK: 'acct-checking' } });
  });

  it('clears a choice, and leaves the form read-only for somebody who may not change it', () => {
    hooks.useXeroBillSettings.mockReturnValue({ isError: false, data: view({ purchasesAccountId: 'acct-purchases', paymentAccounts: { CHECK: 'acct-checking' } }) });
    const { unmount } = render(<XeroBillsPanel canManage canRead tenantId="tenant-homes" />);
    pick('Check', 'Not chosen');
    fireEvent.click(button('Save'));
    expect(save.mutate).toHaveBeenCalledWith({ purchasesAccountId: 'acct-purchases', paymentAccounts: {} });
    unmount();

    render(<XeroBillsPanel canManage={false} canRead tenantId="tenant-homes" />);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect((screen.getByLabelText('Account bills are booked to') as HTMLButtonElement).disabled).toBe(true);
  });

  it('is not shown, and not read, to somebody who may not see the Xero page\'s settings', () => {
    const { container } = render(<XeroBillsPanel canManage={false} canRead={false} tenantId="tenant-homes" />);
    expect(container.textContent).toBe('');
    expect(hooks.useXeroBillSettings).toHaveBeenLastCalledWith('tenant-homes', false);
  });
});
