import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import {
  MACHINE_FORBIDDEN_PERMISSIONS,
  MOST_PENDING_LINES_ORDERED,
  type CancelPurchaseOrderInput,
  type MakePurchaseOrdersInput,
  type PurchaseOrderDecisionInput,
  type SavePurchaseOrderInput,
  type SendPurchaseOrderInput,
} from '@texasrenters/shared';

import { CancelPurchaseOrderDto, MakePurchaseOrdersDto, PurchaseOrderDecisionDto, PurchaseOrdersController, SavePurchaseOrderDto, SendPurchaseOrderDto } from '../src/admin/purchase-orders.controller';
import { PurchaseOrdersService } from '../src/admin/purchase-orders.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Purchase orders, phase 3 (2026-11-19). Every id, name, code, address and
 * price here is invented. The database below holds orders the way the service
 * reads and writes them; what only the real database does (refusing the
 * maker's approval, a requisition line on two live orders, the same send key
 * twice) is in the migration and is not exercised here. No email is sent: the
 * mail service is a stand-in that counts its calls.
 */

const ORG = '90000000-0000-4000-8000-000000000001';
const OTHER_ORG = '90000000-0000-4000-8000-000000000002';
const id = (n: number) => `90000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`;
const FILTER = id(1);
const BATTERY = id(2);
const ALARM = id(3);
const STOCKROOM = id(11);
const HILL = id(21);
const ALAMO = id(22);
const CLOSED_VENDOR = id(23);
const REQUISITION = id(31);
const WAITING_REQUISITION = id(32);
/** Another approved requisition, made after REQUISITION (2026-11-23: one order from several). */
const LATER_REQUISITION = id(33);
const TRUCK = id(12);
const KEY = id(90);

const person = (n: number, displayName: string, permissions: string[], organizationId = ORG): AuthenticatedUser =>
  ({ id: id(900 + n), authUserId: `auth-${n}`, organizationId, displayName, roles: [UserRole.INSPECTION_SUPERVISOR], permissions, mustChangePassword: false, principalType: 'USER' }) as AuthenticatedUser;
const asker = person(1, 'Sample Requester', ['purchasing:request']);
const colleague = person(2, 'Another Requester', ['purchasing:request']);
const buyer = person(3, 'Sample Purchaser', ['purchasing:request', 'purchasing:order']);
const manager = person(4, 'Sample Manager', ['purchasing:request', 'purchasing:approve-orders']);
const owner = person(5, 'Sample Owner', ['purchasing:request', 'purchasing:approve-orders', 'purchasing:approve-any']);
/** Buys, and approves as a purchasing manager: one they made too (2026-11-21). */
const everything = person(6, 'Sample Everything', ['purchasing:request', 'purchasing:order', 'purchasing:approve-orders', 'purchasing:approve-any']);
const outsider = person(7, 'Other Office', ['purchasing:request', 'purchasing:order', 'purchasing:approve-orders', 'purchasing:approve-any'], OTHER_ORG);
/** Approves requisitions only: never an order (2026-11-21). */
const reviewer = person(8, 'Requisition Approver', ['purchasing:request', 'purchasing:approve']);
const PEOPLE = [asker, colleague, buyer, manager, owner, everything, outsider, reviewer];

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
const PDF = Buffer.from('%PDF-1.7 an order').toString('base64');

