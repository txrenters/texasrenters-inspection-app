import type { PurchaseOrderDetail, VendorBillView } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BillSection, ReceivingSection, aheadOfTexas } from './order-receiving';

/** Receiving and the vendor's bill, phase 4 (2026-11-19). Every item, person, vendor and price invented. */

const mutation = () => ({ mutateAsync: vi.fn(async () => ({})), isPending: false, error: null, reset: vi.fn() });
const hooks = vi.hoisted(() => ({ usePurchaseReceivingEdits: vi.fn(), useRequisitionChoices: vi.fn() }));
vi.mock('@/lib/purchasing-queries', () => hooks);

const NOTHING = { edit: false, submit: false, approve: false, sendBack: false, send: false, cancel: false, receive: false, reverseReceipt: false, bill: false, approveBill: false, overrideBill: false, pay: false, closeShort: false, approveBlocked: null };
const order = (over: Partial<PurchaseOrderDetail> = {}): PurchaseOrderDetail => ({
  id: 'order-9',
  number: 'PO-0009',
  status: 'PARTLY_RECEIVED',
  vendor: { id: 'vendor-hill', name: 'Hill Country Supply' },
  requisition: { id: 'req-12', number: 'PR-0012' },
  company: null,
  expectedOn: '2026-11-24',
  lineCount: 2,
  totalCents: 20005,
  madeBy: { id: 'user-buyer', name: 'Sample Purchaser' },
  createdAt: '2026-11-18T16:02:00.000Z',
  sentAt: '2026-11-18T16:40:00.000Z',
  vendorContact: null,
  deliverTo: { id: 'place-stockroom', name: 'Stockroom' },
  terms: 'Net 30',
  taxBasisPoints: 825,
  notes: null,
  lines: [
    { id: 'ol-1', item: { id: 'item-filter', code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each' }, quantity: 36, unitPriceCents: 390, requestedQuantity: 36, receivedQuantity: 36 },
    { id: 'ol-2', item: { id: 'item-battery', code: 'PRT-0001', name: 'Battery, 9 V', unit: 'each' }, quantity: 24, unitPriceCents: 185, requestedQuantity: 24, receivedQuantity: 0 },
  ],
  subtotalCents: 18480,
  taxCents: 1525,
  approvedBy: 'Sample Owner',
  approvedAt: '2026-11-18T16:30:00.000Z',
  decisionNote: null,
  cancelReason: null,
  from: { name: 'Example Company', addressLine1: null, addressLine2: null, phone: null, email: null },
  vendorFiles: [],
  deliveries: [],
  receipts: [
    { id: 'rcv-8', number: 'RCV-0008', receivedOn: '2026-11-20', packingSlip: 'PS-44817', note: null, by: 'Sample Stock Keeper', at: '2026-11-20T15:00:00.000Z', reversed: null, lines: [{ itemCode: 'FLT-0003', itemName: 'Filter 20x25x1', placeName: 'Stockroom', quantity: 36 }] },
  ],
  bill: null,
  shortCloseReason: null,
  history: [],
  can: NOTHING,
  approvalLimitCents: 50000,
  ...over,
});
const bill = (over: Partial<VendorBillView> = {}): VendorBillView => ({
  billNumber: 'INV-20931',
  billDate: '2026-11-24',
  totalCents: 20005,
  status: 'HELD',
  lines: [{ orderLineId: 'ol-1', quantity: 36, unitPriceCents: 390 }, { orderLineId: 'ol-2', quantity: 24, unitPriceCents: 185 }],
  problems: ['Battery, 9 V: billed for 24, and 20 have arrived.'],
  enteredBy: 'Sample Accounts',
  approvedBy: null,
  approvedAt: null,
  overrideReason: null,
  paidOn: null,
  method: null,
  reference: null,
  paidBy: null,
  ...over,
});

let edits: Record<string, ReturnType<typeof mutation>>;
// The days typed below are late November: the forms refuse a day that has not come yet in Texas, so the clock is put after them.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-30T18:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

beforeEach(() => {
  edits = Object.fromEntries(['receive', 'reverseReceipt', 'closeShort', 'saveBill', 'approveBill', 'approveBillAnyway', 'payBill'].map((name) => [name, mutation()]));
  hooks.usePurchaseReceivingEdits.mockReturnValue(edits);
  hooks.useRequisitionChoices.mockReturnValue({ data: { places: [{ id: 'place-stockroom', name: 'Stockroom' }, { id: 'place-van', name: 'Van 1' }] } });
});

describe('what has arrived', () => {
  it('lists each receipt, and offers nothing to somebody who may only look', () => {
    render(<ReceivingSection data={order()} />);

    const receipts = screen.getByRole('list', { name: 'Receipts, newest first' });
    expect(within(receipts).getByText('RCV-0008')).toBeTruthy();
    expect(within(receipts).getByText('36 × Filter 20x25x1, into Stockroom')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(hooks.useRequisitionChoices).not.toHaveBeenCalled();
  });

  it('receives what is still to come, into the order\'s place, with one key for the receipt', async () => {
    render(<ReceivingSection data={order({ can: { ...NOTHING, receive: true } })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Receive goods' }));

    const dialog = screen.getByRole('dialog', { name: 'Receive goods' });
    expect(within(dialog).queryByLabelText('Filter 20x25x1 arrived now')).toBeNull();
    const arrived = within(dialog).getByLabelText('Battery, 9 V arrived now') as HTMLInputElement;
    expect(arrived.value).toBe('24');
    const post = within(dialog).getByRole('button', { name: 'Post receipt' }) as HTMLButtonElement;

    fireEvent.change(arrived, { target: { value: '25' } });
    expect(within(dialog).getByText('Only 24 still to come.')).toBeTruthy();
    expect(post.disabled).toBe(true);

    fireEvent.change(arrived, { target: { value: '20' } });
    expect(within(dialog).getByText('4 fewer than ordered. The order stays open for them.')).toBeTruthy();
    expect(within(dialog).getByRole('status').textContent).toBe('Posting adds 20 units to stock.');
    fireEvent.change(within(dialog).getByLabelText('Packing slip no.'), { target: { value: ' PS-44901 ' } });
    fireEvent.click(post);

    await waitFor(() => expect(edits.receive!.mutateAsync).toHaveBeenCalledTimes(1));
    expect(edits.receive!.mutateAsync).toHaveBeenCalledWith({
      orderId: 'order-9',
      input: { packingSlip: 'PS-44901', requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/), lines: [{ orderLineId: 'ol-2', placeId: 'place-stockroom', quantity: 20 }] },
    });
  });

  it('reverses a receipt only with a reason', async () => {
    render(<ReceivingSection data={order({ can: { ...NOTHING, reverseReceipt: true } })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reverse RCV-0008' }));

    const dialog = screen.getByRole('dialog', { name: 'Reverse RCV-0008?' });
    const confirm = within(dialog).getByRole('button', { name: 'Reverse receipt' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Why'), { target: { value: ' Wrong order. ' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(edits.reverseReceipt!.mutateAsync).toHaveBeenCalledWith({ receiptId: 'rcv-8', input: { reason: 'Wrong order.' } }));
  });

  it('marks a reversed receipt, and finishes an order short with a reason', async () => {
    const reversed = { ...order().receipts[0]!, reversed: { by: 'Sample Stock Keeper', at: '2026-11-21T15:00:00.000Z', reason: 'Wrong order.' } };
    render(<ReceivingSection data={order({ receipts: [reversed], can: { ...NOTHING, reverseReceipt: true, closeShort: true } })} />);

    expect(screen.getByText('Reversed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reverse RCV-0008' })).toBeNull();
    expect(screen.getByText('24 still to come.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'The rest will not arrive' }));
    const dialog = screen.getByRole('dialog', { name: 'The rest will not arrive?' });
    fireEvent.change(within(dialog).getByLabelText('Why the rest will not arrive'), { target: { value: 'Discontinued.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish the order' }));
    await waitFor(() => expect(edits.closeShort!.mutateAsync).toHaveBeenCalledWith({ orderId: 'order-9', input: { reason: 'Discontinued.' } }));
  });
});

describe('the vendor\'s bill', () => {
  it('starts from what arrived at the order\'s prices, and saves what the paper says', async () => {
    render(<BillSection data={order({ can: { ...NOTHING, bill: true } })} />);
    expect(screen.getByText(/No bill entered yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Enter the bill' }));

    const dialog = screen.getByRole('dialog', { name: "Enter the vendor's bill" });
    expect((within(dialog).getByLabelText('Filter 20x25x1 billed') as HTMLInputElement).value).toBe('36');
    expect((within(dialog).getByLabelText('Battery, 9 V billed') as HTMLInputElement).value).toBe('0');
    expect((within(dialog).getByLabelText('Billed price of one Filter 20x25x1') as HTMLInputElement).value).toBe('3.90');
    const save = within(dialog).getByRole('button', { name: 'Save the bill' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText('Bill no.'), { target: { value: 'INV-20931' } });
    fireEvent.change(within(dialog).getByLabelText('Bill date'), { target: { value: '2026-11-24' } });
    fireEvent.change(within(dialog).getByLabelText('Bill total'), { target: { value: '200.05' } });
    fireEvent.change(within(dialog).getByLabelText('Battery, 9 V billed'), { target: { value: '24' } });
    fireEvent.click(save);

    await waitFor(() =>
      expect(edits.saveBill!.mutateAsync).toHaveBeenCalledWith({
        orderId: 'order-9',
        input: { billNumber: 'INV-20931', billDate: '2026-11-24', totalCents: 20005, lines: [{ orderLineId: 'ol-1', quantity: 36, unitPriceCents: 390 }, { orderLineId: 'ol-2', quantity: 24, unitPriceCents: 185 }] },
      }),
    );
  });

  it('says why a bill is held, and offers no approval to whoever keeps the bills', () => {
    render(<BillSection data={order({ bill: bill(), can: { ...NOTHING, bill: true } })} />);

    expect(screen.getByText('Held: does not match')).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Why the bill is held' })).getByText('Battery, 9 V: billed for 24, and 20 have arrived.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve bill for payment' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve anyway' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Change the bill' })).toBeTruthy();
  });

  it('lets somebody who may approve any amount approve it anyway, only with a reason', async () => {
    render(<BillSection data={order({ bill: bill(), can: { ...NOTHING, overrideBill: true } })} />);
    const anyway = screen.getByRole('button', { name: 'Approve anyway' }) as HTMLButtonElement;
    expect(anyway.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Reason to approve it although it does not match'), { target: { value: ' Vendor will credit the 4. ' } });
    fireEvent.click(anyway);
    await waitFor(() => expect(edits.approveBillAnyway!.mutateAsync).toHaveBeenCalledWith({ orderId: 'order-9', input: { reason: 'Vendor will credit the 4.' } }));
  });

  it('approves a bill that matches, then records how it was paid', async () => {
    const matched = render(<BillSection data={order({ bill: bill({ status: 'MATCHED', problems: [] }), can: { ...NOTHING, approveBill: true } })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve bill for payment' }));
    await waitFor(() => expect(edits.approveBill!.mutateAsync).toHaveBeenCalledWith('order-9'));
    matched.unmount();

    render(<BillSection data={order({ bill: bill({ status: 'APPROVED', problems: [], approvedBy: 'Sample Accounts' }), can: { ...NOTHING, pay: true } })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    const dialog = screen.getByRole('dialog', { name: 'Record payment' });
    expect(within(dialog).getByText(/No money moves in the console/)).toBeTruthy();
    const record = within(dialog).getByRole('button', { name: 'Record payment' }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Day it was paid'), { target: { value: '2026-11-25' } });
    fireEvent.change(within(dialog).getByLabelText('Reference'), { target: { value: 'Check 1042' } });
    fireEvent.click(record);
    await waitFor(() => expect(edits.payBill!.mutateAsync).toHaveBeenCalledWith({ orderId: 'order-9', input: { paidOn: '2026-11-25', method: 'CHECK', reference: 'Check 1042' } }));
  });

  it('shows a paid bill with how it was paid and why it was approved without matching', () => {
    render(<BillSection data={order({ status: 'CLOSED', bill: bill({ status: 'PAID', problems: ['Battery, 9 V: billed for 24, and 20 have arrived.'], approvedBy: 'Sample Owner', overrideReason: 'Vendor will credit the 4.', paidOn: '2026-11-25', method: 'CHECK', reference: 'Check 1042', paidBy: 'Sample Accounts' }) })} />);

    expect(screen.getByText('Paid', { selector: '[data-slot=badge]' })).toBeTruthy();
    expect(screen.getByText('Vendor will credit the 4.')).toBeTruthy();
    expect(screen.getByText(/check$/)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Why the bill is held' })).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('a day that has not come yet in Texas (2026-11-19)', () => {
  it('is refused with the Texas day named, and today or before is not', () => {
    // 00:55 on December 1 in Manila is still November 30 in Texas.
    vi.setSystemTime(new Date('2026-11-30T16:55:00.000Z'));
    expect(aheadOfTexas('2026-12-01')).toMatch(/^That day has not come yet in Texas\. It is .*30.* there\.$/);
    expect(aheadOfTexas('2026-11-30')).toBeNull();
    expect(aheadOfTexas('2026-11-02')).toBeNull();
    expect(aheadOfTexas('')).toBeNull();
  });
});
