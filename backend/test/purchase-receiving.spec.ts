import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import {
  MACHINE_FORBIDDEN_PERMISSIONS,
  type ApproveVendorBillInput,
  type CloseShortInput,
  type PayVendorBillInput,
  type ReceiveGoodsInput,
  type ReverseReceiptInput,
  type SaveVendorBillInput,
} from '@texasrenters/shared';

import { PurchaseOrdersService } from '../src/admin/purchase-orders.service';
import { ApproveVendorBillAnywayDto, CloseShortDto, PayVendorBillDto, PurchaseReceivingController, ReceiveGoodsDto, ReverseReceiptDto, SaveVendorBillDto } from '../src/admin/purchase-receiving.controller';
import { PurchaseReceivingService } from '../src/admin/purchase-receiving.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Receiving and the vendor's bill, phase 4 (2026-11-19). Every id, name, code
 * and price here is invented. The database below keeps the order's lines,
 * receipts, stock movements and bill the way the services read and write
 * them, and adds stock up from the movements as the real one's trigger does.
 * What only the real database does (refusing more received than ordered, a
 * mismatch approved by whoever entered the bill, a payment on a bill not
 * paid) is in the migration and is not exercised here.
 */

const ORG = 'a0000000-0000-4000-8000-000000000001';
const OTHER_ORG = 'a0000000-0000-4000-8000-000000000002';
const id = (n: number) => `a0000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`;
const FILTER = id(1);
const BATTERY = id(2);
const STOCKROOM = id(11);
const VAN = id(12);
const SHED = id(13);
const REQUISITION = id(31);
const ORDER = id(41);
const DRAFT_ORDER = id(42);
const FILTER_LINE = id(51);
const BATTERY_LINE = id(52);
const key = (n: number) => id(900 + n);

const person = (n: number, displayName: string, permissions: string[], organizationId = ORG): AuthenticatedUser =>
  ({ id: id(800 + n), authUserId: `auth-${n}`, organizationId, displayName, roles: [UserRole.INSPECTION_SUPERVISOR], permissions, mustChangePassword: false, principalType: 'USER' }) as AuthenticatedUser;
const buyer = person(1, 'Sample Purchaser', ['purchasing:request', 'purchasing:order']);
const keeper = person(2, 'Sample Stock Keeper', ['purchasing:request', 'purchasing:receive']);
const clerk = person(3, 'Sample Accounts', ['purchasing:request', 'purchasing:bills']);
const owner = person(4, 'Sample Owner', ['purchasing:request', 'purchasing:approve', 'purchasing:approve-any']);
/** Keeps the bills and may approve any amount: still never approves a mismatch on a bill they entered. */
const boss = person(5, 'Sample Boss', ['purchasing:request', 'purchasing:bills', 'purchasing:approve', 'purchasing:approve-any']);
const outsider = person(6, 'Other Office', ['purchasing:request', 'purchasing:receive', 'purchasing:bills', 'purchasing:approve', 'purchasing:approve-any', 'purchasing:order'], OTHER_ORG);
const PEOPLE = [buyer, keeper, clerk, owner, boss, outsider];

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([field, value]) => {
    if (value === undefined) return true;
    if (field === 'AND') return (value as Where[]).every((part) => matches(row, part));
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      const rule = value as { in?: unknown[]; notIn?: unknown[]; lte?: number; gte?: number };
      if (rule.in) return rule.in.includes(row[field]);
      if (rule.notIn) return !rule.notIn.includes(row[field]);
      if (rule.lte !== undefined) return (row[field] as number) <= rule.lte;
      if (rule.gte !== undefined) return (row[field] as number) >= rule.gte;
      return true;
    }
    return (row[field] ?? null) === value;
  });
}