function database() {
  const items: Row[] = [
    { id: FILTER, code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each' },
    { id: BATTERY, code: 'PRT-0001', name: 'Battery, 9 V', unit: 'each' },
    { id: ALARM, code: 'PRT-0002', name: 'Smoke alarm', unit: 'each' },
  ];
  const vendors: Row[] = [
    { id: HILL, organizationId: ORG, name: 'Hill Country Supply', contactName: 'A Person', email: 'orders@hill.example', phone: null, terms: 'Net 30', active: true },
    { id: ALAMO, organizationId: ORG, name: 'Alamo Trade Parts', contactName: null, email: null, phone: null, terms: null, active: true },
    { id: CLOSED_VENDOR, organizationId: ORG, name: 'Closed Supply', contactName: null, email: null, phone: null, terms: null, active: false },
  ];
  const requisitions: Row[] = [
    { id: REQUISITION, organizationId: ORG, number: 'PR-0012', status: 'APPROVED', requestedById: asker.id, xeroTenantId: 'tenant-thmp', deliverToPlaceId: STOCKROOM, createdAt: new Date('2026-11-18T15:00:00Z') },
    { id: WAITING_REQUISITION, organizationId: ORG, number: 'PR-0013', status: 'SUBMITTED', requestedById: colleague.id, xeroTenantId: null, deliverToPlaceId: null, createdAt: new Date('2026-11-18T16:00:00Z') },
    { id: LATER_REQUISITION, organizationId: ORG, number: 'PR-0014', status: 'APPROVED', requestedById: colleague.id, xeroTenantId: 'tenant-thmp', deliverToPlaceId: STOCKROOM, createdAt: new Date('2026-11-18T17:00:00Z') },
  ];
  const requisitionLines: Row[] = [
    { id: id(41), organizationId: ORG, requisitionId: REQUISITION, position: 0, itemId: FILTER, quantity: 36, estimatedUnitCostCents: 390, placeId: null },
    { id: id(42), organizationId: ORG, requisitionId: REQUISITION, position: 1, itemId: BATTERY, quantity: 24, estimatedUnitCostCents: 185, placeId: null },
    { id: id(43), organizationId: ORG, requisitionId: WAITING_REQUISITION, position: 0, itemId: ALARM, quantity: 4, estimatedUnitCostCents: 1530, placeId: null },
    // The same filters for the stockroom, and smoke alarms for the truck.
    { id: id(44), organizationId: ORG, requisitionId: LATER_REQUISITION, position: 0, itemId: FILTER, quantity: 12, estimatedUnitCostCents: 400, placeId: null },
    { id: id(45), organizationId: ORG, requisitionId: LATER_REQUISITION, position: 1, itemId: ALARM, quantity: 4, estimatedUnitCostCents: 1530, placeId: TRUCK },
  ];
  const quotes: Row[] = [{ requisitionId: REQUISITION, vendorId: HILL, chosen: true }];
  /** The requisition lines each order carries (2026-11-23). */
  const sources: Row[] = [];
  const liveSource = (lineId: unknown) => sources.find((source) => source.requisitionLineId === lineId && source.releasedAt === null);
  const orders: Row[] = [];
  const lines: Row[] = [];
  const deliveries: Row[] = [];
  const audits: Row[] = [];
  /** Files on the requisitions (2026-11-20); none unless a test attaches some. */
  const requisitionFiles: Row[] = [];
  let series = 0;
  let clock = Date.parse('2026-11-19T15:00:00.000Z');

  const requisitionOf = (requisitionId: unknown): Row & { lines: Row[] } => {
    const requisition = requisitions.find((row) => row.id === requisitionId)!;
    return { ...requisition, lines: requisitionLines.filter((line) => line.requisitionId === requisitionId).map((line) => ({ ...line, vendor: vendors.find((vendor) => vendor.id === line.vendorId) ?? null })) };
  };
  function matches(row: Row, where: Where): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (value === undefined) return true;
      if (key === 'AND') return (value as Where[]).every((part) => matches(row, part));
      if (key === 'OR') return (value as Where[]).some((part) => matches(row, part));
      if (key === 'requisition') return matches(requisitionOf(row.requisitionId), value as Where);
      // An order's shares, by their requisition (who may see it, 2026-11-23).
      if (key === 'sources') return sources.some((source) => source.orderId === row.id && matches(source, (value as { some: Where }).some));
      if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
        const rule = value as { in?: unknown[]; notIn?: unknown[]; not?: unknown; gte?: Date };
        if (rule.in) return rule.in.includes(row[key]);
        if (rule.notIn) return !rule.notIn.includes(row[key]);
        if (rule.gte) return (row[key] as Date) >= rule.gte;
        if ('not' in rule) return row[key] !== rule.not;
      }
      return row[key] === value;
    });
  }
  const nameOf = (personId: unknown) => (personId ? { displayName: PEOPLE.find((one) => one.id === personId)!.displayName } : null);
  const whole = (order: Row) => ({
    ...order,
    createdBy: nameOf(order.createdById),
    approvedBy: nameOf(order.approvedById),
    vendor: vendors.find((vendor) => vendor.id === order.vendorId) ?? null,
    deliverTo: placeOf(order.deliverToPlaceId),
    bill: null,
    requisition: requisitionOf(order.requisitionId),
    lines: lines
      .filter((line) => line.orderId === order.id)
      .sort((left, right) => (left.position as number) - (right.position as number))
      .map((line) => ({ ...line, item: items.find((item) => item.id === line.itemId), place: placeOf(line.placeId) })),
    // Oldest requisition first, as the service asks.
    sources: sources
      .filter((source) => source.orderId === order.id)
      .sort((left, right) => (requisitionOf(left.requisitionId).createdAt as Date).getTime() - (requisitionOf(right.requisitionId).createdAt as Date).getTime())
      .map((source) => ({ ...source, requisition: { id: source.requisitionId, number: requisitionOf(source.requisitionId).number }, requisitionLine: { department: null } })),
  });
  const placeOf = (placeId: unknown) => (placeId === STOCKROOM ? { id: STOCKROOM, name: 'Stockroom', code: 'STORE' } : placeId === TRUCK ? { id: TRUCK, name: 'Truck 1', code: 'TRK1' } : null);
  /** A requisition line as the service reads it: for Pending Processing, and for making orders. */
  const requisitionLineOf = (line: Row) => {
    const requisition = requisitionOf(line.requisitionId);
    return {
      ...line,
      notes: null,
      expectedOn: null,
      item: items.find((item) => item.id === line.itemId) ?? null,
      place: placeOf(line.placeId),
      vendor: vendors.find((vendor) => vendor.id === line.vendorId) ?? null,
      department: null,
      orderSources: sources.filter((source) => source.requisitionLineId === line.id && source.releasedAt === null).map((source) => ({ id: source.id })),
      requisition: {
        ...requisition,
        requestedBy: nameOf(requisition.requestedById),
        deliverTo: placeOf(requisition.deliverToPlaceId),
        quotes: quotes.filter((quote) => quote.requisitionId === requisition.id && quote.chosen).map((quote) => ({ vendor: vendors.find((vendor) => vendor.id === quote.vendorId) })),
      },
    };
  };
  const removeWhere = (rows: Row[], where: Where) => {
    for (let index = rows.length - 1; index >= 0; index -= 1) if (matches(rows[index]!, where)) rows.splice(index, 1);
  };

  const db = {
    purchaseOrder: {
      findMany: jest.fn(async ({ where }: { where: Where }) => orders.filter((row) => matches(row, where)).map(whole).reverse()),
      findFirst: jest.fn(async ({ where }: { where: Where }) => {
        const found = orders.find((row) => matches(row, where));
        return found ? whole(found) : null;
      }),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: id(100 + orders.length), number: null, status: 'DRAFT', expectedOn: null, taxBasisPoints: 0, notes: null, submittedAt: null, approvedById: null, approvedAt: null, decisionNote: null, sentAt: null, cancelReason: null, createdAt: new Date((clock += 1000)), ...data };
        orders.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Row }) => {
        const found = orders.filter((row) => matches(row, where));
        for (const row of found) Object.assign(row, data);
        return { count: found.length };
      }),
      count: jest.fn(async ({ where }: { where: Where }) => orders.filter((row) => matches(row, where)).length),
    },
    purchaseOrderLine: {
      createMany: jest.fn(async ({ data }: { data: Row[] }) => lines.push(...data.map((line, index) => ({ id: id(300 + lines.length + index), receivedQuantity: 0, ...line })))),
      deleteMany: jest.fn(async ({ where }: { where: Where }) => removeWhere(lines, where)),
    },
    purchaseRequisition: {
      findFirst: jest.fn(async ({ where }: { where: Where }) => {
        const found = requisitions.find((row) => matches(row, where));
        if (!found) return null;
        const requisition = requisitionOf(found.id);
        return {
          ...requisition,
          // Its lines with an item on no live order (2026-11-23).
          lines: requisition.lines.filter((line) => line.itemId && !liveSource(line.id)),
          quotes: quotes.filter((quote) => quote.requisitionId === found.id && quote.chosen).map((quote) => ({ ...quote, vendor: vendors.find((vendor) => vendor.id === quote.vendorId) })),
        };
      }),
      // The requisitions on an order, for its page (2026-11-23).
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        requisitions
          .filter((row) => matches(row, where))
          .map((row) => ({
            ...row,
            requestedBy: nameOf(row.requestedById),
            department: null,
            lines: requisitionLines.filter((line) => line.requisitionId === row.id).map((line) => ({ department: (line as { departmentCode?: string }).departmentCode ? { code: (line as { departmentCode?: string }).departmentCode } : null })),
            _count: { lines: requisitionLines.filter((line) => line.requisitionId === row.id).length },
            orderSources: sources.filter((source) => source.requisitionId === row.id && source.releasedAt === null).map((source) => ({ order: { status: orders.find((one) => one.id === source.orderId)!.status } })),
          })),
      ),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Row }) => {
        const found = requisitions.filter((row) => matches(row, where));
        for (const row of found) Object.assign(row, data);
        return { count: found.length };
      }),
    },
    purchaseRequisitionLine: {
      // By id, to make orders; else Pending Processing: approved requisitions' lines with an item on no live order.
      findMany: jest.fn(async ({ where }: { where: Where & { id?: { in: string[] } } }) =>
        requisitionLines
          .filter((line) =>
            where.id
              ? line.organizationId === where.organizationId && where.id.in.includes(line.id as string)
              : line.organizationId === where.organizationId && line.itemId && !liveSource(line.id) && ['APPROVED', 'ORDERED'].includes(requisitionOf(line.requisitionId).status as string),
          )
          .sort((left, right) => (requisitionOf(left.requisitionId).createdAt as Date).getTime() - (requisitionOf(right.requisitionId).createdAt as Date).getTime() || (left.position as number) - (right.position as number))
          .map(requisitionLineOf),
      ),
      // A requisition's lines still to order.
      count: jest.fn(async ({ where }: { where: Where }) => requisitionLines.filter((line) => line.requisitionId === where.requisitionId && line.itemId && !liveSource(line.id)).length),
    },
    purchaseOrderSource: {
      createMany: jest.fn(async ({ data }: { data: Row[] }) => sources.push(...data.map((source, index) => ({ id: id(600 + sources.length + index), releasedAt: null, createdAt: new Date((clock += 1)), ...source })))),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Row }) => {
        const found = sources.filter((row) => matches(row, where));
        for (const row of found) Object.assign(row, data);
        return { count: found.length };
      }),
    },
    vendor: {
      findFirst: jest.fn(async ({ where }: { where: Where }) => vendors.find((row) => matches(row, where)) ?? null),
      findMany: jest.fn(async ({ where }: { where: Where }) => vendors.filter((row) => matches(row, where))),
    },
    stockPlace: { findFirst: jest.fn(async ({ where }: { where: Where }) => ((where.id === STOCKROOM || where.id === TRUCK) && where.organizationId === ORG ? { id: where.id } : null)) },
    xeroOrganisation: { findMany: jest.fn(async () => [{ xeroTenantId: 'tenant-thmp', name: 'THMP' }]) },
    purchasingSettings: { findUnique: jest.fn(async () => null) },
    // No approval steps saved: the office's limit reads as two steps (Purchasing Setup, 2026-11-20).
    purchasingApprovalStep: { findMany: jest.fn(async () => []) },
    // Setup's people (2026-11-21): none set, so everybody acts for every company with no limit of their own.
    purchasingPerson: { findUnique: jest.fn(async (): Promise<unknown> => null) },
    invoiceSettings: { findUnique: jest.fn(async () => ({ companyName: 'Example Office', addressLine1: '1 Example Plaza', addressLine2: 'Testville, TX 77000', phone: null, email: 'office@example.test' })) },
    purchaseOrderDelivery: {
      findMany: jest.fn(async ({ where }: { where: Where }) => deliveries.filter((row) => matches(row, where)).reverse()),
      findFirst: jest.fn(async ({ where }: { where: Where }) => deliveries.find((row) => matches(row, where)) ?? null),
      count: jest.fn(async ({ where }: { where: Where }) => deliveries.filter((row) => matches(row, where)).length),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: id(500 + deliveries.length), status: 'PENDING', failure: null, sentAt: null, createdAt: new Date(), ...data };
        deliveries.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(deliveries.find((row) => row.id === where.id)!, data)),
    },
    // Nothing has arrived for any of these: receiving has its own spec.
    goodsReceipt: { findMany: jest.fn(async () => []) },
    purchaseRequisitionFile: { findMany: jest.fn(async ({ where }: { where: Where }) => requisitionFiles.filter((row) => matches(row, where))) },
    userProfile: { findMany: jest.fn(async () => PEOPLE.map((one) => ({ id: one.id, displayName: one.displayName }))) },
    auditLog: {
      create: jest.fn(async ({ data }: { data: Row }) => audits.push({ createdAt: new Date((clock += 1000)), ...data })),
      findMany: jest.fn(async ({ where }: { where: Where }) => audits.filter((row) => matches(row, where)).reverse()),
    },
    // The email lock answers nothing; taking the office's next order number answers the number taken.
    $queryRaw: jest.fn(async (sql: TemplateStringsArray) => (sql.join('').includes('DocumentSeries') ? [{ taken: (series += 1) }] : [])),
  };
  const transaction = { $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => work(client)) };
  const client: unknown = Object.assign(db, transaction);
  const mail = { sendPurchaseOrder: jest.fn<Promise<{ status: string; message: string }>, [Row]>(async () => ({ status: 'SENT', message: 'Email sent successfully.' })) };
  const storage = { get: jest.fn(async (key: string) => Buffer.from(`the bytes of ${key}`)) };
  return { db, mail, storage, items, orders, lines, sources, requisitions, requisitionLines, quotes, vendors, deliveries, audits, requisitionFiles, service: new PurchaseOrdersService(db as never, mail as never, storage as never) };
}

