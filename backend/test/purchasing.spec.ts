import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { MACHINE_FORBIDDEN_PERMISSIONS, type RequisitionDecisionInput, type SavePurchasingSettingsInput, type SaveRequisitionInput } from '@texasrenters/shared';

import { PurchasingController, RequisitionDecisionDto, SavePurchasingSettingsDto, SaveRequisitionDto } from '../src/admin/purchasing.controller';
import { PurchasingService } from '../src/admin/purchasing.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Purchase requisitions, phase 2 (2026-11-19). Every id, name, code and price
 * here is invented. The database below holds requisitions the way the service
 * reads and writes them; what only the real database does (refusing a decision
 * by the requester, a second chosen quote, a number used twice) is in the
 * migration and is not exercised here.
 */

const ORG = '80000000-0000-4000-8000-000000000001';
const OTHER_ORG = '80000000-0000-4000-8000-000000000002';
const THMP = 'tenant-thmp';
const PEST = 'tenant-pest';
const id = (n: number) => `80000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`;
const FILTER = id(1);
const BATTERY = id(2);
const GLUE = id(3);
const OLD = id(4);
const STOCKROOM = id(11);
const HILL = id(21);
const ALAMO = id(22);

const person = (n: number, displayName: string, permissions: string[], organizationId = ORG): AuthenticatedUser =>
  ({ id: id(900 + n), authUserId: `auth-${n}`, organizationId, displayName, roles: [UserRole.INSPECTION_SUPERVISOR], permissions, mustChangePassword: false, principalType: 'USER' }) as AuthenticatedUser;
const asker = person(1, 'Sample Requester', ['purchasing:request']);
const colleague = person(2, 'Another Requester', ['purchasing:request']);
const manager = person(3, 'Sample Manager', ['purchasing:request', 'purchasing:approve']);
const owner = person(4, 'Sample Owner', ['purchasing:request', 'purchasing:approve', 'purchasing:approve-any']);
const outsider = person(5, 'Other Office', ['purchasing:request', 'purchasing:approve', 'purchasing:approve-any'], OTHER_ORG);
const PEOPLE = [asker, colleague, manager, owner, outsider];

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (key === 'AND') return (value as Where[]).every((part) => matches(row, part));
    if (key === 'OR') return (value as Where[]).some((part) => matches(row, part));
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      const rule = value as { in?: unknown[]; notIn?: unknown[]; not?: unknown };
      if (rule.in) return rule.in.includes(row[key]);
      if (rule.notIn) return !rule.notIn.includes(row[key]);
      if ('not' in rule) return row[key] !== rule.not;
    }
    return row[key] === value;
  });
}