function database() {
  const items: Row[] = [
    { id: FILTER, code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each' },
    { id: BATTERY, code: 'PRT-0001', name: 'Battery, 9 V', unit: 'each' },
  ];
  const places: Row[] = [
    { id: STOCKROOM, organizationId: ORG, name: 'Stockroom', active: true },
    { id: VAN, organizationId: ORG, name: 'Van 1', active: true },
    { id: SHED, organizationId: ORG, name: 'Old shed', active: false },
  ];
  const requisitions: Row[] = [{ id: REQUISITION, organizationId: ORG, number: 'PR-0012', status: 'ORDERED', requestedById: id(899) }];
  const base = { organizationId: ORG, requisitionId: REQUISITION, vendorId: id(21), xeroTenantId: null, deliverToPlaceId: STOCKROOM, expectedOn: null, terms: 'Net 30', taxBasisPoints: 825, notes: null, createdById: buyer.id, decisionNote: null, cancelReason: null, shortClosedAt: null, shortCloseReason: null };
  const orders: Row[] = [
    { ...base, id: ORDER, number: 'PO-0009', status: 'SENT', approvedById: owner.id, approvedAt: new Date('2026-11-18T16:00:00.000Z'), sentAt: new Date('2026-11-18T16:40:00.000Z'), createdAt: new Date('2026-11-18T15:00:00.000Z') },
    { ...base, id: DRAFT_ORDER, number: null, status: 'DRAFT', approvedById: null, approvedAt: null, sentAt: null, createdAt: new Date('2026-11-18T15:30:00.000Z') },
  ];
  const orderLines: Row[] = [
    { id: FILTER_LINE, organizationId: ORG, orderId: ORDER, position: 0, itemId: FILTER, quantity: 36, unitPriceCents: 390, receivedQuantity: 0 },
    { id: BATTERY_LINE, organizationId: ORG, orderId: ORDER, position: 1, itemId: BATTERY, quantity: 24, unitPriceCents: 185, receivedQuantity: 0 },
    { id: id(53), organizationId: ORG, orderId: DRAFT_ORDER, position: 0, itemId: FILTER, quantity: 5, unitPriceCents: 390, receivedQuantity: 0 },
  ];
  const receipts: Row[] = [];
  const receiptLines: Row[] = [];
  const movements: Row[] = [];
  const bills: Row[] = [];
  const billLines: Row[] = [];
  const audits: Row[] = [];
  let series = 0;
  let clock = Date.parse('2026-11-19T15:00:00.000Z');

  const nameOf = (personId: unknown) => (personId ? { displayName: PEOPLE.find((one) => one.id === personId)!.displayName } : null);
  const item = (itemId: unknown) => items.find((one) => one.id === itemId)!;
  const place = (placeId: unknown) => places.find((one) => one.id === placeId)!;
  const billOf = (orderId: unknown) => {
    const bill = bills.find((one) => one.orderId === orderId);
    return bill ? { ...bill, enteredBy: nameOf(bill.enteredById), approvedBy: nameOf(bill.approvedById), paidBy: nameOf(bill.paidById), lines: billLines.filter((line) => line.billId === bill.id) } : null;
  };
  const wholeOrder = (order: Row) => ({
    ...order,
    createdBy: nameOf(order.createdById),
    approvedBy: nameOf(order.approvedById),
    vendor: { id: id(21), name: 'Hill Country Supply', contactName: null, email: 'orders@hill.example', phone: null },
    deliverTo: { id: STOCKROOM, name: 'Stockroom' },
    requisition: { id: REQUISITION, number: 'PR-0012', requestedById: id(899), lines: [{ itemId: FILTER, quantity: 36 }, { itemId: BATTERY, quantity: 24 }] },
    lines: orderLines
      .filter((line) => line.orderId === order.id)
      .sort((left, right) => (left.position as number) - (right.position as number))
      .map((line) => ({ ...line, item: item(line.itemId) })),
    bill: billOf(order.id),
  });
  const wholeReceipt = (receipt: Row) => ({
    ...receipt,
    order: wholeOrder(orders.find((order) => order.id === receipt.orderId)!),
    lines: receiptLines.filter((line) => line.receiptId === receipt.id).map((line) => ({ ...line, item: item(line.itemId), place: place(line.placeId), movement: movements.find((movement) => movement.id === line.movementId) })),
  });
  const updateMany = (rows: Row[]) =>
    jest.fn(async ({ where, data }: { where: Where; data: Row }) => {
      const found = rows.filter((row) => matches(row, where));
      for (const row of found)
        for (const [field, value] of Object.entries(data)) {
          const change = value as { increment?: number; decrement?: number } | null;
          if (change && typeof change === 'object' && !(change instanceof Date) && (change.increment !== undefined || change.decrement !== undefined))
            row[field] = (row[field] as number) + (change.increment ?? 0) - (change.decrement ?? 0);
          else row[field] = value;
        }
      return { count: found.length };
    });

  const db = {
    purchaseOrder: {
      findMany: jest.fn(async ({ where }: { where: Where }) => orders.filter((row) => matches(row, where)).map(wholeOrder)),
      findFirst: jest.fn(async ({ where }: { where: Where }) => {
        const found = orders.find((row) => matches(row, where));
        return found ? wholeOrder(found) : null;
      }),
      updateMany: updateMany(orders),
    },
    purchaseOrderLine: { updateMany: updateMany(orderLines) },
    purchaseRequisition: { updateMany: updateMany(requisitions) },
    stockPlace: { count: jest.fn(async ({ where }: { where: Where }) => places.filter((row) => matches(row, where)).length) },
    goodsReceipt: {
      findMany: jest.fn(async ({ where }: { where: Where }) => receipts.filter((row) => matches(row, where)).map(wholeReceipt).reverse()),
      findFirst: jest.fn(async ({ where }: { where: Where }) => {
        const found = receipts.find((row) => matches(row, where));
        return found ? wholeReceipt(found) : null;
      }),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: id(100 + receipts.length), reversedAt: null, reversedById: null, reversedByName: null, reverseReason: null, createdAt: new Date((clock += 1000)), ...data };
        receipts.push(row);
        return row;
      }),
      updateMany: updateMany(receipts),
    },
    goodsReceiptLine: { create: jest.fn(async ({ data }: { data: Row }) => receiptLines.push({ id: id(200 + receiptLines.length), ...data })) },
    stockMovement: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: id(300 + movements.length), reversesId: null, ...data };
        movements.push(row);
        return row;
      }),
    },
    stockLevel: {
      findUnique: jest.fn(async ({ where }: { where: { itemId_placeId: { itemId: string; placeId: string } } }) => ({
        quantity: movements.filter((row) => row.itemId === where.itemId_placeId.itemId && row.placeId === where.itemId_placeId.placeId).reduce((sum, row) => sum + (row.quantity as number), 0),
      })),
    },
    vendorBill: {
      findFirst: jest.fn(async ({ where }: { where: Where }) => bills.find((row) => matches(row, where)) ?? null),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: id(400 + bills.length), status: 'HELD', approvedById: null, approvedAt: null, overrideReason: null, paidOn: null, paymentMethod: null, paymentReference: null, paidById: null, paidAt: null, ...data };
        bills.push(row);
        return row;
      }),
      updateMany: updateMany(bills),
    },
    vendorBillLine: {
      deleteMany: jest.fn(async ({ where }: { where: Where }) => {
        for (let index = billLines.length - 1; index >= 0; index -= 1) if (matches(billLines[index]!, where)) billLines.splice(index, 1);
      }),
      createMany: jest.fn(async ({ data }: { data: Row[] }) => billLines.push(...data)),
    },
    xeroOrganisation: { findMany: jest.fn(async () => []) },
    purchasingSettings: { findUnique: jest.fn(async () => null) },
    // No approval steps saved: the office's limit reads as two steps (Purchasing Setup, 2026-11-20).
    purchasingApprovalStep: { findMany: jest.fn(async () => []) },
    invoiceSettings: { findUnique: jest.fn(async () => null) },
    purchaseOrderDelivery: { findMany: jest.fn(async () => []) },
    // No file on any requisition here: purchase-orders.spec.ts covers files ticked for the vendor.
    purchaseRequisitionFile: { findMany: jest.fn(async () => []) },
    userProfile: { findMany: jest.fn(async () => PEOPLE.map((one) => ({ id: one.id, displayName: one.displayName }))) },
    // No yearly count is open, so stock moves (stock-counts.spec.ts covers the freeze).
    stockCount: { findFirst: jest.fn(async (): Promise<{ number: string } | null> => null) },
    auditLog: {
      create: jest.fn(async ({ data }: { data: Row }) => audits.push({ createdAt: new Date((clock += 1000)), ...data })),
      findMany: jest.fn(async ({ where }: { where: Where }) => audits.filter((row) => matches(row, where)).reverse()),
    },
    $queryRaw: jest.fn(async () => [{ taken: (series += 1) }]),
  };
  const transaction = { $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => work(client)) };
  const client: unknown = Object.assign(db, transaction);
  const ordersService = new PurchaseOrdersService(db as never, {} as never, {} as never);
  return { db, orders, orderLines, receipts, movements, bills, requisitions, audits, service: new PurchaseReceivingService(db as never, ordersService) };
}