const line = (itemId: string, quantity: number, unitPriceCents: number) => ({ itemId, quantity, unitPriceCents });
/** $140.40 + $44.40 = $184.80, and 8.25% tax: $200.05. Under the $500.00 limit. */
const terms = (over: Partial<SavePurchaseOrderInput> = {}): SavePurchaseOrderInput => ({
  vendorId: HILL,
  deliverToPlaceId: STOCKROOM,
  expectedOn: '2026-11-24',
  terms: 'Net 30',
  taxBasisPoints: 825,
  notes: null,
  lines: [line(FILTER, 36, 390), line(BATTERY, 24, 185)],
  ...over,
});
const email = (over: Partial<SendPurchaseOrderInput> = {}): SendPurchaseOrderInput => ({ to: 'orders@hill.example', message: 'Please confirm the delivery day.', attachment: { fileName: 'PO-0001.pdf', contentBase64: PDF }, clientRequestId: KEY, ...over });

/** A made order, taken as far as asked. */
async function order(to: 'draft' | 'waiting' | 'approved', maker: AuthenticatedUser = buyer, input: SavePurchaseOrderInput = terms()) {
  const made = database();
  const { orders: [draft] } = await made.service.createFromRequisition(maker, REQUISITION);
  if (!draft) throw new Error('no order made');
  await made.service.update(maker, draft.id, input);
  if (to !== 'draft') await made.service.submit(maker, draft.id);
  if (to === 'approved') await made.service.decide(owner, draft.id, 'APPROVED', {});
  return { ...made, orderId: draft.id };
}

afterEach(() => {
  delete process.env.PURCHASE_ORDER_EMAIL_DAILY_CEILING;
});