function database() {
  const items: Row[] = [
    { id: FILTER, organizationId: ORG, code: 'FLT-20251', codeKey: 'flt-20251', name: 'Filter 20x25x1', unit: 'each', xeroTenantId: THMP, reorderLevel: 18, reorderQuantity: 36, active: true },
    { id: BATTERY, organizationId: ORG, code: 'BAT-9V', codeKey: 'bat-9v', name: 'Battery, 9 V', unit: 'each', xeroTenantId: THMP, reorderLevel: 12, reorderQuantity: 24, active: true },
    { id: GLUE, organizationId: ORG, code: 'PST-GLUE', codeKey: 'pst-glue', name: 'Glue boards', unit: 'pack', xeroTenantId: PEST, reorderLevel: 8, reorderQuantity: 12, active: true },
    { id: OLD, organizationId: ORG, code: 'OLD-1', codeKey: 'old-1', name: 'Discontinued filter', unit: 'each', xeroTenantId: THMP, reorderLevel: 0, reorderQuantity: 0, active: false },
  ];
  const levels = [{ itemId: BATTERY, _sum: { quantity: 5, valueCents: 925 } }];
  const vendors: Row[] = [
    { id: HILL, organizationId: ORG, name: 'Hill Country Supply', active: true },
    { id: ALAMO, organizationId: ORG, name: 'Alamo Trade Parts', active: true },
    { id: id(23), organizationId: OTHER_ORG, name: 'Their vendor', active: true },
  ];
  const requisitions: Row[] = [];
  const lines: Row[] = [];
  const quotes: Row[] = [];
  const audits: Row[] = [];
  const settings: Row[] = [];
  let series = 0;
  let clock = Date.parse('2026-11-19T15:00:00.000Z');

  const whole = (requisition: Row) => ({
    ...requisition,
    requestedBy: { displayName: PEOPLE.find((one) => one.id === requisition.requestedById)!.displayName },
    decidedBy: requisition.decidedById ? { displayName: PEOPLE.find((one) => one.id === requisition.decidedById)!.displayName } : null,
    deliverTo: requisition.deliverToPlaceId ? { id: STOCKROOM, name: 'Stockroom' } : null,
    lines: lines
      .filter((line) => line.requisitionId === requisition.id)
      .sort((left, right) => (left.position as number) - (right.position as number))
      .map((line) => ({ ...line, item: items.find((item) => item.id === line.itemId) ?? null })),
    quotes: quotes.filter((quote) => quote.requisitionId === requisition.id).map((quote) => ({ ...quote, vendor: vendors.find((vendor) => vendor.id === quote.vendorId) })),
  });

  const db = {
    purchaseRequisition: {
      findMany: jest.fn(async ({ where }: { where: Where }) => requisitions.filter((row) => matches(row, where)).map(whole).reverse()),
      findFirst: jest.fn(async ({ where }: { where: Where }) => {
        const found = requisitions.find((row) => matches(row, where));
        return found ? whole(found) : null;
      }),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: id(100 + requisitions.length), number: null, status: 'DRAFT', submittedAt: null, decidedById: null, decidedAt: null, decisionNote: null, createdAt: new Date((clock += 1000)), ...data };
        requisitions.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Row }) => {
        const found = requisitions.filter((row) => matches(row, where));
        for (const row of found) Object.assign(row, data);
        return { count: found.length };
      }),
    },
    purchaseRequisitionLine: {
      createMany: jest.fn(async ({ data }: { data: Row[] }) => lines.push(...data.map((line, index) => ({ id: id(300 + lines.length + index), ...line })))),
      deleteMany: jest.fn(async ({ where }: { where: Where }) => {
        for (let index = lines.length - 1; index >= 0; index -= 1) if (matches(lines[index]!, where)) lines.splice(index, 1);
      }),
    },
    purchaseRequisitionQuote: {
      createMany: jest.fn(async ({ data }: { data: Row[] }) => quotes.push(...data.map((quote, index) => ({ id: id(400 + quotes.length + index), ...quote })))),
      deleteMany: jest.fn(async ({ where }: { where: Where }) => {
        for (let index = quotes.length - 1; index >= 0; index -= 1) if (matches(quotes[index]!, where)) quotes.splice(index, 1);
      }),
    },
    stockItem: { findMany: jest.fn(async ({ where }: { where: Where }) => items.filter((row) => matches(row, where))) },
    stockLevel: { groupBy: jest.fn(async () => levels) },
    stockPlace: {
      findFirst: jest.fn(async ({ where }: { where: Where }) => (where.id === STOCKROOM && where.organizationId === ORG ? { id: STOCKROOM } : null)),
      findMany: jest.fn(async () => [{ id: STOCKROOM, name: 'Stockroom' }]),
    },
    vendor: {
      count: jest.fn(async ({ where }: { where: Where }) => vendors.filter((row) => matches(row, where)).length),
      findMany: jest.fn(async ({ where }: { where: Where }) => vendors.filter((row) => matches(row, where))),
    },
    xeroOrganisation: {
      findMany: jest.fn(async () => [{ xeroTenantId: PEST, name: 'Crystal Creek Pest', status: 'CONNECTED' }, { xeroTenantId: THMP, name: 'THMP', status: 'CONNECTED' }]),
      findFirst: jest.fn(async ({ where }: { where: Where }) => ([THMP, PEST].includes(where.xeroTenantId as string) && where.organizationId === ORG ? { id: 'x' } : null)),
    },
    purchasingSettings: {
      findUnique: jest.fn(async ({ where }: { where: Where }) => settings.find((row) => row.organizationId === where.organizationId) ?? null),
      upsert: jest.fn(async ({ create, update }: { create: Row; update: Row }) => {
        const found = settings.find((row) => row.organizationId === create.organizationId);
        if (found) Object.assign(found, update);
        else settings.push({ ...create });
      }),
    },
    userProfile: { findMany: jest.fn(async () => PEOPLE.map((one) => ({ id: one.id, displayName: one.displayName }))) },
    auditLog: {
      create: jest.fn(async ({ data }: { data: Row }) => audits.push({ createdAt: new Date((clock += 1000)), ...data })),
      findMany: jest.fn(async ({ where }: { where: Where }) => audits.filter((row) => matches(row, where)).reverse()),
    },
    $queryRaw: jest.fn(async () => [{ taken: (series += 1) }]),
  };
  const transaction = { $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => work(client)) };
  const client: unknown = Object.assign(db, transaction);
  return { db, requisitions, lines, quotes, audits, service: new PurchasingService(db as never) };
}