const arrival = (lines: ReceiveGoodsInput['lines'], over: Partial<ReceiveGoodsInput> = {}): ReceiveGoodsInput => ({ receivedOn: '2026-11-19', packingSlip: 'PS-44817', note: null, requestKey: key(1), lines, ...over });
const filters = (quantity: number, placeId = STOCKROOM) => ({ orderLineId: FILTER_LINE, placeId, quantity });
const batteries = (quantity: number, placeId = STOCKROOM) => ({ orderLineId: BATTERY_LINE, placeId, quantity });
const everything = () => arrival([filters(36), batteries(24)]);
/** 36 filters and 24 batteries at the order's prices, with 8.25% tax: $184.80 + $15.25. */
const fullBill = (over: Partial<SaveVendorBillInput> = {}): SaveVendorBillInput => ({
  billNumber: 'INV-20931',
  billDate: '2026-11-19',
  totalCents: 20005,
  lines: [{ orderLineId: FILTER_LINE, quantity: 36, unitPriceCents: 390 }, { orderLineId: BATTERY_LINE, quantity: 24, unitPriceCents: 185 }],
  ...over,
});
const payment: PayVendorBillInput = { paidOn: '2026-11-19', method: 'CHECK', reference: 'Check 1042' };

// "Today" is the Texas day 2026-11-19 whatever the machine's clock says: only the date is held still, so nothing waits on a timer.
beforeAll(() => {
  jest.useFakeTimers({ now: new Date('2026-11-19T18:00:00.000Z'), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'performance', 'hrtime'] });
});
afterAll(() => {
  jest.useRealTimers();
});