describe('making an order', () => {
  it('starts from an approved requisition: its items and quantities, to the vendor of its chosen quote', async () => {
    const { service, requisitions, audits } = database();
    const made = await service.createFromRequisition(buyer, REQUISITION);
    expect(made).toMatchObject({ orders: [{ id: expect.any(String), vendor: { id: HILL, name: 'Hill Country Supply' } }] });
    const draft = await service.detail(buyer, made.orders[0]!.id);

    expect(draft).toMatchObject({ status: 'DRAFT', number: null, vendor: { id: HILL, name: 'Hill Country Supply' }, terms: 'Net 30', requisition: { id: REQUISITION, number: 'PR-0012' }, company: { name: 'THMP' }, madeBy: { name: 'Sample Purchaser' }, subtotalCents: 18480, totalCents: 18480 });
    expect(draft.lines.map((one) => [one.item.code, one.quantity, one.unitPriceCents, one.requestedQuantity])).toEqual([['FLT-0003', 36, 390, 36], ['PRT-0001', 24, 185, 24]]);
    expect(draft.can).toMatchObject({ edit: true, submit: true, approve: false, send: false, cancel: true });
    expect(requisitions[0]).toMatchObject({ status: 'ORDERED' });
    expect(audits.map((audit) => [audit.action, audit.entityType])).toEqual([['PURCHASE_ORDER_CREATED', 'PurchaseOrder'], ['PURCHASE_REQUISITION_ORDERED', 'PurchaseRequisition']]);
  });

  it('keeps a line whose item code was deleted since, and says so (2026-11-24)', async () => {
    const { service, items } = database();
    const made = await service.createFromRequisition(buyer, REQUISITION);
    items.find((item) => item.id === FILTER)!.deletedAt = new Date('2026-11-24T16:00:00.000Z');

    const order = await service.detail(buyer, made.orders[0]!.id);
    expect(order.lines.map((one) => [one.item.code, one.item.name, one.item.deleted])).toEqual([
      ['FLT-0003', 'Filter 20x25x1 (deleted)', true],
      ['PRT-0001', 'Battery, 9 V', false],
    ]);
    // When it was deleted is not sent.
    expect(order.lines[0]!.item).not.toHaveProperty('deletedAt');
    expect(order.subtotalCents).toBe(18480);
  });

  it('makes one order a vendor: each line to its own, else to the chosen quote, and with neither to one waiting for a vendor (2026-11-20)', async () => {
    const mixed = database();
    mixed.quotes.splice(0, mixed.quotes.length);
    mixed.requisitionLines.forEach((line, index) => (line.vendorId = index === 0 ? ALAMO : HILL));
    const made = await mixed.service.createFromRequisition(buyer, REQUISITION);
    expect(made.orders.map((one) => one.vendor?.id)).toEqual([ALAMO, HILL]);
    const drafts = await Promise.all(made.orders.map((one) => mixed.service.detail(buyer, one.id)));
    expect(drafts.map((draft) => draft.lines.map((one) => one.item.code))).toEqual([['FLT-0003'], ['PRT-0001']]);
    expect(drafts.map((draft) => draft.terms)).toEqual([null, 'Net 30']);
    expect(mixed.audits.at(-1)).toMatchObject({ action: 'PURCHASE_REQUISITION_ORDERED', metadata: expect.objectContaining({ orders: 2, note: 'Alamo Trade Parts, Hill Country Supply' }) });

    // A line naming no vendor goes to the chosen quote's vendor.
    const quoted = database();
    quoted.requisitionLines[0]!.vendorId = ALAMO;
    expect((await quoted.service.createFromRequisition(buyer, REQUISITION)).orders.map((one) => one.vendor?.id)).toEqual([ALAMO, HILL]);

    // With no vendor anywhere, one order waits for the purchaser to choose.
    const none = database();
    none.quotes.splice(0, none.quotes.length);
    expect((await none.service.createFromRequisition(buyer, REQUISITION)).orders).toEqual([{ id: expect.any(String), vendor: null }]);

    // A vendor no longer in use is treated as none.
    const closed = database();
    closed.quotes.splice(0, closed.quotes.length);
    closed.requisitionLines.forEach((line) => (line.vendorId = CLOSED_VENDOR));
    expect((await closed.service.createFromRequisition(buyer, REQUISITION)).orders).toEqual([{ id: expect.any(String), vendor: null }]);
  });

  it('after one of its orders is cancelled, waits on Pending Processing for those lines, and orders only them again (2026-11-23)', async () => {
    const made = database();
    made.quotes.splice(0, made.quotes.length);
    made.requisitionLines.forEach((line, index) => (line.vendorId = index === 0 ? ALAMO : HILL));
    const { orders: [alamo, hill] } = await made.service.createFromRequisition(buyer, REQUISITION);

    // Its filters are to order again: it is approved, Pending Processing, until they are.
    await made.service.cancel(buyer, alamo!.id, { reason: 'Out of stock.' });
    expect(made.requisitions[0]).toMatchObject({ status: 'APPROVED' });
    expect((await made.service.pendingLines(buyer)).lines.filter((one) => one.requisition.id === REQUISITION).map((one) => one.item.code)).toEqual(['FLT-0003']);
    const again = await made.service.createFromRequisition(buyer, REQUISITION);
    expect(again.orders.map((one) => one.vendor?.id)).toEqual([ALAMO]);
    expect(made.requisitions[0]).toMatchObject({ status: 'ORDERED' });
    await expect(made.service.createFromRequisition(buyer, REQUISITION)).rejects.toMatchObject({ code: 'REQUISITION_NOT_ORDERABLE', message: 'Every line of this requisition is on an order already.' });

    await made.service.cancel(buyer, hill!.id, { reason: 'Changed our minds.' });
    expect(made.requisitions[0]).toMatchObject({ status: 'APPROVED' });
  });

  it('never puts a requisition line on two live orders: an order holds only the lines it carries', async () => {
    const made = database();
    made.quotes.splice(0, made.quotes.length);
    made.requisitionLines.forEach((line, index) => (line.vendorId = index === 0 ? ALAMO : HILL));
    const { orders: [, hill] } = await made.service.createFromRequisition(buyer, REQUISITION);

    // Hill holds the batteries; the filters are on Alamo's order.
    await expect(made.service.update(buyer, hill!.id, terms())).rejects.toMatchObject({ code: 'PURCHASE_ORDER_ITEM_NOT_REQUESTED' });
    expect((await made.service.update(buyer, hill!.id, terms({ lines: [line(BATTERY, 30, 180)] }))).lines.map((one) => one.quantity)).toEqual([30]);
  });

  it('is made once a requisition, and never from one that is not approved', async () => {
    const { service, orders } = database();
    await service.createFromRequisition(buyer, REQUISITION);

    await expect(service.createFromRequisition(everything, REQUISITION)).rejects.toMatchObject({ code: 'REQUISITION_NOT_ORDERABLE' });
    await expect(service.createFromRequisition(buyer, WAITING_REQUISITION)).rejects.toMatchObject({ code: 'REQUISITION_NOT_ORDERABLE' });
    await expect(service.createFromRequisition(outsider, REQUISITION)).rejects.toMatchObject({ code: 'REQUISITION_NOT_FOUND' });
    expect(orders).toHaveLength(1);
  });

  it('is seen by whoever buys or approves, and by whoever asked for the requisition', async () => {
    const { service, orderId } = await order('draft');

    for (const sees of [buyer, manager, owner, asker]) expect((await service.list(sees)).orders.map((one) => one.id)).toEqual([orderId]);
    expect((await service.detail(asker, orderId)).can).toMatchObject({ edit: false, submit: false, approve: false, send: false, cancel: false });
    expect((await service.list(colleague)).orders).toEqual([]);
    await expect(service.detail(colleague, orderId)).rejects.toMatchObject({ code: 'PURCHASE_ORDER_NOT_FOUND' });
    await expect(service.detail(outsider, orderId)).rejects.toMatchObject({ code: 'PURCHASE_ORDER_NOT_FOUND' });
  });

  it('holds only the items its requisition asked for, each once, from a vendor in use', async () => {
    const { service, orderId, lines } = await order('draft');
    const refused = async (over: Partial<SavePurchaseOrderInput>, code: string) => expect(service.update(buyer, orderId, terms(over))).rejects.toMatchObject({ code });

    await refused({ lines: [line(ALARM, 4, 1530)] }, 'PURCHASE_ORDER_ITEM_NOT_REQUESTED');
    await refused({ lines: [line(FILTER, 1, 390), line(FILTER, 2, 390)] }, 'PURCHASE_ORDER_ITEM_TWICE');
    await refused({ vendorId: CLOSED_VENDOR }, 'VENDOR_NOT_FOUND');
    await refused({ deliverToPlaceId: id(78) }, 'PURCHASE_ORDER_PLACE_NOT_FOUND');
    expect(lines.map((one) => one.quantity)).toEqual([36, 24]);

    const changed = await service.update(buyer, orderId, terms({ vendorId: ALAMO, lines: [line(FILTER, 30, 375)] }));
    expect(changed).toMatchObject({ vendor: { name: 'Alamo Trade Parts' }, subtotalCents: 11250, taxCents: 928, totalCents: 12178, expectedOn: '2026-11-24' });
  });

  it('takes the next number when submitted, needs its vendor, and is fixed from then', async () => {
    const { service, orderId } = await order('draft', buyer, terms({ vendorId: null }));
    await expect(service.submit(buyer, orderId)).rejects.toMatchObject({ code: 'PURCHASE_ORDER_NOT_READY', message: 'Choose the vendor.' });

    await service.update(buyer, orderId, terms());
    expect(await service.submit(buyer, orderId)).toMatchObject({ number: 'PO-0001', status: 'AWAITING_APPROVAL', totalCents: 20005, can: { edit: false, submit: false } });
    await expect(service.update(buyer, orderId, terms({ lines: [line(FILTER, 500, 390)] }))).rejects.toMatchObject({ code: 'PURCHASE_ORDER_FIXED' });
    await expect(service.submit(buyer, orderId)).rejects.toMatchObject({ code: 'PURCHASE_ORDER_MOVED_ON' });
  });
});