const line = (itemId: string | null, quantity: number, estimatedUnitCostCents: number, description: string | null = null) => ({ itemId, description, quantity, estimatedUnitCostCents });
/** $140.40 + $44.40 = $184.80: under the $500.00 limit. */
const small = (over: Partial<SaveRequisitionInput> = {}): SaveRequisitionInput => ({
  xeroTenantId: THMP,
  neededBy: '2026-11-24',
  deliverToPlaceId: STOCKROOM,
  reason: 'Filters are out and next week has 14 inspections booked.',
  lines: [line(FILTER, 36, 390), line(BATTERY, 24, 185)],
  quotes: [],
  ...over,
});
/** $612.00: above the limit. */
const large = (over: Partial<SaveRequisitionInput> = {}): SaveRequisitionInput =>
  small({ lines: [line(null, 40, 1530, 'Smoke alarm, 10-year')], quotes: [{ vendorId: HILL, totalCents: 61200, delivery: '3 days', chosen: true }, { vendorId: ALAMO, totalCents: 64000, delivery: null, chosen: false }], ...over });

describe('a requisition', () => {
  it('starts as its author\'s draft, with what is on hand beside each item', async () => {
    const { service, audits } = database();
    const draft = await service.create(asker, small());

    expect(draft).toMatchObject({ status: 'DRAFT', number: null, requestedBy: { name: 'Sample Requester' }, company: { name: 'THMP' }, neededBy: '2026-11-24', estimatedTotalCents: 18480, lineCount: 2 });
    expect(draft.summary).toBe('Filter 20x25x1 × 36, Battery, 9 V × 24');
    expect(draft.lines.map((one) => [one.item?.code, one.onHand, one.reorderLevel])).toEqual([['FLT-20251', 0, 18], ['BAT-9V', 5, 12]]);
    expect(draft.can).toMatchObject({ edit: true, submit: true, cancel: true, approve: false, sendBack: false, reject: false });
    expect(audits).toEqual([expect.objectContaining({ action: 'PURCHASE_REQUISITION_CREATED', actorUserId: asker.id, entityType: 'PurchaseRequisition', entityId: draft.id })]);
  });

  it('is seen by nobody else while it is a draft, and by approvers once submitted', async () => {
    const { service } = database();
    const draft = await service.create(asker, small());

    expect((await service.list(asker)).requisitions.map((one) => one.id)).toEqual([draft.id]);
    for (const other of [colleague, manager, owner]) {
      expect((await service.list(other)).requisitions).toEqual([]);
      await expect(service.detail(other, draft.id)).rejects.toMatchObject({ code: 'REQUISITION_NOT_FOUND' });
    }

    await service.submit(asker, draft.id);
    expect(await service.list(manager)).toMatchObject({ seesAll: true, requisitions: [{ id: draft.id, status: 'SUBMITTED' }] });
    expect(await service.list(colleague)).toMatchObject({ seesAll: false, requisitions: [] });
    await expect(service.detail(colleague, draft.id)).rejects.toMatchObject({ code: 'REQUISITION_NOT_FOUND' });
    await expect(service.detail(outsider, draft.id)).rejects.toMatchObject({ code: 'REQUISITION_NOT_FOUND' });
  });

  it('takes the office\'s next number when first submitted, and keeps it', async () => {
    const { service } = database();
    const first = await service.create(asker, small());
    const second = await service.create(colleague, small());

    expect(await service.submit(colleague, second.id)).toMatchObject({ number: 'PR-0001', status: 'SUBMITTED' });
    expect(await service.submit(asker, first.id)).toMatchObject({ number: 'PR-0002' });

    await service.decide(manager, first.id, 'SENT_BACK', { note: 'Which model?' });
    expect(await service.submit(asker, first.id)).toMatchObject({ number: 'PR-0002', status: 'SUBMITTED', decisionNote: null });
  });

  it('cannot be submitted without a reason, without a line, or by anybody but its author', async () => {
    const { service } = database();
    const draft = await service.create(asker, small({ reason: '  ' }));
    await expect(service.submit(asker, draft.id)).rejects.toMatchObject({ code: 'REQUISITION_NOT_READY', message: 'Say why it is needed.' });

    await service.update(asker, draft.id, small({ lines: [] }));
    await expect(service.submit(asker, draft.id)).rejects.toMatchObject({ code: 'REQUISITION_NOT_READY', message: 'Add at least one item.' });

    await service.update(asker, draft.id, small());
    await expect(service.submit(manager, draft.id)).rejects.toMatchObject({ code: 'REQUISITION_NOT_FOUND' });
    await expect(service.update(colleague, draft.id, small())).rejects.toMatchObject({ code: 'REQUISITION_NOT_FOUND' });
  });

  it('is fixed once submitted, and opens again for its author when it is sent back', async () => {
    const { service, lines } = database();
    const draft = await service.create(asker, small());
    await service.submit(asker, draft.id);

    await expect(service.update(asker, draft.id, small({ lines: [line(FILTER, 500, 390)] }))).rejects.toMatchObject({ code: 'REQUISITION_FIXED' });
    expect(lines.map((one) => one.quantity)).toEqual([36, 24]);
    await expect(service.submit(asker, draft.id)).rejects.toMatchObject({ code: 'REQUISITION_MOVED_ON' });

    await service.decide(manager, draft.id, 'SENT_BACK', { note: 'Fewer batteries.' });
    const changed = await service.update(asker, draft.id, small({ lines: [line(FILTER, 36, 390), line(BATTERY, 12, 185)] }));
    expect(changed).toMatchObject({ status: 'SENT_BACK', estimatedTotalCents: 16260, decisionNote: 'Fewer batteries.' });
    expect(lines.map((one) => one.quantity)).toEqual([36, 12]);
  });

  it('above the limit needs its quotes, with one chosen', async () => {
    const { service } = database();
    const none = await service.create(asker, large({ quotes: [] }));
    await expect(service.submit(asker, none.id)).rejects.toMatchObject({ code: 'REQUISITION_NOT_READY', message: 'Above the approval limit, 2 quotes are needed.' });

    const unchosen = await service.create(asker, large({ quotes: [{ vendorId: HILL, totalCents: 61200, delivery: null, chosen: false }, { vendorId: ALAMO, totalCents: 64000, delivery: null, chosen: false }] }));
    await expect(service.submit(asker, unchosen.id)).rejects.toMatchObject({ message: 'Mark one quote as the chosen one.' });

    const ready = await service.create(asker, large());
    expect(await service.submit(asker, ready.id)).toMatchObject({ status: 'SUBMITTED', quoteCount: 2 });
  });

  it('names only what is this office\'s, and items of its own company', async () => {
    const { service, requisitions } = database();
    const refused = async (over: Partial<SaveRequisitionInput>, code: string) => expect(service.create(asker, small(over))).rejects.toMatchObject({ code });

    await refused({ lines: [line(GLUE, 12, 910)] }, 'REQUISITION_ITEM_OTHER_COMPANY');
    await refused({ lines: [line(OLD, 1, 100)] }, 'REQUISITION_ITEM_NOT_FOUND');
    await refused({ lines: [line(id(77), 1, 100)] }, 'REQUISITION_ITEM_NOT_FOUND');
    await refused({ lines: [line(FILTER, 1, 390), line(FILTER, 2, 390)] }, 'REQUISITION_ITEM_TWICE');
    await refused({ lines: [line(null, 1, 100, '   ')] }, 'REQUISITION_LINE_UNNAMED');
    await refused({ xeroTenantId: 'tenant-of-another-office' }, 'REQUISITION_COMPANY_NOT_FOUND');
    await refused({ deliverToPlaceId: id(78) }, 'REQUISITION_PLACE_NOT_FOUND');
    await refused({ quotes: [{ vendorId: id(23), totalCents: 1, delivery: null, chosen: true }] }, 'VENDOR_NOT_FOUND');
    await refused({ quotes: [{ vendorId: HILL, totalCents: 1, delivery: null, chosen: true }, { vendorId: ALAMO, totalCents: 2, delivery: null, chosen: true }] }, 'REQUISITION_QUOTES_CHOSEN');
    expect(requisitions).toHaveLength(0);
  });

  it('is cancelled by its author, until it is decided', async () => {
    const { service } = database();
    const one = await service.create(asker, small());
    await service.submit(asker, one.id);
    await expect(service.cancel(manager, one.id)).rejects.toMatchObject({ code: 'REQUISITION_NOT_FOUND' });
    expect(await service.cancel(asker, one.id)).toMatchObject({ status: 'CANCELLED', can: { edit: false, submit: false, cancel: false } });

    const two = await service.create(asker, small());
    await service.submit(asker, two.id);
    await service.decide(manager, two.id, 'APPROVED', {});
    await expect(service.cancel(asker, two.id)).rejects.toMatchObject({ code: 'REQUISITION_MOVED_ON' });
  });
});