describe('receiving goods', () => {
  it('puts what arrived into stock at the order\'s price, and counts it against the order', async () => {
    const { service, movements, orderLines, audits } = database();
    const order = await service.receive(keeper, ORDER, arrival([filters(36), batteries(20, VAN)], { note: ' One box of batteries missing. ' }));

    expect(movements).toEqual([
      expect.objectContaining({ organizationId: ORG, itemId: FILTER, placeId: STOCKROOM, kind: 'RECEIPT', quantity: 36, unitCostCents: 390, note: 'RCV-0001 on PO-0009', createdByName: 'Sample Stock Keeper' }),
      expect.objectContaining({ itemId: BATTERY, placeId: VAN, kind: 'RECEIPT', quantity: 20, unitCostCents: 185 }),
    ]);
    expect(orderLines.slice(0, 2).map((line) => line.receivedQuantity)).toEqual([36, 20]);
    expect(order).toMatchObject({ status: 'PARTLY_RECEIVED', can: { receive: true, cancel: false, closeShort: false } });
    expect(order.lines.map((line) => [line.item.code, line.quantity, line.receivedQuantity])).toEqual([['FLT-0003', 36, 36], ['PRT-0001', 24, 20]]);
    expect(order.receipts).toEqual([
      expect.objectContaining({ number: 'RCV-0001', receivedOn: '2026-11-19', packingSlip: 'PS-44817', note: 'One box of batteries missing.', by: 'Sample Stock Keeper', reversed: null, lines: [expect.objectContaining({ itemCode: 'FLT-0003', placeName: 'Stockroom', quantity: 36 }), expect.objectContaining({ itemCode: 'PRT-0001', placeName: 'Van 1', quantity: 20 })] }),
    ]);
    expect(audits).toEqual([expect.objectContaining({ action: 'GOODS_RECEIVED', actorUserId: keeper.id, entityType: 'PurchaseOrder', entityId: ORDER })]);
    expect(order.history[0]).toMatchObject({ by: 'Sample Stock Keeper', what: 'received goods: RCV-0001, 56 units' });
  });

  it('is received once the rest arrives', async () => {
    const { service } = database();
    await service.receive(keeper, ORDER, arrival([filters(36), batteries(20)]));
    const order = await service.receive(keeper, ORDER, arrival([batteries(4)], { requestKey: key(2) }));

    expect(order).toMatchObject({ status: 'RECEIVED', can: { receive: false } });
    expect(order.receipts.map((receipt) => receipt.number)).toEqual(['RCV-0002', 'RCV-0001']);
  });

  it('sent twice is posted once', async () => {
    const { service, movements, receipts } = database();
    await service.receive(keeper, ORDER, arrival([filters(10)]));
    const again = await service.receive(keeper, ORDER, arrival([filters(10)]));

    expect(receipts).toHaveLength(1);
    expect(movements).toHaveLength(1);
    expect(again.lines[0]).toMatchObject({ receivedQuantity: 10 });
  });

  it('never takes more than was ordered, and posts nothing when any line is wrong', async () => {
    const { service, movements, receipts, orderLines } = database();
    await service.receive(keeper, ORDER, arrival([filters(30)]));
    const refused = async (input: ReceiveGoodsInput, code: string, message?: string) => expect(service.receive(keeper, ORDER, { ...input, requestKey: key(2) })).rejects.toMatchObject(message ? { code, message } : { code });

    await refused(arrival([batteries(24), filters(7)]), 'RECEIPT_MORE_THAN_ORDERED', 'Only 6 of FLT-0003 are still to come.');
    await refused(arrival([{ orderLineId: id(53), placeId: STOCKROOM, quantity: 1 }]), 'RECEIPT_LINE_NOT_ON_ORDER');
    await refused(arrival([batteries(1, SHED)]), 'STOCK_PLACE_NOT_FOUND');
    await refused(arrival([batteries(1), batteries(2)]), 'RECEIPT_LINE_TWICE');
    await refused(arrival([batteries(1)], { receivedOn: '2999-01-01' }), 'RECEIPT_DAY_AHEAD');
    await refused(arrival([]), 'RECEIPT_EMPTY');
    expect(receipts).toHaveLength(1);
    expect(movements).toHaveLength(1);
    expect(orderLines[1]).toMatchObject({ receivedQuantity: 0 });
  });

  it('waits for an order that is approved, and is this office\'s', async () => {
    const { service } = database();
    await expect(service.receive(keeper, DRAFT_ORDER, arrival([{ orderLineId: id(53), placeId: STOCKROOM, quantity: 1 }]))).rejects.toMatchObject({ code: 'PURCHASE_ORDER_NOT_RECEIVABLE' });
    await expect(service.receive(outsider, ORDER, everything())).rejects.toMatchObject({ code: 'PURCHASE_ORDER_NOT_FOUND' });
  });
});