describe('Pending Processing: one order from several requisitions (2026-11-23)', () => {
  const pick = (requisitionLineId: string, vendorId: string | null = HILL) => ({ requisitionLineId, vendorId });

  it("lists every approved requisition's lines not on an order, oldest first, with the vendor each goes to and its place", async () => {
    const { service } = database();
    const pending = await service.pendingLines(buyer);
    expect(pending.lines.map((one) => [one.requisition.number, one.item.code, one.quantity, one.place?.name ?? null, one.vendor?.name ?? null])).toEqual([
      ['PR-0012', 'FLT-0003', 36, 'Stockroom', 'Hill Country Supply'],
      ['PR-0012', 'PRT-0001', 24, 'Stockroom', 'Hill Country Supply'],
      ['PR-0014', 'FLT-0003', 12, 'Stockroom', null],
      ['PR-0014', 'PRT-0002', 4, 'Truck 1', null],
    ]);
    expect(pending.lines[0]).toMatchObject({ company: { name: 'THMP' }, requisition: { requestedBy: 'Sample Requester' } });
    // The vendors in use, for a line with none; not the one closed.
    expect(pending.vendors.map((one) => one.name)).toEqual(['Hill Country Supply', 'Alamo Trade Parts']);
  });

  // An item code deleted while its line waited (data from before 2026-11-24's fix): shown, marked, and not ordered.
  it('keeps a line whose item code was deleted on the list, marked, and refuses to order it', async () => {
    const { service, items, orders } = database();
    const before = orders.length;
    items.find((item) => item.id === BATTERY)!.deletedAt = new Date('2026-11-24T16:00:00Z');

    const pending = await service.pendingLines(buyer);
    expect(pending.lines.find((one) => one.item.code === 'PRT-0001')!.item).toEqual({ id: BATTERY, code: 'PRT-0001', name: 'Battery, 9 V (deleted)', unit: 'each', deleted: true });
    expect(pending.lines.find((one) => one.item.code === 'FLT-0003')!.item).toMatchObject({ name: 'Filter 20x25x1', deleted: false });

    await expect(service.makeOrders(buyer, { lines: [pick(id(41)), pick(id(42))] })).rejects.toMatchObject({
      code: 'STOCK_ITEM_DELETED',
      message: 'PRT-0001 on PR-0012 was deleted, so it is not ordered. Reopen PR-0012 and give the line an item code in use, or cancel it.',
    });
    expect(orders).toHaveLength(before);
  });

  it('makes one order a vendor and company: the same item to the same place one line, quantities added, each line where it goes', async () => {
    const { service, requisitions, audits } = database();
    const made = await service.makeOrders(buyer, { lines: [pick(id(41)), pick(id(42)), pick(id(44)), pick(id(45))] });
    expect(made.orders).toEqual([{ id: expect.any(String), vendor: expect.objectContaining({ id: HILL }) }]);

    const order = await service.detail(buyer, made.orders[0]!.id);
    expect(order.lines.map((one) => [one.item.code, one.place?.name ?? null, one.quantity, one.unitPriceCents, one.shares.map((share) => `${share.requisition.number} x ${share.quantity}`)])).toEqual([
      // At the oldest requisition's estimate.
      ['FLT-0003', 'Stockroom', 48, 390, ['PR-0012 x 36', 'PR-0014 x 12']],
      ['PRT-0001', 'Stockroom', 24, 185, ['PR-0012 x 24']],
      ['PRT-0002', 'Truck 1', 4, 1530, ['PR-0014 x 4']],
    ]);
    expect(order).toMatchObject({ requisition: { number: 'PR-0012' }, requisitions: [{ number: 'PR-0012' }, { number: 'PR-0014' }], deliverTo: null });
    expect(order.requisitionsOn.map((one) => [one.number, one.requestedBy, `${one.linesHere} of ${one.lineCount}`])).toEqual([
      ['PR-0012', 'Sample Requester', '2 of 2'],
      ['PR-0014', 'Another Requester', '2 of 2'],
    ]);
    expect(requisitions.map((one) => one.status)).toEqual(['ORDERED', 'SUBMITTED', 'ORDERED']);
    expect(audits.filter((audit) => audit.action === 'PURCHASE_REQUISITION_ORDERED').map((audit) => audit.entityId)).toEqual([REQUISITION, LATER_REQUISITION]);
    // Nothing is left to order.
    expect((await service.pendingLines(buyer)).lines).toEqual([]);
  });

  it('gives what arrives to its requisitions, the oldest first', async () => {
    const { service, lines } = database();
    const made = await service.makeOrders(buyer, { lines: [pick(id(41)), pick(id(44))] });
    lines[0]!.receivedQuantity = 40;
    const [filters] = (await service.detail(buyer, made.orders[0]!.id)).lines;
    expect(filters!.shares.map((share) => [share.requisition.number, share.receivedQuantity])).toEqual([
      ['PR-0012', 36],
      ['PR-0014', 4],
    ]);
  });

  it('keeps a requisition with a line still to order approved, Pending Processing, and splits the vendors and companies', async () => {
    const { service, requisitions, requisitionLines } = database();
    requisitionLines[4]!.vendorId = ALAMO;
    requisitions[2]!.xeroTenantId = 'tenant-pest';
    const made = await service.makeOrders(buyer, { lines: [pick(id(41)), pick(id(44)), pick(id(45), ALAMO)] });
    // PR-0012's filters and PR-0014's are for two companies: three orders.
    expect(made.orders.map((one) => one.vendor?.name)).toEqual(['Hill Country Supply', 'Hill Country Supply', 'Alamo Trade Parts']);
    expect(requisitions.map((one) => one.status)).toEqual(['APPROVED', 'SUBMITTED', 'ORDERED']);
    expect((await service.pendingLines(buyer)).lines.map((one) => one.item.code)).toEqual(['PRT-0001']);
  });

  it('is seen by whoever asked for any requisition on it', async () => {
    const { service } = database();
    const made = await service.makeOrders(buyer, { lines: [pick(id(41)), pick(id(44))] });
    for (const sees of [asker, colleague]) expect((await service.list(sees)).orders.map((one) => one.id)).toEqual([made.orders[0]!.id]);
  });

  it('refuses a line on an order already, one not approved, a vendor not in use, and too many at once, ordering nothing', async () => {
    const { service, orders } = database();
    await service.makeOrders(buyer, { lines: [pick(id(41))] });
    await expect(service.makeOrders(buyer, { lines: [pick(id(41)), pick(id(44))] })).rejects.toMatchObject({ code: 'REQUISITION_LINE_ORDERED' });
    await expect(service.makeOrders(buyer, { lines: [pick(id(43))] })).rejects.toMatchObject({ code: 'REQUISITION_NOT_ORDERABLE' });
    await expect(service.makeOrders(buyer, { lines: [pick(id(44), CLOSED_VENDOR)] })).rejects.toMatchObject({ code: 'VENDOR_NOT_FOUND' });
    await expect(service.makeOrders(buyer, { lines: [pick(id(99))] })).rejects.toMatchObject({ code: 'REQUISITION_LINE_NOT_FOUND' });
    const many: MakePurchaseOrdersInput = { lines: Array.from({ length: MOST_PENDING_LINES_ORDERED + 1 }, (_, n) => pick(id(1000 + n))) };
    await expect(service.makeOrders(buyer, many)).rejects.toMatchObject({ code: 'PURCHASE_ORDER_TOO_MANY_LINES' });
    await expect(service.makeOrders(outsider, { lines: [pick(id(44))] })).rejects.toMatchObject({ code: 'REQUISITION_LINE_NOT_FOUND' });
    expect(orders).toHaveLength(1);
  });

  it('cancelled, gives every requisition on it back to Pending Processing', async () => {
    const { service, requisitions } = database();
    const made = await service.makeOrders(buyer, { lines: [pick(id(41)), pick(id(42)), pick(id(44)), pick(id(45))] });
    await service.cancel(buyer, made.orders[0]!.id, { reason: 'The vendor is closed this week.' });
    expect(requisitions.map((one) => one.status)).toEqual(['APPROVED', 'SUBMITTED', 'APPROVED']);
    expect((await service.pendingLines(buyer)).lines).toHaveLength(4);
    // It still shows what it carried.
    expect((await service.detail(buyer, made.orders[0]!.id)).requisitions.map((one) => one.number)).toEqual(['PR-0012', 'PR-0014']);
  });

  it('changed, gives a line taken off back to its requisition; going to one place, moves with Deliver to', async () => {
    const { service, requisitions, sources } = database();
    const made = await service.makeOrders(buyer, { lines: [pick(id(41)), pick(id(42)), pick(id(44))] });
    const orderId = made.orders[0]!.id;
    expect(await service.detail(buyer, orderId)).toMatchObject({ deliverTo: { id: STOCKROOM } });

    // Batteries off: PR-0012 waits for them again.
    await service.update(buyer, orderId, terms({ lines: [line(FILTER, 48, 390)] }));
    expect(requisitions[0]).toMatchObject({ status: 'APPROVED' });
    expect((await service.pendingLines(buyer)).lines.map((one) => one.item.code)).toEqual(['PRT-0001', 'PRT-0002']);

    // All of it to the truck instead.
    const moved = await service.update(buyer, orderId, terms({ deliverToPlaceId: TRUCK, lines: [{ ...line(FILTER, 48, 390), placeId: STOCKROOM }] }));
    expect(moved.lines.map((one) => [one.item.code, one.place?.name, one.shares.length])).toEqual([['FLT-0003', 'Truck 1', 2]]);
    expect(sources.filter((one) => one.releasedAt === null).map((one) => one.placeId)).toEqual([TRUCK, TRUCK]);
  });
});