describe('deciding a requisition', () => {
  const waiting = async (who: AuthenticatedUser, input: SaveRequisitionInput) => {
    const made = database();
    const draft = await made.service.create(who, input);
    await made.service.submit(who, draft.id);
    return { ...made, requisitionId: draft.id };
  };

  it('is never done by whoever asked, whatever else they may do', async () => {
    const { service, requisitionId, requisitions } = await waiting(owner, small());

    expect((await service.detail(owner, requisitionId)).can).toMatchObject({ approve: false, sendBack: false, reject: false, approveBlocked: 'You asked for this, so somebody else approves it.' });
    for (const decision of ['APPROVED', 'SENT_BACK', 'REJECTED'] as const)
      await expect(service.decide(owner, requisitionId, decision, { note: 'Mine' })).rejects.toMatchObject({ code: 'REQUISITION_OWN' });
    expect(requisitions[0]).toMatchObject({ status: 'SUBMITTED', decidedById: null });
  });

  it('approves under the limit with Approve requisitions, once', async () => {
    const { service, requisitionId, audits } = await waiting(asker, small());
    expect((await service.detail(manager, requisitionId)).can).toMatchObject({ approve: true, sendBack: true, reject: true, approveBlocked: null, edit: false });

    const approved = await service.decide(manager, requisitionId, 'APPROVED', {});
    expect(approved).toMatchObject({ status: 'APPROVED', decidedBy: 'Sample Manager', can: { approve: false } });
    expect(audits.at(-1)).toMatchObject({ action: 'PURCHASE_REQUISITION_APPROVED', actorUserId: manager.id, metadata: expect.objectContaining({ totalCents: 18480 }) });
    await expect(service.decide(owner, requisitionId, 'REJECTED', { note: 'Too late' })).rejects.toMatchObject({ code: 'REQUISITION_MOVED_ON' });
  });

  it('approves above the limit only with Approve any amount', async () => {
    const { service, requisitionId } = await waiting(asker, large());

    expect((await service.detail(manager, requisitionId)).can).toMatchObject({
      approve: false,
      sendBack: true,
      approveBlocked: 'It is above the $500.00 approval limit, so it needs somebody who may approve any amount.',
    });
    await expect(service.decide(manager, requisitionId, 'APPROVED', {})).rejects.toMatchObject({ code: 'REQUISITION_OVER_LIMIT' });
    expect(await service.decide(owner, requisitionId, 'APPROVED', {})).toMatchObject({ status: 'APPROVED', decidedBy: 'Sample Owner' });
  });

  it('sends back or rejects only with a note, which the requester reads', async () => {
    const { service, requisitionId } = await waiting(asker, small());
    await expect(service.decide(manager, requisitionId, 'SENT_BACK', { note: '  ' })).rejects.toMatchObject({ code: 'REQUISITION_NOTE_NEEDED' });
    await expect(service.decide(manager, requisitionId, 'REJECTED', {})).rejects.toMatchObject({ code: 'REQUISITION_NOTE_NEEDED' });

    await service.decide(manager, requisitionId, 'REJECTED', { note: ' Not stock. Buy on the office card. ' });
    const seen = await service.detail(asker, requisitionId);
    expect(seen).toMatchObject({ status: 'REJECTED', decisionNote: 'Not stock. Buy on the office card.', can: { edit: false, submit: false, cancel: false } });
    expect(seen.history.map((entry) => `${entry.by} ${entry.what}`)).toEqual([
      'Sample Manager rejected it: Not stock. Buy on the office card.',
      'Sample Requester submitted it',
      'Sample Requester started it',
    ]);
  });

  it('is refused to somebody who only makes requisitions, and to another office', async () => {
    const { service, requisitionId } = await waiting(asker, small());
    // The route asks for purchasing:approve; a caller without it has nothing to decide here either way.
    expect((await service.list(colleague)).requisitions).toEqual([]);
    await expect(service.decide(outsider, requisitionId, 'APPROVED', {})).rejects.toMatchObject({ code: 'REQUISITION_NOT_FOUND' });
  });
});