describe('reversing a receipt', () => {
  it('takes its stock back out at the same cost, and the order goes back to waiting for it', async () => {
    const { service, movements, receipts, orderLines } = database();
    await service.receive(keeper, ORDER, arrival([filters(36)]));
    const order = await service.reverseReceipt(keeper, receipts[0]!.id as string, { reason: ' Wrong order. ' });

    expect(movements[1]).toMatchObject({ kind: 'REVERSAL', itemId: FILTER, placeId: STOCKROOM, quantity: -36, unitCostCents: 390, reversesId: movements[0]!.id, note: 'RCV-0001 reversed: Wrong order.' });
    expect(orderLines[0]).toMatchObject({ receivedQuantity: 0 });
    expect(order).toMatchObject({ status: 'SENT', receipts: [{ number: 'RCV-0001', reversed: { by: 'Sample Stock Keeper', reason: 'Wrong order.' } }] });
    expect(order.history[0]).toMatchObject({ what: 'reversed a receipt: RCV-0001: Wrong order.' });
  });

  it('needs a reason, happens once, and only while the stock is still there', async () => {
    const { service, receipts, movements } = database();
    await service.receive(keeper, ORDER, arrival([filters(36)]));
    const receiptId = receipts[0]!.id as string;
    await expect(service.reverseReceipt(keeper, receiptId, { reason: '  ' })).rejects.toMatchObject({ code: 'RECEIPT_REVERSAL_NEEDS_REASON' });
    await expect(service.reverseReceipt(outsider, receiptId, { reason: 'Theirs' })).rejects.toMatchObject({ code: 'RECEIPT_NOT_FOUND' });

    // Ten have left the stockroom since: the 36 cannot all be taken back out.
    movements.push({ id: id(399), itemId: FILTER, placeId: STOCKROOM, quantity: -10 });
    await expect(service.reverseReceipt(keeper, receiptId, { reason: 'Wrong order' })).rejects.toMatchObject({ code: 'STOCK_NOT_ENOUGH', message: 'Only 26 of FLT-0003 are still in Stockroom, so the 36 received cannot be taken back out.' });
    movements.pop();

    await service.reverseReceipt(keeper, receiptId, { reason: 'Wrong order' });
    await expect(service.reverseReceipt(keeper, receiptId, { reason: 'Again' })).rejects.toMatchObject({ code: 'RECEIPT_ALREADY_REVERSED' });
    expect(movements).toHaveLength(2);
  });

  it('is refused once the bill has been approved against it', async () => {
    const { service, receipts } = database();
    await service.receive(keeper, ORDER, everything());
    await service.saveBill(clerk, ORDER, fullBill());
    await service.approveBill(clerk, ORDER);

    await expect(service.reverseReceipt(keeper, receipts[0]!.id as string, { reason: 'Wrong order' })).rejects.toMatchObject({ code: 'RECEIPT_FIXED' });
  });
});