describe('changing an approved order (Purchasing Setup, 2026-11-20)', () => {
  const office = (reapproveChangedOrders: boolean) => ({
    approvalLimitCents: 50000,
    quotesAboveLimit: 2,
    emailApprovers: false,
    reapproveChangedOrders,
    fileGroups: ['PDF', 'PICTURES', 'WORD', 'EXCEL'],
    fileMaxBytes: 20_000_000,
    filesMax: 20,
    quoteFileAboveCents: null,
    fileRemoval: 'UNTIL_SENT',
  });

  it('stays approved when it only comes down, and goes back for approval when it rises -- never approved by whoever raised it', async () => {
    const { service, orderId, audits } = await order('approved');
    expect((await service.detail(buyer, orderId)).can).toMatchObject({ change: true, edit: false });
    expect((await service.detail(manager, orderId)).can).toMatchObject({ change: false });

    expect(await service.update(buyer, orderId, terms({ lines: [line(FILTER, 30, 390), line(BATTERY, 24, 185)] }))).toMatchObject({ status: 'APPROVED', approvedBy: 'Sample Owner' });
    expect(audits.at(-1)).toMatchObject({ action: 'PURCHASE_ORDER_CHANGED_AFTER_APPROVAL', metadata: expect.objectContaining({ again: false, note: 'it stays approved' }) });

    const raised = await service.update(everything, orderId, terms({ lines: [line(FILTER, 40, 390), line(BATTERY, 24, 185)] }));
    expect(raised).toMatchObject({ status: 'AWAITING_APPROVAL', approvedBy: null, number: 'PO-0001' });
    expect(raised.history[0]).toMatchObject({ by: 'Sample Everything', what: 'changed it after it was approved: it goes back for approval' });
    // Whoever changed it may approve the change, as an approver (the office, 2026-11-21).
    expect((await service.detail(everything, orderId)).can).toMatchObject({ approve: true, approveBlocked: null });
    expect(await service.decide(everything, orderId, 'APPROVED', {})).toMatchObject({ status: 'APPROVED', approvedBy: 'Sample Everything' });
  });

  it('goes back for approval with another vendor, and for every change when the office says so', async () => {
    const vendor = await order('approved');
    expect(await vendor.service.update(buyer, vendor.orderId, terms({ vendorId: ALAMO, lines: [line(FILTER, 30, 390)] }))).toMatchObject({ status: 'AWAITING_APPROVAL' });

    const every = await order('approved');
    every.db.purchasingSettings.findUnique.mockResolvedValue(office(true) as never);
    expect(await every.service.update(buyer, every.orderId, terms({ lines: [line(FILTER, 30, 390)] }))).toMatchObject({ status: 'AWAITING_APPROVAL' });
  });

  it('sent to the vendor and changed, is to be sent again; and is never changed while it waits', async () => {
    const sent = await order('approved');
    sent.orders[0]!.status = 'SENT';
    expect(await sent.service.update(buyer, sent.orderId, terms({ lines: [line(FILTER, 30, 390)] }))).toMatchObject({ status: 'APPROVED', can: { send: true } });
    expect(sent.audits.at(-1)).toMatchObject({ metadata: expect.objectContaining({ note: 'it stays approved, to be sent again' }) });

    const waiting = await order('waiting');
    await expect(waiting.service.update(buyer, waiting.orderId, terms())).rejects.toMatchObject({ code: 'PURCHASE_ORDER_FIXED' });
  });
});

describe('approving an order', () => {
  // 2026-11-21, the office: the purchasing manager approves orders; a requisition's approver does not.
  it("is never decided by an approver of requisitions only, and waits in the purchasing manager's Requests to Approve", async () => {
    const { service, orderId } = await order('waiting');
    expect((await service.detail(reviewer, orderId)).can).toMatchObject({ approve: false, sendBack: false });
    await expect(service.decide(reviewer, orderId, 'APPROVED', {})).rejects.toMatchObject({ code: 'PURCHASE_ORDER_NOT_APPROVER' });
    expect(await service.toApprove(reviewer)).toEqual([]);
    expect((await service.toApprove(manager)).map((row) => row.id)).toEqual([orderId]);
  });

  // 2026-11-21, the office: an approver approves an order they made, as anybody else's.
  it('is done by whoever made it when they are an approver, audited as their own, but never sent back by them', async () => {
    const { service, orderId, orders, audits } = await order('waiting', everything);

    expect((await service.detail(everything, orderId)).can).toMatchObject({ approve: true, sendBack: false, approveBlocked: null });
    await expect(service.decide(everything, orderId, 'SENT_BACK', { note: 'Mine' })).rejects.toMatchObject({ code: 'PURCHASE_ORDER_OWN', message: 'You made this order, so somebody else sends it back.' });
    expect(orders[0]).toMatchObject({ status: 'AWAITING_APPROVAL', approvedById: null });

    expect(await service.decide(everything, orderId, 'APPROVED', {})).toMatchObject({ status: 'APPROVED', approvedBy: 'Sample Everything' });
    expect(audits.at(-1)).toMatchObject({ action: 'PURCHASE_ORDER_APPROVED', metadata: expect.objectContaining({ ownOrder: true }) });
  });

  it('is never done by somebody who is not an approver, though the route is passed', async () => {
    const { service, orderId } = await order('waiting');
    await expect(service.decide(buyer, orderId, 'APPROVED', {})).rejects.toMatchObject({ code: 'PURCHASE_ORDER_NOT_APPROVER' });
    await expect(service.decide(buyer, orderId, 'SENT_BACK', { note: 'No' })).rejects.toMatchObject({ code: 'PURCHASE_ORDER_NOT_APPROVER' });
  });

  it('is done under the limit with Approve requisitions, once', async () => {
    const { service, orderId, audits } = await order('waiting');
    expect((await service.detail(manager, orderId)).can).toMatchObject({ approve: true, sendBack: true, approveBlocked: null, send: false });

    expect(await service.decide(manager, orderId, 'APPROVED', {})).toMatchObject({ status: 'APPROVED', approvedBy: 'Sample Manager' });
    expect(audits.at(-1)).toMatchObject({ action: 'PURCHASE_ORDER_APPROVED', actorUserId: manager.id, metadata: expect.objectContaining({ totalCents: 20005 }) });
    await expect(service.decide(owner, orderId, 'SENT_BACK', { note: 'Too late' })).rejects.toMatchObject({ code: 'PURCHASE_ORDER_MOVED_ON' });
  });

  it('counts the tax, and above the limit needs Approve any amount', async () => {
    // $499.20 before tax is under the limit; with 8.25% it is $540.38.
    const { service, orderId } = await order('waiting', buyer, terms({ lines: [line(FILTER, 128, 390)] }));

    expect((await service.detail(manager, orderId)).can).toMatchObject({ approve: false, approveBlocked: 'At $540.38 it needs somebody who may approve any amount.' });
    await expect(service.decide(manager, orderId, 'APPROVED', {})).rejects.toMatchObject({ code: 'PURCHASE_ORDER_OVER_LIMIT' });
    expect(await service.decide(owner, orderId, 'APPROVED', {})).toMatchObject({ status: 'APPROVED', totalCents: 54038 });
  });

  it('or it is sent back with a note, changed, and goes again under its own number', async () => {
    const { service, orderId } = await order('waiting');
    await expect(service.decide(manager, orderId, 'SENT_BACK', { note: ' ' })).rejects.toMatchObject({ code: 'PURCHASE_ORDER_NOTE_NEEDED' });

    expect(await service.decide(manager, orderId, 'SENT_BACK', { note: 'Ask Alamo for a price too.' })).toMatchObject({ status: 'DRAFT', number: 'PO-0001', decisionNote: 'Ask Alamo for a price too.' });
    await service.update(buyer, orderId, terms({ vendorId: ALAMO }));
    const again = await service.submit(buyer, orderId);
    expect(again).toMatchObject({ status: 'AWAITING_APPROVAL', number: 'PO-0001', decisionNote: null });
    expect(again.history.map((entry) => `${entry.by} ${entry.what}`).slice(0, 3)).toEqual([
      'Sample Purchaser submitted it for approval',
      'Sample Purchaser changed it',
      'Sample Manager sent it back: Ask Alamo for a price too.',
    ]);
  });
});