describe('the limits and the form\'s choices', () => {
  it('start at $500.00 and two quotes, and are changed with an audit entry', async () => {
    const { service, audits } = database();
    expect((await service.list(asker)).settings).toEqual({ approvalLimitCents: 50000, quotesAboveLimit: 2 });

    expect(await service.saveSettings(owner, { approvalLimitCents: 100000, quotesAboveLimit: 3 })).toEqual({ approvalLimitCents: 100000, quotesAboveLimit: 3 });
    expect(audits).toEqual([expect.objectContaining({ action: 'PURCHASING_SETTINGS_CHANGED', actorUserId: owner.id, metadata: { from: { approvalLimitCents: 50000, quotesAboveLimit: 2 }, to: { approvalLimitCents: 100000, quotesAboveLimit: 3 } } })]);

    await service.saveSettings(owner, { approvalLimitCents: 100000, quotesAboveLimit: 3 });
    expect(audits).toHaveLength(1);
  });

  it('move what a manager may approve', async () => {
    const { service } = database();
    const draft = await service.create(asker, large());
    await service.saveSettings(owner, { approvalLimitCents: 100000, quotesAboveLimit: 2 });
    await service.submit(asker, draft.id);
    expect(await service.decide(manager, draft.id, 'APPROVED', {})).toMatchObject({ status: 'APPROVED' });
  });

  it('offer the items in use with what is on hand and what one cost', async () => {
    const { service } = database();
    const choices = await service.choices(asker);

    expect(choices.items.map((item) => item.code)).toEqual(['FLT-20251', 'BAT-9V', 'PST-GLUE']);
    expect(choices.items[1]).toMatchObject({ onHand: 5, averageCostCents: 185, companyTenantId: THMP, reorderQuantity: 24 });
    expect(choices.items[0]).toMatchObject({ onHand: 0, averageCostCents: null });
    expect(choices.vendors.map((vendor) => vendor.name)).toEqual(['Hill Country Supply', 'Alamo Trade Parts']);
  });
});