describe('the vendor\'s bill', () => {
  it('matches when it bills what was ordered, at the order\'s prices, for what arrived', async () => {
    const { service, audits } = database();
    await service.receive(keeper, ORDER, everything());
    const order = await service.saveBill(clerk, ORDER, fullBill());

    expect(order.bill).toMatchObject({ billNumber: 'INV-20931', billDate: '2026-11-19', totalCents: 20005, status: 'MATCHED', problems: [], enteredBy: 'Sample Accounts' });
    expect(order.can).toMatchObject({ bill: true, approveBill: true, overrideBill: false, pay: false });
    expect(audits.at(-1)).toMatchObject({ action: 'VENDOR_BILL_ENTERED', actorUserId: clerk.id, entityId: ORDER });
  });

  it('is held, saying why, when it bills more than arrived, another price, or another total', async () => {
    const { service } = database();
    await service.receive(keeper, ORDER, arrival([filters(36), batteries(20)]));
    const short = await service.saveBill(clerk, ORDER, fullBill());
    expect(short.bill).toMatchObject({ status: 'HELD', problems: ['Battery, 9 V: billed for 24, and 20 have arrived.'] });
    expect(short.can).toMatchObject({ approveBill: false, pay: false });

    const dearer = await service.saveBill(clerk, ORDER, fullBill({ totalCents: 21000, lines: [{ orderLineId: FILTER_LINE, quantity: 36, unitPriceCents: 400 }] }));
    expect(dearer.bill?.problems).toEqual(['Filter 20x25x1: billed at $4.00 each, ordered at $3.90.', "The bill's total is $210.00; its lines with 8.25% tax come to $155.88."]);
    expect((await service.saveBill(clerk, ORDER, fullBill({ lines: [] }))).bill?.problems).toEqual(['The bill has no lines.']);
  });

  it('is matched again by itself when the rest arrives', async () => {
    const { service, bills } = database();
    await service.receive(keeper, ORDER, arrival([filters(36), batteries(20)]));
    await service.saveBill(clerk, ORDER, fullBill());
    expect(bills[0]).toMatchObject({ status: 'HELD' });

    const order = await service.receive(keeper, ORDER, arrival([batteries(4)], { requestKey: key(2) }));
    expect(order.bill).toMatchObject({ status: 'MATCHED', problems: [] });
  });

  it('is approved by whoever keeps the bills only when it matches', async () => {
    const { service } = database();
    await service.receive(keeper, ORDER, arrival([filters(36), batteries(20)]));
    await service.saveBill(clerk, ORDER, fullBill());
    await expect(service.approveBill(clerk, ORDER)).rejects.toMatchObject({ code: 'VENDOR_BILL_HELD' });

    await service.receive(keeper, ORDER, arrival([batteries(4)], { requestKey: key(2) }));
    const order = await service.approveBill(clerk, ORDER);
    expect(order.bill).toMatchObject({ status: 'APPROVED', approvedBy: 'Sample Accounts', overrideReason: null });
    expect(order.can).toMatchObject({ bill: false, approveBill: false, pay: true });
    await expect(service.approveBill(clerk, ORDER)).rejects.toMatchObject({ code: 'VENDOR_BILL_MOVED_ON' });
    await expect(service.saveBill(clerk, ORDER, fullBill({ totalCents: 1 }))).rejects.toMatchObject({ code: 'VENDOR_BILL_FIXED' });
  });

  it('that does not match is approved only by somebody who may approve any amount, who did not enter it, with a reason', async () => {
    const { service, bills, audits } = database();
    await service.receive(keeper, ORDER, arrival([filters(36), batteries(20)]));
    await service.saveBill(boss, ORDER, fullBill());

    expect((await new PurchaseOrdersService(database().db as never, {} as never, {} as never).detail(owner, ORDER)).can.overrideBill).toBe(false);
    await expect(service.approveBillAnyway(clerk, ORDER, { reason: 'Vendor will credit it' })).rejects.toMatchObject({ code: 'VENDOR_BILL_OVERRIDE_FORBIDDEN' });
    await expect(service.approveBillAnyway(owner, ORDER, { reason: '  ' })).rejects.toMatchObject({ code: 'VENDOR_BILL_REASON_NEEDED' });
    await expect(service.approveBillAnyway(boss, ORDER, { reason: 'Vendor will credit it' })).rejects.toMatchObject({ code: 'VENDOR_BILL_OWN' });
    expect(bills[0]).toMatchObject({ status: 'HELD', approvedById: null });

    const order = await service.approveBillAnyway(owner, ORDER, { reason: ' Vendor will credit the 4 batteries. ' });
    expect(order.bill).toMatchObject({ status: 'APPROVED', approvedBy: 'Sample Owner', overrideReason: 'Vendor will credit the 4 batteries.' });
    expect(audits.at(-1)).toMatchObject({ action: 'VENDOR_BILL_APPROVED_DESPITE_MISMATCH', actorUserId: owner.id, metadata: expect.objectContaining({ note: 'Vendor will credit the 4 batteries.' }) });
    await expect(service.approveBillAnyway(owner, ORDER, { reason: 'Again' })).rejects.toMatchObject({ code: 'VENDOR_BILL_MOVED_ON' });
  });

  it('shows whoever may approve any amount the held bill somebody else entered', async () => {
    const { service } = database();
    await service.receive(keeper, ORDER, arrival([filters(36), batteries(20)]));
    const seenByClerk = await service.saveBill(clerk, ORDER, fullBill());

    expect(seenByClerk.can.overrideBill).toBe(false);
    await expect(service.approveBillAnyway(boss, ORDER, { reason: 'Vendor will credit it' })).resolves.toMatchObject({ bill: { status: 'APPROVED' } });
  });

  it('is for an order of this office, on a day not after today', async () => {
    const { service } = database();
    await expect(service.saveBill(outsider, ORDER, fullBill())).rejects.toMatchObject({ code: 'PURCHASE_ORDER_NOT_FOUND' });
    await expect(service.saveBill(clerk, DRAFT_ORDER, fullBill({ lines: [] }))).rejects.toMatchObject({ code: 'VENDOR_BILL_NOT_YET' });
    await expect(service.saveBill(clerk, ORDER, fullBill({ billDate: '2999-01-01' }))).rejects.toMatchObject({ code: 'VENDOR_BILL_DAY_AHEAD' });
    await expect(service.saveBill(clerk, ORDER, fullBill({ lines: [{ orderLineId: id(53), quantity: 1, unitPriceCents: 390 }] }))).rejects.toMatchObject({ code: 'VENDOR_BILL_LINE_NOT_ON_ORDER' });
    await expect(service.approveBill(clerk, ORDER)).rejects.toMatchObject({ code: 'VENDOR_BILL_NOT_FOUND' });
  });
});