describe('sending an order to the vendor', () => {
  it('waits for approval', async () => {
    const { service, orderId, mail } = await order('waiting');
    await expect(service.send(buyer, orderId, email())).rejects.toMatchObject({ code: 'PURCHASE_ORDER_NOT_SENDABLE' });
    expect(mail.sendPurchaseOrder).not.toHaveBeenCalled();
  });

  it('is one email to one address with the PDF, and marks the order sent', async () => {
    const { service, orderId, mail, deliveries, audits } = await order('approved');
    const sent = await service.send(buyer, orderId, email());

    expect(mail.sendPurchaseOrder).toHaveBeenCalledTimes(1);
    const mailed = mail.sendPurchaseOrder.mock.calls[0]![0];
    expect(mailed).toMatchObject({ to: 'orders@hill.example', subject: 'Purchase order PO-0001 from THMP', replyTo: 'office@example.test', attachments: [{ name: 'PO-0001.pdf', contentType: 'application/pdf', contentBase64: PDF }] });
    expect(mailed.html).toContain('Total $200.05, including 8.25% sales tax');
    expect(sent).toMatchObject({ status: 'SENT', deliveries: [{ recipient: 'orders@hill.example', status: 'SENT', by: 'Sample Purchaser' }], can: { send: true, cancel: true } });
    expect(sent.sentAt).not.toBeNull();
    expect(deliveries).toHaveLength(1);
    expect(audits.at(-1)).toMatchObject({ action: 'PURCHASE_ORDER_SENT', actorUserId: buyer.id, metadata: expect.objectContaining({ to: 'orders@hill.example' }) });
  });

  /** A file on the order's requisition, as the requisition's own files service writes it. */
  const ticked = (n: number, fileName: string, sizeBytes: number, forVendor = true) => ({
    id: id(800 + n),
    organizationId: ORG,
    requisitionId: REQUISITION,
    fileName,
    contentType: 'application/pdf',
    sizeBytes,
    storageKey: `purchasing-files/${ORG}/${REQUISITION}/${id(800 + n)}`,
    forVendor,
  });

  it('carries the files ticked for the vendor beside the PDF, each read from storage once', async () => {
    const { service, orderId, mail, storage, audits, requisitionFiles } = await order('approved');
    requisitionFiles.push(ticked(1, 'Quote - Hill Country Supply.pdf', 182_000), ticked(2, 'Storeroom shelf.pdf', 900_000, false));

    expect((await service.detail(buyer, orderId)).vendorFiles).toEqual([{ id: id(801), fileName: 'Quote - Hill Country Supply.pdf', sizeBytes: 182_000 }]);
    await service.send(buyer, orderId, email());

    const mailed = mail.sendPurchaseOrder.mock.calls[0]![0] as { attachments: Row[]; html: string };
    expect(mailed.attachments).toEqual([
      { name: 'PO-0001.pdf', contentType: 'application/pdf', contentBase64: PDF },
      { name: 'Quote - Hill Country Supply.pdf', contentType: 'application/pdf', contentBase64: Buffer.from(`the bytes of purchasing-files/${ORG}/${REQUISITION}/${id(801)}`).toString('base64') },
    ]);
    expect(mailed.html).toContain('attached as a PDF, with one more file.');
    expect(storage.get).toHaveBeenCalledTimes(1);
    expect(audits.at(-1)).toMatchObject({ action: 'PURCHASE_ORDER_SENT', metadata: expect.objectContaining({ files: ['Quote - Hill Country Supply.pdf'] }) });
  });

  it('refuses files ticked past what one email carries, before the email is claimed or a file read', async () => {
    const { service, orderId, mail, storage, deliveries, requisitionFiles } = await order('approved');
    requisitionFiles.push(ticked(1, 'Quote.pdf', 1_500_000), ticked(2, 'Spec sheet.pdf', 1_500_000));

    await expect(service.send(buyer, orderId, email())).rejects.toMatchObject({
      code: 'PURCHASE_ORDER_FILES_TOO_BIG',
      message: 'The files ticked for the vendor come to 3 MB, and one email carries at most 2.5 MB beside the PDF. Untick some on the requisition, or send them on their own.',
    });
    expect(storage.get).not.toHaveBeenCalled();
    expect(mail.sendPurchaseOrder).not.toHaveBeenCalled();
    expect(deliveries).toHaveLength(0);
  });

  it('stops before the email is claimed when a ticked file cannot be read', async () => {
    const { service, orderId, mail, storage, deliveries, requisitionFiles } = await order('approved');
    requisitionFiles.push(ticked(1, 'Quote.pdf', 182_000));
    storage.get.mockRejectedValueOnce(new Error('gone'));

    await expect(service.send(buyer, orderId, email())).rejects.toMatchObject({ code: 'PURCHASE_ORDER_FILE_UNREADABLE', status: 502 });
    expect(mail.sendPurchaseOrder).not.toHaveBeenCalled();
    expect(deliveries).toHaveLength(0);
  });

  it('sent twice with the same key sends once; sent again on purpose sends again', async () => {
    const { service, orderId, mail, deliveries } = await order('approved');
    await service.send(buyer, orderId, email());
    await service.send(buyer, orderId, email());
    expect(mail.sendPurchaseOrder).toHaveBeenCalledTimes(1);

    await service.send(buyer, orderId, email({ clientRequestId: id(91) }));
    expect(mail.sendPurchaseOrder).toHaveBeenCalledTimes(2);
    expect(deliveries).toHaveLength(2);
  });

  it('stops at the office\'s ceiling for the day before anything is sent', async () => {
    process.env.PURCHASE_ORDER_EMAIL_DAILY_CEILING = '1';
    const { service, orderId, mail } = await order('approved');
    await service.send(buyer, orderId, email());

    await expect(service.send(buyer, orderId, email({ clientRequestId: id(91) }))).rejects.toMatchObject({ code: 'PURCHASE_ORDER_EMAIL_CEILING', message: 'The office has sent 1 of its 1 purchase order emails today. More can go tomorrow.' });
    expect(mail.sendPurchaseOrder).toHaveBeenCalledTimes(1);
  });

  it('says so when the mail provider does not take it, and leaves the order approved', async () => {
    const { service, orderId, mail, orders, deliveries } = await order('approved');
    mail.sendPurchaseOrder.mockResolvedValueOnce({ status: 'FAILED', message: '' });

    await expect(service.send(buyer, orderId, email())).rejects.toMatchObject({ code: 'PURCHASE_ORDER_EMAIL_FAILED' });
    expect(orders[0]).toMatchObject({ status: 'APPROVED', sentAt: null });
    expect(deliveries[0]).toMatchObject({ status: 'FAILED', failure: 'The mail provider did not take it.' });
  });

  it('refuses an attachment that is not a PDF, an address that is not one, and a key used for another order', async () => {
    const { service, orderId, mail, deliveries } = await order('approved');
    await expect(service.send(buyer, orderId, email({ attachment: { fileName: 'x.pdf', contentBase64: Buffer.from('<html>').toString('base64') } }))).rejects.toMatchObject({ code: 'PURCHASE_ORDER_SEND_INVALID' });
    await expect(service.send(buyer, orderId, email({ to: 'not an address' }))).rejects.toMatchObject({ code: 'PURCHASE_ORDER_SEND_INVALID' });
    expect(mail.sendPurchaseOrder).not.toHaveBeenCalled();

    deliveries.push({ id: id(599), organizationId: ORG, orderId: id(777), clientRequestId: KEY, status: 'SENT', createdAt: new Date(0) });
    await expect(service.send(buyer, orderId, email())).rejects.toMatchObject({ code: 'PURCHASE_ORDER_SEND_REUSED' });
  });
});