describe('the requests the page sends', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (body: unknown, metatype: new () => object) => pipe.transform(body, { type: 'body', metatype });

  it('name every field of their contracts', async () => {
    const requisition: Required<SaveRequisitionInput> = large();
    const decision: Required<RequisitionDecisionInput> = { note: 'Which model?' };
    const limits: Required<SavePurchasingSettingsInput> = { approvalLimitCents: 50000, quotesAboveLimit: 2 };

    await expect(check(requisition, SaveRequisitionDto)).resolves.toBeDefined();
    await expect(check(small({ xeroTenantId: null, neededBy: null, deliverToPlaceId: null }), SaveRequisitionDto)).resolves.toBeDefined();
    await expect(check(decision, RequisitionDecisionDto)).resolves.toBeDefined();
    await expect(check({}, RequisitionDecisionDto)).resolves.toBeDefined();
    await expect(check(limits, SavePurchasingSettingsDto)).resolves.toBeDefined();
  });

  it('refuse a status or a number sent with a requisition, none of an item, and a part of one', async () => {
    await expect(check({ ...small(), status: 'APPROVED' }, SaveRequisitionDto)).rejects.toBeDefined();
    await expect(check({ ...small(), number: 'PR-0001' }, SaveRequisitionDto)).rejects.toBeDefined();
    await expect(check({ ...small(), requestedById: manager.id }, SaveRequisitionDto)).rejects.toBeDefined();
    await expect(check(small({ lines: [line(FILTER, 0, 390)] }), SaveRequisitionDto)).rejects.toBeDefined();
    await expect(check(small({ lines: [line(FILTER, 1.5, 390)] }), SaveRequisitionDto)).rejects.toBeDefined();
    await expect(check(small({ lines: [{ ...line(FILTER, 1, 390), approved: true } as never] }), SaveRequisitionDto)).rejects.toBeDefined();
    await expect(check({ approvalLimitCents: -1, quotesAboveLimit: 2 }, SavePurchasingSettingsDto)).rejects.toBeDefined();
  });
});

describe('who may do what', () => {
  const permissionsOf = (name: string) => Reflect.getMetadata('permissions', (PurchasingController.prototype as unknown as Record<string, object>)[name]!) as string[];

  it('opens Purchasing with purchasing:request, decides with purchasing:approve, and sets the limits with approve-any', () => {
    for (const own of ['list', 'choices', 'create', 'detail', 'update', 'submit', 'cancel']) expect(permissionsOf(own)).toEqual(['purchasing:request']);
    for (const decision of ['approve', 'sendBack', 'reject']) expect(permissionsOf(decision)).toEqual(['purchasing:request', 'purchasing:approve']);
    expect(permissionsOf('saveSettings')).toEqual(['purchasing:request', 'purchasing:approve', 'purchasing:approve-any']);
  });

  it('never lets an API key ask for or approve a purchase', () => {
    expect(MACHINE_FORBIDDEN_PERMISSIONS).toEqual(expect.arrayContaining(['purchasing:request', 'purchasing:approve', 'purchasing:approve-any']));
  });
});