describe('paying and closing', () => {
  it('records the payment of an approved bill, and closes an order that is received and paid', async () => {
    const { service, bills, requisitions, audits } = database();
    await service.receive(keeper, ORDER, everything());
    await service.saveBill(clerk, ORDER, fullBill());
    await expect(service.payBill(clerk, ORDER, payment)).rejects.toMatchObject({ code: 'VENDOR_BILL_NOT_APPROVED', message: 'A bill is paid once it is approved.' });
    await service.approveBill(clerk, ORDER);
    await expect(service.payBill(clerk, ORDER, { ...payment, paidOn: '2999-01-01' })).rejects.toMatchObject({ code: 'VENDOR_BILL_DAY_AHEAD' });

    const order = await service.payBill(clerk, ORDER, payment);
    expect(bills[0]).toMatchObject({ status: 'PAID', paymentMethod: 'CHECK', paymentReference: 'Check 1042', paidById: clerk.id });
    expect(order).toMatchObject({ status: 'CLOSED', bill: { status: 'PAID', paidOn: '2026-11-19', method: 'CHECK', reference: 'Check 1042', paidBy: 'Sample Accounts' } });
    expect(order.can).toMatchObject({ receive: false, bill: false, pay: false, cancel: false, send: false });
    expect(requisitions[0]).toMatchObject({ status: 'CLOSED' });
    expect(audits.slice(-2).map((audit) => audit.action)).toEqual(['VENDOR_BILL_PAID', 'PURCHASE_ORDER_CLOSED']);
    await expect(service.payBill(clerk, ORDER, payment)).rejects.toMatchObject({ code: 'VENDOR_BILL_NOT_APPROVED', message: 'This bill is already paid.' });
  });

  it('stays open when it is paid before everything has arrived, and closes when the rest does', async () => {
    const { service, requisitions } = database();
    await service.receive(keeper, ORDER, arrival([filters(36), batteries(20)]));
    await service.saveBill(clerk, ORDER, fullBill());
    await service.approveBillAnyway(owner, ORDER, { reason: 'The rest ships Monday.' });
    expect(await service.payBill(clerk, ORDER, payment)).toMatchObject({ status: 'PARTLY_RECEIVED' });
    expect(requisitions[0]).toMatchObject({ status: 'ORDERED' });

    expect(await service.receive(keeper, ORDER, arrival([batteries(4)], { requestKey: key(2) }))).toMatchObject({ status: 'CLOSED' });
    expect(requisitions[0]).toMatchObject({ status: 'CLOSED' });
  });

  it('is finished short by its purchaser when the rest will not arrive, and billed for what did', async () => {
    const { service } = database();
    await expect(service.closeShort(buyer, ORDER, { reason: 'Discontinued' })).rejects.toMatchObject({ code: 'PURCHASE_ORDER_NOT_PARTLY_RECEIVED' });
    await service.receive(keeper, ORDER, arrival([filters(36), batteries(20)]));
    await expect(service.closeShort(buyer, ORDER, { reason: ' ' })).rejects.toMatchObject({ code: 'PURCHASE_ORDER_REASON_NEEDED' });

    const short = await service.closeShort(buyer, ORDER, { reason: ' The last 4 are discontinued. ' });
    expect(short).toMatchObject({ status: 'RECEIVED', shortCloseReason: 'The last 4 are discontinued.', can: { receive: false, closeShort: false } });
    await expect(service.receive(keeper, ORDER, arrival([batteries(4)], { requestKey: key(2) }))).rejects.toMatchObject({ code: 'PURCHASE_ORDER_NOT_RECEIVABLE' });

    // 36 filters and the 20 batteries that came: $177.40 + $14.64.
    const billed = await service.saveBill(clerk, ORDER, fullBill({ totalCents: 19204, lines: [{ orderLineId: FILTER_LINE, quantity: 36, unitPriceCents: 390 }, { orderLineId: BATTERY_LINE, quantity: 20, unitPriceCents: 185 }] }));
    expect(billed.bill).toMatchObject({ status: 'MATCHED' });
    await service.approveBill(clerk, ORDER);
    expect(await service.payBill(clerk, ORDER, payment)).toMatchObject({ status: 'CLOSED' });
  });
});