describe('cancelling an order', () => {
  it('needs a reason, and frees its requisition for another order', async () => {
    const { service, orderId, requisitions, audits } = await order('approved');
    await expect(service.cancel(buyer, orderId, { reason: '  ' })).rejects.toMatchObject({ code: 'PURCHASE_ORDER_REASON_NEEDED' });

    expect(await service.cancel(buyer, orderId, { reason: ' Vendor is out of stock. ' })).toMatchObject({ status: 'CANCELLED', cancelReason: 'Vendor is out of stock.', can: { edit: false, send: false, cancel: false } });
    expect(requisitions[0]).toMatchObject({ status: 'APPROVED' });
    expect(audits.slice(-2).map((audit) => audit.action)).toEqual(['PURCHASE_ORDER_CANCELLED', 'PURCHASE_REQUISITION_ORDER_CANCELLED']);
    await expect(service.cancel(buyer, orderId, { reason: 'Again' })).rejects.toMatchObject({ code: 'PURCHASE_ORDER_MOVED_ON' });

    const next = await service.createFromRequisition(buyer, REQUISITION);
    expect(next.orders[0]!.id).not.toBe(orderId);
    expect(requisitions[0]).toMatchObject({ status: 'ORDERED' });
  });
});

describe('the requests the page sends', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (body: unknown, metatype: new () => object) => pipe.transform(body, { type: 'body', metatype });

  it('name every field of their contracts', async () => {
    const saved: Required<SavePurchaseOrderInput> = terms({ notes: 'Deliver to the back door.' });
    const decision: Required<PurchaseOrderDecisionInput> = { note: 'Ask Alamo too.' };
    const cancelled: Required<CancelPurchaseOrderInput> = { reason: 'Vendor is out of stock.' };
    const sent: Required<SendPurchaseOrderInput> = { to: 'orders@hill.example', message: 'Please confirm.', attachment: { fileName: 'PO-0001.pdf', contentBase64: PDF }, clientRequestId: KEY };

    await expect(check(saved, SavePurchaseOrderDto)).resolves.toBeDefined();
    await expect(check(terms({ vendorId: null, deliverToPlaceId: null, expectedOn: null, terms: null }), SavePurchaseOrderDto)).resolves.toBeDefined();
    await expect(check(decision, PurchaseOrderDecisionDto)).resolves.toBeDefined();
    await expect(check(cancelled, CancelPurchaseOrderDto)).resolves.toBeDefined();
    await expect(check(sent, SendPurchaseOrderDto)).resolves.toBeDefined();
    const ticked: Required<MakePurchaseOrdersInput> = { lines: [{ requisitionLineId: id(41), vendorId: HILL }, { requisitionLineId: id(44), vendorId: null }] };
    await expect(check(ticked, MakePurchaseOrdersDto)).resolves.toBeDefined();
    await expect(check({ ...terms(), lines: [{ ...line(FILTER, 36, 390), placeId: STOCKROOM }] }, SavePurchaseOrderDto)).resolves.toBeDefined();
  });

  it('refuse a status, a number or an approver sent with an order, a tax rate typed as a whole number, and a send with no key', async () => {
    await expect(check({ ...terms(), status: 'APPROVED' }, SavePurchaseOrderDto)).rejects.toBeDefined();
    await expect(check({ ...terms(), number: 'PO-0001' }, SavePurchaseOrderDto)).rejects.toBeDefined();
    await expect(check({ ...terms(), approvedById: owner.id }, SavePurchaseOrderDto)).rejects.toBeDefined();
    await expect(check(terms({ taxBasisPoints: 82500 }), SavePurchaseOrderDto)).rejects.toBeDefined();
    await expect(check(terms({ lines: [line(FILTER, 0, 390)] }), SavePurchaseOrderDto)).rejects.toBeDefined();
    await expect(check({ ...email(), clientRequestId: undefined }, SendPurchaseOrderDto)).rejects.toBeDefined();
    await expect(check({ ...email(), to: 'a@example.test, b@example.test' }, SendPurchaseOrderDto)).rejects.toBeDefined();
    await expect(check({ reason: '' }, CancelPurchaseOrderDto)).rejects.toBeDefined();
    await expect(check({ lines: [] }, MakePurchaseOrdersDto)).rejects.toBeDefined();
    await expect(check({ lines: [{ requisitionLineId: id(41), vendorId: HILL, quantity: 5 }] }, MakePurchaseOrdersDto)).rejects.toBeDefined();
  });
});

describe('who may do what', () => {
  const permissionsOf = (name: string) => Reflect.getMetadata('permissions', (PurchaseOrdersController.prototype as unknown as Record<string, object>)[name]!) as string[];

  it('reads with purchasing:request, buys with purchasing:order, and approves orders with purchasing:approve-orders (the purchasing manager, 2026-11-21)', () => {
    for (const read of ['list', 'detail']) expect(permissionsOf(read)).toEqual(['purchasing:request']);
    for (const buys of ['create', 'pendingLines', 'makeOrders', 'update', 'submit', 'cancel', 'send']) expect(permissionsOf(buys)).toEqual(['purchasing:request', 'purchasing:order']);
    for (const decides of ['approve', 'sendBack']) expect(permissionsOf(decides)).toEqual(['purchasing:request', 'purchasing:approve-orders']);
  });

  it('never lets an API key make or send an order', () => {
    expect(MACHINE_FORBIDDEN_PERMISSIONS).toContain('purchasing:order');
  });
});

describe('companies and limits on orders (Purchasing Setup, 2026-11-21)', () => {
  const only = (tenant: string, over: Record<string, unknown> = {}) => ({ companyTenantIds: [tenant], approvesAnyAmount: false, approvalLimitCents: null, ...over });

  it('lets a purchaser limited to other companies neither make nor change this one', async () => {
    const made = database();
    made.db.purchasingPerson.findUnique.mockResolvedValue(only('tenant-elsewhere'));
    await expect(made.service.createFromRequisition(buyer, REQUISITION)).rejects.toMatchObject({ code: 'PURCHASE_ORDER_COMPANY_NOT_YOURS', message: "You order only for your own companies, and this is another company's." });

    const { db, service, orderId } = await order('approved');
    db.purchasingPerson.findUnique.mockResolvedValue(only('tenant-elsewhere'));
    expect((await service.detail(buyer, orderId)).can).toMatchObject({ change: false, send: false, cancel: false });
    await expect(service.update(buyer, orderId, terms({ lines: [line(FILTER, 30, 390)] }))).rejects.toMatchObject({ code: 'PURCHASE_ORDER_COMPANY_NOT_YOURS' });
    await expect(service.cancel(buyer, orderId, { reason: 'Not ours.' })).rejects.toMatchObject({ code: 'PURCHASE_ORDER_COMPANY_NOT_YOURS' });
  });

  it("lets an approver decide only their own companies' orders, and never above their own limit", async () => {
    const elsewhere = await order('waiting');
    elsewhere.db.purchasingPerson.findUnique.mockResolvedValue(only('tenant-elsewhere'));
    expect((await elsewhere.service.detail(manager, elsewhere.orderId)).can).toMatchObject({ approve: false, sendBack: false });
    await expect(elsewhere.service.decide(manager, elsewhere.orderId, 'SENT_BACK', { note: 'No' })).rejects.toMatchObject({ code: 'PURCHASE_ORDER_COMPANY_NOT_YOURS' });

    // $200.05 with tax, over a $150.00 limit.
    const capped = await order('waiting');
    capped.db.purchasingPerson.findUnique.mockResolvedValue(only('tenant-thmp', { approvalLimitCents: 15000 }));
    expect((await capped.service.detail(manager, capped.orderId)).can.approveBlocked).toBe('At $200.05 it is above your approval limit of $150.00.');
    await expect(capped.service.decide(manager, capped.orderId, 'APPROVED', {})).rejects.toMatchObject({ code: 'PURCHASE_ORDER_OVER_LIMIT' });
  });
});