describe('the requests the page sends', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (body: unknown, metatype: new () => object) => pipe.transform(body, { type: 'body', metatype });

  it('name every field of their contracts', async () => {
    const received: Required<ReceiveGoodsInput> = { receivedOn: '2026-11-19', packingSlip: 'PS-44817', note: 'One box missing.', requestKey: key(1), lines: [filters(36)] };
    const reversed: Required<ReverseReceiptInput> = { reason: 'Wrong order.' };
    const bill: Required<SaveVendorBillInput> = fullBill();
    const anyway: Required<ApproveVendorBillInput> = { reason: 'Vendor will credit it.' };
    const paid: Required<PayVendorBillInput> = { paidOn: '2026-11-19', method: 'ACH', reference: 'Transfer 88' };
    const short: Required<CloseShortInput> = { reason: 'Discontinued.' };

    await expect(check(received, ReceiveGoodsDto)).resolves.toBeDefined();
    await expect(check({ requestKey: key(1), lines: [filters(1)] }, ReceiveGoodsDto)).resolves.toBeDefined();
    await expect(check(reversed, ReverseReceiptDto)).resolves.toBeDefined();
    await expect(check(bill, SaveVendorBillDto)).resolves.toBeDefined();
    await expect(check(anyway, ApproveVendorBillAnywayDto)).resolves.toBeDefined();
    await expect(check(paid, PayVendorBillDto)).resolves.toBeDefined();
    await expect(check(short, CloseShortDto)).resolves.toBeDefined();
  });

  it('refuse a receipt of nothing or with no key, a price typed on a receipt, a bill\'s status, and a way of paying nobody uses', async () => {
    await expect(check({ requestKey: key(1), lines: [] }, ReceiveGoodsDto)).rejects.toBeDefined();
    await expect(check({ lines: [filters(1)] }, ReceiveGoodsDto)).rejects.toBeDefined();
    await expect(check({ requestKey: key(1), lines: [filters(0)] }, ReceiveGoodsDto)).rejects.toBeDefined();
    await expect(check({ requestKey: key(1), lines: [{ ...filters(1), unitCostCents: 1 }] }, ReceiveGoodsDto)).rejects.toBeDefined();
    await expect(check({ ...fullBill(), status: 'APPROVED' }, SaveVendorBillDto)).rejects.toBeDefined();
    await expect(check({ ...fullBill(), approvedById: owner.id }, SaveVendorBillDto)).rejects.toBeDefined();
    await expect(check({ paidOn: '2026-11-19', method: 'BARTER', reference: null }, PayVendorBillDto)).rejects.toBeDefined();
    await expect(check({ reason: '' }, ApproveVendorBillAnywayDto)).rejects.toBeDefined();
  });
});

describe('who may do what', () => {
  const permissionsOf = (name: string) => Reflect.getMetadata('permissions', (PurchaseReceivingController.prototype as unknown as Record<string, object>)[name]!) as string[];

  it('receives with purchasing:receive, bills and pays with purchasing:bills, and overrides a mismatch with approve-any', () => {
    for (const receives of ['receive', 'reverseReceipt']) expect(permissionsOf(receives)).toEqual(['purchasing:request', 'purchasing:receive']);
    for (const bills of ['saveBill', 'approveBill', 'payBill']) expect(permissionsOf(bills)).toEqual(['purchasing:request', 'purchasing:bills']);
    expect(permissionsOf('approveBillAnyway')).toEqual(['purchasing:request', 'purchasing:approve', 'purchasing:approve-any']);
    expect(permissionsOf('closeShort')).toEqual(['purchasing:request', 'purchasing:order']);
  });

  it('never lets an API key receive goods or pay a bill', () => {
    expect(MACHINE_FORBIDDEN_PERMISSIONS).toEqual(expect.arrayContaining(['purchasing:receive', 'purchasing:bills']));
  });
});
