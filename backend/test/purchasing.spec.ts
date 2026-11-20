import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { DEFAULT_FILE_RULES, DEFAULT_PAGE_LAYOUT, MACHINE_FORBIDDEN_PERMISSIONS, stepsFromLimit, type RequisitionDecisionInput, type SaveRequisitionInput } from '@texasrenters/shared';

import { AddRequisitionLinkDto, PurchasingController, RequisitionDecisionDto, SaveRequisitionDto, SetRequisitionFileDto } from '../src/admin/purchasing.controller';
import { PurchasingSetupService } from '../src/admin/purchasing-setup.service';
import { PurchasingService } from '../src/admin/purchasing.service';
import { sniffRequisitionFile } from '../src/admin/requisition-files';
import { RequisitionFilesService } from '../src/admin/requisition-files.service';
import { RequisitionNotesService } from '../src/admin/requisition-notes.service';
import type { AuthenticatedUser } from '../src/common/auth';
import { businessDate } from '../src/common/business-day';

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
const ALARM = id(5);
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
const buyer = person(6, 'Sample Purchaser', ['purchasing:request', 'purchasing:order']);
const PEOPLE = [asker, colleague, manager, owner, outsider, buyer];

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
    { id: FILTER, organizationId: ORG, code: 'FLT-20251', codeKey: 'flt-20251', name: 'Filter 20x25x1', unit: 'each', xeroTenantId: THMP, reorderLevel: 18, reorderQuantity: 36, priceCents: 425, active: true },
    { id: BATTERY, organizationId: ORG, code: 'BAT-9V', codeKey: 'bat-9v', name: 'Battery, 9 V', unit: 'each', xeroTenantId: THMP, reorderLevel: 12, reorderQuantity: 24, active: true },
    { id: GLUE, organizationId: ORG, code: 'PST-GLUE', codeKey: 'pst-glue', name: 'Glue boards', unit: 'pack', xeroTenantId: PEST, reorderLevel: 8, reorderQuantity: 12, active: true },
    { id: ALARM, organizationId: ORG, code: 'SMK-0001', codeKey: 'smk-0001', name: 'Smoke alarm, 10-year', unit: 'each', xeroTenantId: THMP, reorderLevel: 6, reorderQuantity: 12, active: true },
    { id: OLD, organizationId: ORG, code: 'OLD-1', codeKey: 'old-1', name: 'Discontinued filter', unit: 'each', xeroTenantId: THMP, reorderLevel: 0, reorderQuantity: 0, active: false },
  ];
  const levels = [{ itemId: BATTERY, _sum: { quantity: 5, valueCents: 925 } }];
  // Where it is (2026-11-20): the batteries are all in the stockroom.
  const placeLevels = [{ itemId: BATTERY, placeId: STOCKROOM, quantity: 5, valueCents: 925 }];
  const codes: Row[] = [
    { id: id(51), organizationId: ORG, kind: 'REQUEST', code: 'RESTOCK', name: 'Restock the storeroom', active: true, keepsStock: true },
    { id: id(52), organizationId: ORG, kind: 'COST_CENTER', code: 'MAINT', name: 'Maintenance', active: true, keepsStock: true },
    { id: id(53), organizationId: ORG, kind: 'DEPARTMENT', code: 'HVAC', name: 'HVAC', active: true, keepsStock: true },
    { id: id(54), organizationId: ORG, kind: 'REQUEST', code: 'OLD', name: 'Old kind', active: false, keepsStock: true },
    { id: id(55), organizationId: ORG, kind: 'LINE_TYPE', code: 'ITEM', name: 'Item', active: true, keepsStock: true },
    { id: id(56), organizationId: OTHER_ORG, kind: 'REQUEST', code: 'THEIRS', name: 'Theirs', active: true, keepsStock: true },
  ];
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
  /** Approval steps saved in Purchasing Setup (2026-11-20): none until a test saves some. */
  /** People's companies and limits (2026-11-21). */
  const persons: Row[] = [];
  const steps: Row[] = [];
  /** Files attached (2026-11-20). */
  const files: Row[] = [];
  /** Notes, comments and links (2026-11-20). */
  const notes: Row[] = [];
  const links: Row[] = [];
  /** Live orders made from requisitions, by requisition: none unless a test says so. */
  const liveOrders: Row[] = [];
  let series = 0;
  let clock = Date.parse('2026-11-19T15:00:00.000Z');

  const whole = (requisition: Row) => ({
    ...requisition,
    requestedBy: { displayName: PEOPLE.find((one) => one.id === requisition.requestedById)!.displayName },
    decidedBy: requisition.decidedById ? { displayName: PEOPLE.find((one) => one.id === requisition.decidedById)!.displayName } : null,
    deliverTo: requisition.deliverToPlaceId ? { id: STOCKROOM, name: 'Stockroom', code: 'STORE' } : null,
    requestCode: codes.find((code) => code.id === requisition.requestCodeId) ?? null,
    costCenter: codes.find((code) => code.id === requisition.costCenterId) ?? null,
    lines: lines
      .filter((line) => line.requisitionId === requisition.id)
      .sort((left, right) => (left.position as number) - (right.position as number))
      .map((line) => ({
        expectedOn: null,
        notes: null,
        ...line,
        item: items.find((item) => item.id === line.itemId) ?? null,
        place: line.placeId ? { id: STOCKROOM, code: 'STORE', name: 'Stockroom' } : null,
        vendor: vendors.find((vendor) => vendor.id === line.vendorId) ?? null,
        department: codes.find((code) => code.id === line.departmentId) ?? null,
      })),
    quotes: quotes.filter((quote) => quote.requisitionId === requisition.id).map((quote) => ({ ...quote, vendor: vendors.find((vendor) => vendor.id === quote.vendorId) })),
    files: files.filter((file) => file.requisitionId === requisition.id),
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
    // No order has been made from any of these.
    purchaseOrder: {
      findFirst: jest.fn(async () => null),
      count: jest.fn(async ({ where }: { where: Where }) => liveOrders.filter((row) => row.requisitionId === where.requisitionId).length),
      // Its live orders, one a vendor (2026-11-20).
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        liveOrders.filter((row) => row.requisitionId === where.requisitionId).map((row, n) => ({ id: `order-${n}`, number: null, status: 'DRAFT', vendorId: row.vendorId ?? null, vendor: vendors.find((vendor) => vendor.id === row.vendorId) ?? null })),
      ),
    },
    // Who it is from, for its PDF.
    invoiceSettings: { findUnique: jest.fn(async () => ({ companyName: 'Example Office', addressLine1: '1 Example Plaza', addressLine2: null, phone: null, email: null })) },
    stockItem: { findMany: jest.fn(async ({ where }: { where: Where }) => items.filter((row) => matches(row, where))), count: jest.fn(async () => items.length) },
    stockLevel: { groupBy: jest.fn(async () => levels), findMany: jest.fn(async () => placeLevels) },
    stockPlace: {
      findFirst: jest.fn(async ({ where }: { where: Where }) => (where.id === STOCKROOM && where.organizationId === ORG ? { id: STOCKROOM } : null)),
      findMany: jest.fn(async () => [{ id: STOCKROOM, name: 'Stockroom', code: 'STORE' }]),
      // Places named on a requisition, or (Setup's Codes section) all in use.
      count: jest.fn(async ({ where }: { where: { organizationId: string; id?: { in: string[] } } }) => (where.organizationId !== ORG ? 0 : where.id ? where.id.in.filter((one) => one === STOCKROOM).length : 1)),
    },
    stockCategory: { findMany: jest.fn(async () => [{ id: id(61), name: 'Filters' }]), count: jest.fn(async () => 1) },
    purchasingCode: {
      groupBy: jest.fn(async () => []),
      findFirst: jest.fn(async ({ where }: { where: Where }) => codes.find((row) => matches(row, where)) ?? null),
      findMany: jest.fn(async ({ where }: { where: Where }) => codes.filter((row) => matches(row, where))),
    },
    // One order still to come for the filters, and an older one that came.
    purchaseOrderLine: {
      findMany: jest.fn(async () => [
        { itemId: FILTER, quantity: 36, receivedQuantity: 12, order: { number: 'PO-0007', status: 'PARTLY_RECEIVED', createdAt: new Date('2026-11-18') } },
        { itemId: FILTER, quantity: 24, receivedQuantity: 24, order: { number: 'PO-0003', status: 'RECEIVED', createdAt: new Date('2026-11-10') } },
      ]),
    },
    vendor: {
      count: jest.fn(async ({ where }: { where: Where }) => vendors.filter((row) => matches(row, where)).length),
      findMany: jest.fn(async ({ where }: { where: Where }) => vendors.filter((row) => matches(row, where))),
    },
    xeroOrganisation: {
      count: jest.fn(async () => 2),
      findMany: jest.fn(async () => [{ xeroTenantId: PEST, name: 'Crystal Creek Pest', status: 'CONNECTED' }, { xeroTenantId: THMP, name: 'THMP', status: 'CONNECTED' }]),
      findFirst: jest.fn(async ({ where }: { where: Where }) => ([THMP, PEST].includes(where.xeroTenantId as string) && where.organizationId === ORG ? { id: 'x' } : null)),
    },
    purchasingSettings: {
      findUnique: jest.fn(async ({ where }: { where: Where }) => settings.find((row) => row.organizationId === where.organizationId) ?? null),
      upsert: jest.fn(async ({ create, update }: { create: Row; update: Row }) => {
        const found = settings.find((row) => row.organizationId === create.organizationId);
        if (found) Object.assign(found, update);
        // The columns' own defaults, as the migration gives them.
        else settings.push({ approvalLimitCents: 50000, quotesAboveLimit: 2, emailApprovers: false, reapproveChangedOrders: false, fileGroups: ['PDF', 'PICTURES', 'WORD', 'EXCEL'], fileMaxBytes: 20_000_000, filesMax: 20, quoteFileAboveCents: null, fileRemoval: 'UNTIL_SENT', approverOwnCompaniesOnly: true, ...create });
      }),
    },
    // Setup's people (2026-11-21): a test gives somebody companies or a limit by pushing a row.
    purchasingPerson: {
      findUnique: jest.fn(async ({ where }: { where: { organizationId_userProfileId: { userProfileId: string } } }) => persons.find((row) => row.userProfileId === where.organizationId_userProfileId.userProfileId) ?? null),
    },
    // Setup's numbers, read back after a save: none changed here.
    documentSeries: { findMany: jest.fn(async () => []) },
    purchasingApprovalStep: {
      findMany: jest.fn(async ({ where }: { where: Where }) => steps.filter((row) => matches(row, where)).sort((a, b) => (a.position as number) - (b.position as number))),
      deleteMany: jest.fn(async ({ where }: { where: Where }) => {
        for (let index = steps.length - 1; index >= 0; index -= 1) if (matches(steps[index]!, where)) steps.splice(index, 1);
      }),
      createMany: jest.fn(async ({ data }: { data: Row[] }) => steps.push(...data)),
    },
    purchaseRequisitionFile: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        files.filter((row) => matches(row, where)).map((row) => ({ ...row, attachedBy: { displayName: PEOPLE.find((one) => one.id === row.attachedById)!.displayName } })),
      ),
      findFirst: jest.fn(async ({ where }: { where: Where }) => files.find((row) => matches(row, where)) ?? null),
      count: jest.fn(async ({ where }: { where: Where }) => files.filter((row) => matches(row, where)).length),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { forVendor: false, attachedAt: new Date((clock += 1000)), ...data };
        files.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Row }) => {
        const found = files.filter((row) => matches(row, where));
        for (const row of found) Object.assign(row, data);
        return { count: found.length };
      }),
      deleteMany: jest.fn(async ({ where }: { where: Where }) => {
        const before = files.length;
        for (let index = files.length - 1; index >= 0; index -= 1) if (matches(files[index]!, where)) files.splice(index, 1);
        return { count: before - files.length };
      }),
    },
    purchaseRequisitionNote: {
      findMany: jest.fn(async ({ where }: { where: Where }) => notes.filter((row) => matches(row, where)).map((row) => ({ ...row, writtenBy: { id: row.writtenById, displayName: PEOPLE.find((one) => one.id === row.writtenById)!.displayName } }))),
      findFirst: jest.fn(async ({ where }: { where: Where }) => notes.find((row) => matches(row, where)) ?? null),
      count: jest.fn(async ({ where }: { where: Where }) => notes.filter((row) => matches(row, where)).length),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: id(600 + notes.length), writtenAt: new Date((clock += 1000)), ...data };
        notes.push(row);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }: { where: Where }) => {
        const before = notes.length;
        for (let index = notes.length - 1; index >= 0; index -= 1) if (matches(notes[index]!, where)) notes.splice(index, 1);
        return { count: before - notes.length };
      }),
    },
    purchaseRequisitionLink: {
      findMany: jest.fn(async ({ where }: { where: Where }) => links.filter((row) => matches(row, where)).map((row) => ({ ...row, addedBy: { id: row.addedById, displayName: PEOPLE.find((one) => one.id === row.addedById)!.displayName } }))),
      findFirst: jest.fn(async ({ where }: { where: Where }) => links.find((row) => matches(row, where)) ?? null),
      count: jest.fn(async ({ where }: { where: Where }) => links.filter((row) => matches(row, where)).length),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: id(650 + links.length), addedAt: new Date((clock += 1000)), ...data };
        links.push(row);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }: { where: Where }) => {
        const before = links.length;
        for (let index = links.length - 1; index >= 0; index -= 1) if (matches(links[index]!, where)) links.splice(index, 1);
        return { count: before - links.length };
      }),
    },
    userProfile: { findMany: jest.fn(async () => PEOPLE.map((one) => ({ id: one.id, displayName: one.displayName }))) },
    auditLog: {
      create: jest.fn(async ({ data }: { data: Row }) => audits.push({ createdAt: new Date((clock += 1000)), ...data })),
      findMany: jest.fn(async ({ where }: { where: Where }) => audits.filter((row) => matches(row, where)).reverse()),
    },
    // Taking the next number answers it; the files' lock answers nothing.
    $queryRaw: jest.fn(async (sql: TemplateStringsArray) => (sql.join('').includes('DocumentSeries') ? [{ taken: (series += 1) }] : [])),
  };
  const transaction = { $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => work(client)) };
  const client: unknown = Object.assign(db, transaction);
  const storage = {
    put: jest.fn(async () => undefined),
    get: jest.fn(async (key: string) => Buffer.from(`the bytes of ${key}`)),
    delete: jest.fn(async () => undefined),
    signedUrl: jest.fn(async (key: string, _seconds: number, disposition: string): Promise<string | null> => `https://files.example/${key}?disposition=${encodeURIComponent(disposition)}`),
    durable: jest.fn(() => true),
  };
  // The approvers are asked by email after a submit (2026-11-20): counted here, sent nowhere.
  const approvers = { ask: jest.fn(async () => 0) };
  const service = new PurchasingService(db as never, approvers as never);
  return { db, items, requisitions, lines, quotes, audits, codes, files, notes, links, liveOrders, storage, service, approvers, steps, persons, setup: new PurchasingSetupService(db as never), filesService: new RequisitionFilesService(db as never, storage as never, service), notesService: new RequisitionNotesService(db as never, service) };
}

const line = (itemId: string, quantity: number, estimatedUnitCostCents: number) => ({ itemId, quantity, estimatedUnitCostCents });
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
  small({ lines: [line(ALARM, 40, 1530)], quotes: [{ vendorId: HILL, totalCents: 61200, delivery: '3 days', chosen: true }, { vendorId: ALAMO, totalCents: 64000, delivery: null, chosen: false }], ...over });

describe('a requisition', () => {
  it('starts as its author\'s draft, with what is on hand beside each item', async () => {
    const { service, audits } = database();
    const draft = await service.create(asker, small());

    // Numbered when first saved (2026-11-20), and the requisitioner ID made from the name.
    expect(draft).toMatchObject({ status: 'DRAFT', number: 'PR-00001', requestedBy: { name: 'Sample Requester', code: 'SREQUESTER' }, company: { name: 'THMP' }, neededBy: '2026-11-24', estimatedTotalCents: 18480, lineCount: 2 });
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

  it('takes the office\'s next number when first saved, and keeps it through submitting and coming back (2026-11-20)', async () => {
    const { service, requisitions } = database();
    const first = await service.create(asker, small());
    const second = await service.create(colleague, small());
    expect([first.number, second.number]).toEqual(['PR-00001', 'PR-00002']);

    expect(await service.submit(colleague, second.id)).toMatchObject({ number: 'PR-00002', status: 'SUBMITTED' });
    await service.submit(asker, first.id);
    await service.decide(manager, first.id, 'SENT_BACK', { note: 'Which model?' });
    expect(await service.submit(asker, first.id)).toMatchObject({ number: 'PR-00001', status: 'SUBMITTED', decisionNote: null });

    // A draft from before numbers came with saving takes the next one when it is submitted.
    const old = await service.create(asker, small());
    requisitions.find((row) => row.id === old.id)!.number = null;
    expect(await service.submit(asker, old.id)).toMatchObject({ number: 'PR-00004' });
  });

  it('cannot be submitted without a line, or by anybody but its author; a reason is a note, not a requirement', async () => {
    const { service } = database();
    const draft = await service.create(asker, small({ reason: '  ' }));
    await service.update(asker, draft.id, small({ reason: '', lines: [] }));
    await expect(service.submit(asker, draft.id)).rejects.toMatchObject({ code: 'REQUISITION_NOT_READY', message: 'Add at least one item.' });

    await service.update(asker, draft.id, small({ reason: '' }));
    await expect(service.submit(manager, draft.id)).rejects.toMatchObject({ code: 'REQUISITION_NOT_FOUND' });
    await expect(service.update(colleague, draft.id, small())).rejects.toMatchObject({ code: 'REQUISITION_NOT_FOUND' });
    expect(await service.submit(asker, draft.id)).toMatchObject({ status: 'SUBMITTED', reason: '' });
  });

  it('keeps its General codes and each line\'s location, date, vendor, department and note (2026-11-20)', async () => {
    const { service, lines } = database();
    const draft = await service.create(
      asker,
      small({
        requestCodeId: id(51),
        costCenterId: id(52),
        documentDate: '2026-11-19',
        lines: [
          { ...line(FILTER, 36, 390), description: ' Filter 20x25x1, MERV 8 ', placeId: STOCKROOM, expectedOn: '2026-11-26', vendorId: HILL, departmentId: id(53), notes: ' Back door ' },
          line(BATTERY, 24, 185),
        ],
      }),
    );
    expect(draft).toMatchObject({ requestCode: { code: 'RESTOCK' }, costCenter: { code: 'MAINT' }, documentDate: '2026-11-19', deliverTo: { code: 'STORE' } });
    expect(lines[0]).toMatchObject({ description: 'Filter 20x25x1, MERV 8', placeId: STOCKROOM, vendorId: HILL, departmentId: id(53), notes: 'Back door' });
    expect(draft.lines[0]).toMatchObject({ description: 'Filter 20x25x1, MERV 8', place: { code: 'STORE' }, vendor: { name: 'Hill Country Supply' }, department: { code: 'HVAC' }, notes: 'Back door' });
    // A line given no description reads as its item.
    expect(draft.lines[1]).toMatchObject({ description: 'Battery, 9 V', place: null, vendor: null, department: null });
  });

  it('names only codes, places and vendors of this office, in use and on their own list (2026-11-20)', async () => {
    const { service } = database();
    const refused = (over: Partial<SaveRequisitionInput>) => service.create(asker, small(over));
    await expect(refused({ requestCodeId: id(54) })).rejects.toMatchObject({ code: 'REQUISITION_CODE_NOT_FOUND', message: 'That request code is not on the list, or is switched off.' });
    await expect(refused({ requestCodeId: id(52) })).rejects.toMatchObject({ code: 'REQUISITION_CODE_NOT_FOUND' });
    await expect(refused({ requestCodeId: id(56) })).rejects.toMatchObject({ code: 'REQUISITION_CODE_NOT_FOUND' });
    await expect(refused({ costCenterId: id(53) })).rejects.toMatchObject({ code: 'REQUISITION_CODE_NOT_FOUND', message: 'That cost center code is not on the list, or is switched off.' });
    await expect(refused({ lines: [{ ...line(FILTER, 1, 1), departmentId: id(51) }] })).rejects.toMatchObject({ message: 'That department code is not on the list, or is switched off.' });
    await expect(refused({ lines: [{ ...line(FILTER, 1, 1), placeId: id(99) }] })).rejects.toMatchObject({ code: 'REQUISITION_PLACE_NOT_FOUND' });
    await expect(refused({ lines: [{ ...line(FILTER, 1, 1), vendorId: id(23) }] })).rejects.toMatchObject({ code: 'VENDOR_NOT_FOUND' });
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
    await expect(service.submit(asker, none.id)).rejects.toMatchObject({ code: 'REQUISITION_NOT_READY', message: 'At this amount, 2 quotes are needed.' });

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

  // 2026-11-21, the office: an approver approves their own, as anybody else's.
  it('is approved by whoever asked when they are an approver, audited as their own, but never sent back or rejected by them', async () => {
    const { service, requisitionId, requisitions, audits } = await waiting(owner, small());

    expect((await service.detail(owner, requisitionId)).can).toMatchObject({ approve: true, sendBack: false, reject: false, approveBlocked: null });
    for (const decision of ['SENT_BACK', 'REJECTED'] as const)
      await expect(service.decide(owner, requisitionId, decision, { note: 'Mine' })).rejects.toMatchObject({ code: 'REQUISITION_OWN', message: 'You asked for this: take it back with Cancel Approval Request instead.' });
    expect(requisitions[0]).toMatchObject({ status: 'SUBMITTED', decidedById: null });

    expect(await service.decide(owner, requisitionId, 'APPROVED', {})).toMatchObject({ status: 'APPROVED', decidedBy: 'Sample Owner' });
    expect(audits.find((audit) => audit.action === 'PURCHASE_REQUISITION_APPROVED')?.metadata).toMatchObject({ ownRequest: true });
  });

  it('holds an approver approving their own to their limit, and somebody who only asks never approves', async () => {
    // $184.80, by somebody who may approve to $100.00.
    const capped = await waiting(manager, small());
    capped.persons.push({ organizationId: ORG, userProfileId: manager.id, companyTenantIds: [], approvesAnyAmount: false, approvalLimitCents: 10000 });
    expect((await capped.service.detail(manager, capped.requisitionId)).can).toMatchObject({ approve: false, approveBlocked: 'At $184.80 it is above your approval limit of $100.00.' });
    await expect(capped.service.decide(manager, capped.requisitionId, 'APPROVED', {})).rejects.toMatchObject({ code: 'REQUISITION_OVER_LIMIT' });

    const asked = await waiting(asker, small());
    expect((await asked.service.detail(asker, asked.requisitionId)).can).toMatchObject({ approve: false, approveBlocked: null });
    await expect(asked.service.decide(asker, asked.requisitionId, 'APPROVED', {})).rejects.toMatchObject({ code: 'REQUISITION_NOT_APPROVER' });
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
      approveBlocked: 'At $612.00 it needs somebody who may approve any amount.',
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

describe('the approval steps and the form\'s choices', () => {
  it('start as $500.00 and two quotes above it, every kind of file, until Setup changes them', async () => {
    const { service } = database();
    expect((await service.list(asker)).settings).toEqual({ steps: stepsFromLimit(50000, 2), files: DEFAULT_FILE_RULES, page: DEFAULT_PAGE_LAYOUT });
  });

  // Purchasing Setup, 2026-11-20: the steps replace the one limit.
  it('move what a manager may approve, by the step its amount falls in', async () => {
    const { service, setup } = database();
    const draft = await service.create(asker, large());
    await setup.saveApprovals(owner, { steps: [{ ...stepsFromLimit(100000, 2)[0]!, quotesNeeded: 0 }, stepsFromLimit(100000, 2)[1]!], approverOwnCompaniesOnly: true, emailApprovers: false, reapproveChangedOrders: false });
    await service.submit(asker, draft.id);
    expect(await service.decide(manager, draft.id, 'APPROVED', {})).toMatchObject({ status: 'APPROVED' });
  });

  it('ask the approvers after it is sent, and refuse it above the office\'s amount until the quote is attached', async () => {
    const { service, setup, approvers, files } = database();
    const draft = await service.create(asker, small());
    await setup.saveFiles(owner, { ...DEFAULT_FILE_RULES, quoteFileAboveCents: 10000 });
    await expect(service.submit(asker, draft.id)).rejects.toMatchObject({ code: 'REQUISITION_NOT_READY', message: 'Above $100.00, attach the quote before sending it.' });
    expect(approvers.ask).not.toHaveBeenCalled();

    files.push({ id: id(70), organizationId: ORG, requisitionId: draft.id, fileName: 'quote.pdf', contentType: 'application/pdf', sizeBytes: 900, forVendor: false, attachedById: asker.id, attachedAt: new Date() });
    await service.submit(asker, draft.id);
    expect(approvers.ask).toHaveBeenCalledWith(ORG, draft.id);
  });

  it('offer the items in use with what is on hand and what one cost', async () => {
    const { service } = database();
    const choices = await service.choices(asker);

    expect(choices.items.map((item) => item.code)).toEqual(['FLT-20251', 'BAT-9V', 'PST-GLUE', 'SMK-0001']);
    expect(choices.items[1]).toMatchObject({ onHand: 5, averageCostCents: 185, companyTenantId: THMP, reorderQuantity: 24 });
    expect(choices.items[0]).toMatchObject({ onHand: 0, averageCostCents: null });
    // The usual price the stock keeper gave the filter comes with it, for the line's cost to start from.
    expect(choices.items.find((item) => item.code === 'FLT-20251')).toMatchObject({ priceCents: 425 });
    expect(choices.vendors.map((vendor) => vendor.name)).toEqual(['Hill Country Supply', 'Alamo Trade Parts']);
  });

  it('offer what is where, what is still to come, the order that last asked, and the codes in use (2026-11-20)', async () => {
    const { service } = database();
    const choices = await service.choices(asker);
    expect(choices.items.find((item) => item.code === 'BAT-9V')).toMatchObject({ held: [{ placeId: STOCKROOM, quantity: 5 }], onOrder: 0, lastOrdered: null });
    // 36 ordered, 12 come: 24 still to come. The newest order is the last that asked.
    expect(choices.items.find((item) => item.code === 'FLT-20251')).toMatchObject({ held: [], onOrder: 24, lastOrdered: 'PO-0007' });
    expect(choices.requestCodes?.map((code) => code.code)).toEqual(['RESTOCK']);
    expect(choices.costCenters?.map((code) => code.code)).toEqual(['MAINT']);
    expect(choices.departments?.map((code) => code.code)).toEqual(['HVAC']);
    expect(choices.lineTypes).toEqual([{ id: id(55), code: 'ITEM', name: 'Item', keepsStock: true }]);
    expect(choices.me).toEqual({ id: asker.id, name: 'Sample Requester', code: 'SREQUESTER' });
    expect(choices.canMakeItemCodes).toBe(false);
  });
});

describe('the requests the page sends', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (body: unknown, metatype: new () => object) => pipe.transform(body, { type: 'body', metatype });

  it('name every field of their contracts', async () => {
    const requisition: Required<SaveRequisitionInput> = {
      ...large(),
      requestCodeId: id(51),
      costCenterId: id(52),
      documentDate: '2026-11-19',
      lines: [{ ...line(ALARM, 40, 1530), description: 'Smoke alarm', placeId: STOCKROOM, expectedOn: '2026-11-26', vendorId: HILL, departmentId: id(53), notes: 'Back door' }],
    };
    const decision: Required<RequisitionDecisionInput> = { note: 'Which model?' };

    await expect(check(requisition, SaveRequisitionDto)).resolves.toBeDefined();
    await expect(check(small({ xeroTenantId: null, neededBy: null, deliverToPlaceId: null }), SaveRequisitionDto)).resolves.toBeDefined();
    await expect(check(decision, RequisitionDecisionDto)).resolves.toBeDefined();
    await expect(check({}, RequisitionDecisionDto)).resolves.toBeDefined();
  });

  it('refuse a line that asks in words for something with no item code', async () => {
    const words = { itemId: null, description: 'Label printer', quantity: 1, estimatedUnitCostCents: 12900 };
    await expect(check({ ...small(), lines: [words] }, SaveRequisitionDto)).rejects.toBeDefined();
    await expect(check({ ...small(), lines: [{ quantity: 1, estimatedUnitCostCents: 12900 }] }, SaveRequisitionDto)).rejects.toBeDefined();
    // A line has its own description since 2026-11-20, beside its item code -- never instead of it.
    await expect(check({ ...small(), lines: [{ ...line(FILTER, 1, 390), description: 'Filter 20x25x1, MERV 8' }] }, SaveRequisitionDto)).resolves.toBeDefined();
  });

  it('refuse a status or a number sent with a requisition, none of an item, and a part of one', async () => {
    await expect(check({ ...small(), status: 'APPROVED' }, SaveRequisitionDto)).rejects.toBeDefined();
    await expect(check({ ...small(), number: 'PR-0001' }, SaveRequisitionDto)).rejects.toBeDefined();
    await expect(check({ ...small(), requestedById: manager.id }, SaveRequisitionDto)).rejects.toBeDefined();
    await expect(check(small({ lines: [line(FILTER, 0, 390)] }), SaveRequisitionDto)).rejects.toBeDefined();
    await expect(check(small({ lines: [line(FILTER, 1.5, 390)] }), SaveRequisitionDto)).rejects.toBeDefined();
    await expect(check(small({ lines: [{ ...line(FILTER, 1, 390), approved: true } as never] }), SaveRequisitionDto)).rejects.toBeDefined();
  });
});

describe('who may do what', () => {
  const permissionsOf = (name: string) => Reflect.getMetadata('permissions', (PurchasingController.prototype as unknown as Record<string, object>)[name]!) as string[];

  it('opens Purchasing with purchasing:request and decides with purchasing:approve', () => {
    for (const own of ['list', 'choices', 'create', 'detail', 'update', 'submit', 'cancel']) expect(permissionsOf(own)).toEqual(['purchasing:request']);
    for (const decision of ['approve', 'sendBack', 'reject']) expect(permissionsOf(decision)).toEqual(['purchasing:request', 'purchasing:approve']);
  });

  it('never lets an API key ask for or approve a purchase', () => {
    expect(MACHINE_FORBIDDEN_PERMISSIONS).toEqual(expect.arrayContaining(['purchasing:request', 'purchasing:approve', 'purchasing:approve-any']));
  });
});

describe('files on a requisition (2026-11-20, part 3)', () => {
  const PDF = Buffer.from('%PDF-1.7\n% a quote\n');
  const upload = (buffer: Buffer, originalname = 'Quote - Hill Country Supply.pdf') => ({ originalname, mimetype: 'application/octet-stream', size: buffer.length, buffer });
  const zip = (part: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`....[Content_Types].xml....${part}....`, 'latin1')]);
  const ole = (stream: string) => Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64), Buffer.from(stream, 'utf16le')]);

  it('knows a file by its first bytes, never by its name', () => {
    expect(sniffRequisitionFile(PDF)).toBe('application/pdf');
    expect(sniffRequisitionFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffRequisitionFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffRequisitionFile(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic', 'latin1')]))).toBe('image/heic');
    expect(sniffRequisitionFile(zip('word/document.xml'))).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(sniffRequisitionFile(zip('xl/workbook.xml'))).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(sniffRequisitionFile(ole('WordDocument'))).toBe('application/msword');
    expect(sniffRequisitionFile(ole('Workbook'))).toBe('application/vnd.ms-excel');
    // A web page or a program renamed ".pdf", or any other zip, is not one.
    expect(sniffRequisitionFile(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(sniffRequisitionFile(Buffer.from('MZ a program'))).toBeNull();
    expect(sniffRequisitionFile(zip('photos/1.jpg'))).toBeNull();
  });

  it('attaches a file to a draft: stored once under the console’s own key, written down, and in the history', async () => {
    const { service, filesService, storage, audits } = database();
    const draft = await service.create(asker, small());
    const detail = await filesService.attach(asker, draft.id, upload(PDF, 'Quote / Hill?.pdf'));

    expect(storage.put).toHaveBeenCalledTimes(1);
    const [key, bytes, type] = storage.put.mock.calls[0] as unknown as [string, Buffer, string];
    expect(key).toMatch(new RegExp(`^purchasing-files/${ORG}/${draft.id}/[0-9a-f-]{36}$`));
    expect(bytes).toBe(PDF);
    expect(type).toBe('application/pdf');
    expect(detail.files).toEqual([
      {
        id: expect.any(String),
        fileName: 'Quote Hill.pdf',
        contentType: 'application/pdf',
        sizeBytes: PDF.length,
        attachedBy: { id: asker.id, name: 'Sample Requester', code: 'SREQUESTER' },
        attachedAt: expect.any(String),
        forVendor: false,
        canRemove: true,
      },
    ]);
    expect(detail.can.attach).toBe(true);
    expect(audits.at(-1)).toMatchObject({ action: 'PURCHASE_REQUISITION_FILE_ATTACHED', entityId: draft.id, metadata: expect.objectContaining({ note: 'Quote Hill.pdf', sizeBytes: PDF.length }) });
    expect(detail.history[0]).toMatchObject({ by: 'Sample Requester', what: 'attached a file: Quote Hill.pdf' });
  });

  it('refuses what is not a PDF, picture, Word or Excel file, or past 20 MB, before anything is stored', async () => {
    const { service, filesService, storage } = database();
    const draft = await service.create(asker, small());

    await expect(filesService.attach(asker, draft.id, upload(Buffer.from('<html></html>'), 'quote.pdf'))).rejects.toMatchObject({ code: 'REQUISITION_FILE_INVALID', status: 422 });
    await expect(filesService.attach(asker, draft.id, { ...upload(PDF), size: 20_000_001 })).rejects.toMatchObject({ code: 'REQUISITION_FILE_TOO_BIG', status: 422 });
    await expect(filesService.attach(asker, draft.id, undefined)).rejects.toMatchObject({ code: 'REQUISITION_FILE_INVALID' });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('is not there to somebody who cannot see the requisition, and is closed once it is finished with', async () => {
    const { service, filesService, storage } = database();
    const draft = await service.create(asker, small());
    // A draft is its author's alone, even to an approver; another office's is not there at all.
    await expect(filesService.attach(colleague, draft.id, upload(PDF))).rejects.toMatchObject({ code: 'REQUISITION_NOT_FOUND', status: 404 });
    await expect(filesService.attach(manager, draft.id, upload(PDF))).rejects.toMatchObject({ code: 'REQUISITION_NOT_FOUND' });
    await expect(filesService.attach(outsider, draft.id, upload(PDF))).rejects.toMatchObject({ code: 'REQUISITION_NOT_FOUND' });

    await service.submit(asker, draft.id);
    await service.decide(manager, draft.id, 'REJECTED', { note: 'Not this quarter.' });
    await expect(filesService.attach(asker, draft.id, upload(PDF))).rejects.toMatchObject({ code: 'REQUISITION_FILES_CLOSED', status: 409 });
    expect(storage.put).not.toHaveBeenCalled();
    expect((await service.detail(asker, draft.id)).can.attach).toBe(false);
  });

  it('holds at most 20 files', async () => {
    const { service, filesService, files } = database();
    const draft = await service.create(asker, small());
    for (let n = 0; n < 20; n += 1)
      files.push({ id: id(700 + n), organizationId: ORG, requisitionId: draft.id, fileName: `${n}.pdf`, contentType: 'application/pdf', sizeBytes: 10, storageKey: `k${n}`, forVendor: false, attachedById: asker.id, attachedAt: new Date() });
    await expect(filesService.attach(asker, draft.id, upload(PDF))).rejects.toMatchObject({ code: 'REQUISITION_FILES_FULL', message: 'A requisition holds at most 20 files. Take one off first.' });
  });

  // Purchasing Setup, 2026-11-20: the office says which kinds, how large, how many, and who may take one off until when.
  it('is held to the rules the office set: its kinds, its largest file, its count, and who may take one off until when', async () => {
    const { service, filesService, setup, files } = database();
    const draft = await service.create(asker, small());
    await setup.saveFiles(owner, { groups: ['PDF', 'WORD'], maxBytes: 5_000_000, maxFiles: 2, quoteFileAboveCents: null, removal: 'UNTIL_ORDERED' });

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    await expect(filesService.attach(asker, draft.id, upload(png, 'shelf.png'))).rejects.toMatchObject({ code: 'REQUISITION_FILE_INVALID', message: 'Attach PDF or Word.' });
    await expect(filesService.attach(asker, draft.id, { ...upload(PDF), size: 5_000_001 })).rejects.toMatchObject({ code: 'REQUISITION_FILE_TOO_BIG', message: 'A file is at most 5 MB; this one is 19 B.' });
    await filesService.attach(asker, draft.id, upload(PDF));
    await filesService.attach(asker, draft.id, upload(PDF, 'second.pdf'));
    await expect(filesService.attach(asker, draft.id, upload(PDF, 'third.pdf'))).rejects.toMatchObject({ code: 'REQUISITION_FILES_FULL', message: 'A requisition holds at most 2 files. Take one off first.' });

    // Until it is ordered: still taken off once it is sent for approval.
    await service.submit(asker, draft.id);
    const sent = await service.detail(asker, draft.id);
    expect(sent.files.map((file) => file.canRemove)).toEqual([true, true]);
    await filesService.remove(asker, draft.id, sent.files[0]!.id);
    expect(files).toHaveLength(1);
  });

  it('takes the stored copy away again when the row cannot be written', async () => {
    const { db, service, filesService, storage, files } = database();
    const draft = await service.create(asker, small());
    db.auditLog.create.mockRejectedValueOnce(new Error('the database went away'));

    await expect(filesService.attach(asker, draft.id, upload(PDF))).rejects.toThrow('the database went away');
    const [stored] = storage.put.mock.calls[0] as unknown as [string];
    expect(storage.delete).toHaveBeenCalledWith(stored);
    // The fake has no rollback, so the row it wrote stands here; the real transaction takes it back.
    expect(files).toHaveLength(1);
  });

  it('lets an approver attach to a submitted one and tick a file for the vendor; a tick that changes nothing writes nothing', async () => {
    const { service, filesService, audits } = database();
    const draft = await service.create(asker, small());
    await service.submit(asker, draft.id);
    const attached = await filesService.attach(manager, draft.id, upload(PDF, 'Quote.pdf'));
    const fileId = attached.files[0]!.id;
    // Attached after it was sent, so it stays with it: nobody takes it off.
    expect(attached.files[0]).toMatchObject({ attachedBy: { name: 'Sample Manager' }, canRemove: false });

    const ticked = await filesService.setForVendor(manager, draft.id, fileId, true);
    expect(ticked.files[0]!.forVendor).toBe(true);
    expect(audits.at(-1)).toMatchObject({ action: 'PURCHASE_REQUISITION_FILE_FOR_VENDOR', metadata: { fileId, note: 'Quote.pdf' } });
    const written = audits.length;
    await filesService.setForVendor(asker, draft.id, fileId, true);
    expect(audits).toHaveLength(written);

    expect((await filesService.setForVendor(asker, draft.id, fileId, false)).files[0]!.forVendor).toBe(false);
    expect(audits.at(-1)).toMatchObject({ action: 'PURCHASE_REQUISITION_FILE_NOT_FOR_VENDOR' });
    await expect(filesService.setForVendor(asker, draft.id, id(999), true)).rejects.toMatchObject({ code: 'REQUISITION_FILE_NOT_FOUND', status: 404 });
  });

  it('is taken off only by whoever attached it, while the requisition is still being written', async () => {
    const { service, filesService, storage, audits, files } = database();
    const draft = await service.create(asker, small());
    const fileId = (await filesService.attach(asker, draft.id, upload(PDF, 'Wrong quote.pdf'))).files[0]!.id;
    const second = (await filesService.attach(asker, draft.id, upload(PDF, 'Right quote.pdf'))).files[1]!.id;

    const removed = await filesService.remove(asker, draft.id, fileId);
    expect(removed.files.map((file) => file.fileName)).toEqual(['Right quote.pdf']);
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(audits.at(-1)).toMatchObject({ action: 'PURCHASE_REQUISITION_FILE_REMOVED', metadata: { fileId, note: 'Wrong quote.pdf' } });

    await service.submit(asker, draft.id);
    await expect(filesService.remove(manager, draft.id, second)).rejects.toMatchObject({ code: 'REQUISITION_FILE_NOT_YOURS', status: 403 });
    await expect(filesService.remove(asker, draft.id, second)).rejects.toMatchObject({ code: 'REQUISITION_FILE_KEPT', status: 409 });
    expect(files).toHaveLength(1);
    expect((await service.detail(asker, draft.id)).files[0]!.canRemove).toBe(false);
  });

  it('opens a PDF in place and a spreadsheet as a download, through a five-minute link; without one, the bytes come from the API', async () => {
    const { service, filesService, storage } = database();
    const draft = await service.create(asker, small());
    const pdf = (await filesService.attach(asker, draft.id, upload(PDF, 'Quote.pdf'))).files[0]!;
    const sheet = (await filesService.attach(asker, draft.id, upload(zip('xl/workbook.xml'), 'December filter list.xlsx'))).files[1]!;
    expect(sheet).toMatchObject({ fileName: 'December filter list.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

    expect((await filesService.link(asker, draft.id, pdf.id)).url).toContain(encodeURIComponent('inline; filename="Quote.pdf"'));
    expect(storage.signedUrl).toHaveBeenLastCalledWith(expect.stringContaining(pdf.id), 300, expect.any(String));
    expect((await filesService.link(asker, draft.id, sheet.id)).url).toContain(encodeURIComponent('attachment; filename="December filter list.xlsx"'));

    storage.signedUrl.mockResolvedValueOnce(null);
    expect(await filesService.link(asker, draft.id, pdf.id)).toEqual({ url: null });
    const content = await filesService.content(asker, draft.id, pdf.id);
    expect(content).toMatchObject({ contentType: 'application/pdf', disposition: expect.stringMatching(/^inline; filename="Quote.pdf"/) });
    expect(content.bytes.toString()).toContain(pdf.id);
    await expect(filesService.link(colleague, draft.id, pdf.id)).rejects.toMatchObject({ code: 'REQUISITION_NOT_FOUND' });
  });

  it('a tick names its one field, and it must be yes or no', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const check = (body: unknown) => pipe.transform(body, { type: 'body', metatype: SetRequisitionFileDto });
    await expect(check({ forVendor: true })).resolves.toEqual({ forVendor: true });
    await expect(check({ forVendor: 'yes' })).rejects.toBeDefined();
    await expect(check({})).rejects.toBeDefined();
  });
});

describe('Cancel Approval Request and Reopen (2026-11-20, the NAV ribbon)', () => {
  it('lets the requester take a waiting requisition back to a draft, keeping its number', async () => {
    const { service, audits } = database();
    const draft = await service.create(asker, small());
    await service.submit(asker, draft.id);
    expect((await service.detail(asker, draft.id)).can).toMatchObject({ recall: true, reopen: false });
    // Nobody else takes it back: an approver decides it instead.
    await expect(service.recall(manager, draft.id)).rejects.toMatchObject({ code: 'REQUISITION_NOT_FOUND' });

    const back = await service.recall(asker, draft.id);
    expect(back).toMatchObject({ status: 'DRAFT', number: draft.number, can: { edit: true, recall: false } });
    expect(audits.at(-1)).toMatchObject({ action: 'PURCHASE_REQUISITION_RECALLED' });
    expect(back.history[0]).toMatchObject({ what: 'took back its approval request' });
    await expect(service.recall(asker, draft.id)).rejects.toMatchObject({ code: 'REQUISITION_MOVED_ON' });
  });

  it('reopens an approved requisition with no order, by its requester or an approver, for approval again', async () => {
    const { service, audits, liveOrders } = database();
    const draft = await service.create(asker, small());
    await service.submit(asker, draft.id);
    await service.decide(manager, draft.id, 'APPROVED', {});
    expect((await service.detail(asker, draft.id)).can.reopen).toBe(true);
    // Somebody who neither asked nor approves cannot.
    await expect(service.reopen(colleague, draft.id, {})).rejects.toMatchObject({ code: 'REQUISITION_NOT_FOUND' });

    const reopened = await service.reopen(manager, draft.id, { note: 'Add the 9 V batteries.' });
    expect(reopened).toMatchObject({ status: 'SENT_BACK', decidedBy: null, decisionNote: 'Reopened: Add the 9 V batteries.' });
    expect((await service.detail(asker, draft.id)).can).toMatchObject({ edit: true, submit: true });
    expect(audits.at(-1)).toMatchObject({ action: 'PURCHASE_REQUISITION_REOPENED', actorUserId: manager.id });

    // Approved again, then ordered: no longer reopened.
    await service.submit(asker, draft.id);
    await service.decide(manager, draft.id, 'APPROVED', {});
    liveOrders.push({ requisitionId: draft.id });
    await expect(service.reopen(asker, draft.id, {})).rejects.toMatchObject({ code: 'REQUISITION_ORDERED' });
  });
});

describe('notes, comments and links (2026-11-20, Show Attached)', () => {
  it('writes notes and comments, each in its own list, and lists them oldest first with who and when', async () => {
    const { service, notesService, audits } = database();
    const draft = await service.create(asker, small());
    await notesService.write(asker, draft.id, 'NOTE', { text: '  Ask for the 20-pack.  ' });
    await service.submit(asker, draft.id);
    await notesService.write(manager, draft.id, 'COMMENT', { text: 'Is the 16x25 still needed?' });
    const detail = await notesService.write(asker, draft.id, 'COMMENT', { text: 'Yes, for the HVAC visits.' });

    expect(detail.notes).toEqual([{ id: expect.any(String), text: 'Ask for the 20-pack.', by: { id: asker.id, name: 'Sample Requester', code: 'SREQUESTER' }, at: expect.any(String), canRemove: true }]);
    expect(detail.comments.map((comment) => [comment.by.name, comment.text, comment.canRemove])).toEqual([
      ['Sample Manager', 'Is the 16x25 still needed?', false],
      ['Sample Requester', 'Yes, for the HVAC visits.', false],
    ]);
    expect(audits.map((audit) => audit.action)).toEqual(expect.arrayContaining(['PURCHASE_REQUISITION_NOTE_ADDED', 'PURCHASE_REQUISITION_COMMENTED']));
    expect(detail.history[0]).toMatchObject({ by: 'Sample Requester', what: 'commented: Yes, for the HVAC visits.' });
    await expect(notesService.write(asker, draft.id, 'NOTE', { text: '   ' })).rejects.toMatchObject({ code: 'REQUISITION_NOTE_INVALID' });
  });

  it('takes a note off only by its writer, and never a comment', async () => {
    const { service, notesService } = database();
    const draft = await service.create(asker, small());
    const noted = await notesService.write(asker, draft.id, 'NOTE', { text: 'Wrong vendor in mind.' });
    const commented = await notesService.write(asker, draft.id, 'COMMENT', { text: 'A comment.' });
    await service.submit(asker, draft.id);

    await expect(notesService.removeNote(manager, draft.id, noted.notes[0]!.id)).rejects.toMatchObject({ code: 'REQUISITION_NOTE_NOT_YOURS', status: 403 });
    await expect(notesService.removeNote(asker, draft.id, commented.comments[0]!.id)).rejects.toMatchObject({ code: 'REQUISITION_COMMENT_KEPT' });
    expect((await notesService.removeNote(asker, draft.id, noted.notes[0]!.id)).notes).toEqual([]);
  });

  it('keeps only http(s) links, titled by the address when given none, and takes one off by whoever added it', async () => {
    const { service, notesService } = database();
    const draft = await service.create(asker, small());
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.test/x', 'example.test'])
      await expect(notesService.addLink(asker, draft.id, { url, title: 'x' })).rejects.toMatchObject({ code: 'REQUISITION_LINK_INVALID' });

    const added = await notesService.addLink(asker, draft.id, { url: ' https://supplier.example/quote/77 ', title: '' });
    expect(added.links).toEqual([{ id: expect.any(String), url: 'https://supplier.example/quote/77', title: 'supplier.example', by: expect.objectContaining({ name: 'Sample Requester' }), at: expect.any(String), canRemove: true }]);
    await service.submit(asker, draft.id);
    await expect(notesService.removeLink(manager, draft.id, added.links[0]!.id)).rejects.toMatchObject({ code: 'REQUISITION_LINK_NOT_YOURS' });
    expect((await notesService.removeLink(asker, draft.id, added.links[0]!.id)).links).toEqual([]);
  });

  it('is not there to somebody who cannot see the requisition', async () => {
    const { service, notesService } = database();
    const draft = await service.create(asker, small());
    await expect(notesService.write(colleague, draft.id, 'COMMENT', { text: 'Hello' })).rejects.toMatchObject({ code: 'REQUISITION_NOT_FOUND' });
    await expect(notesService.addLink(outsider, draft.id, { url: 'https://example.test', title: 'x' })).rejects.toMatchObject({ code: 'REQUISITION_NOT_FOUND' });
  });

  it('a link names its two fields', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const check = (body: unknown) => pipe.transform(body, { type: 'body', metatype: AddRequisitionLinkDto });
    await expect(check({ url: 'https://example.test', title: 'Quote' })).resolves.toEqual({ url: 'https://example.test', title: 'Quote' });
    await expect(check({ url: 'https://example.test' })).rejects.toBeDefined();
  });
});

describe('the orders made from a requisition (2026-11-20, one a vendor)', () => {
  it('lists its live orders with their vendors, and offers more only while a vendor on it has none', async () => {
    const { service, requisitions, liveOrders, lines } = database();
    const draft = await service.create(asker, small());
    await service.submit(asker, draft.id);
    await service.decide(manager, draft.id, 'APPROVED', {});
    lines.forEach((line, index) => (line.vendorId = index === 0 ? HILL : ALAMO));
    expect((await service.detail(buyer, draft.id)).can.order).toBe(true);

    // Ordered from Hill only: Alamo's line is still to order.
    requisitions[0]!.status = 'ORDERED';
    liveOrders.push({ requisitionId: draft.id, vendorId: HILL });
    const ordered = await service.detail(buyer, draft.id);
    expect(ordered.orders).toEqual([{ id: 'order-0', number: null, status: 'DRAFT', vendor: expect.objectContaining({ id: HILL, name: 'Hill Country Supply' }) }]);
    expect(ordered.can.order).toBe(true);

    liveOrders.push({ requisitionId: draft.id, vendorId: ALAMO });
    expect((await service.detail(buyer, draft.id)).can.order).toBe(false);
    // Somebody who does not buy is never offered it.
    expect((await service.detail(manager, draft.id)).can.order).toBe(false);
  });

  it('is headed for its PDF by the company it is for, at the office address', async () => {
    const { service } = database();
    const draft = await service.create(asker, small());
    expect((await service.detail(asker, draft.id)).from).toEqual({ name: 'THMP', addressLine1: '1 Example Plaza', addressLine2: null, phone: null, email: null });
  });
});

describe('companies and approver limits (Purchasing Setup, 2026-11-21)', () => {
  const waiting = async (who: AuthenticatedUser, input: SaveRequisitionInput) => {
    const made = database();
    const draft = await made.service.create(who, input);
    await made.service.submit(who, draft.id);
    return { ...made, requisitionId: draft.id };
  };
  const person = (who: AuthenticatedUser, over: Record<string, unknown>) => ({ organizationId: ORG, userProfileId: who.id, companyTenantIds: [], approvesAnyAmount: false, approvalLimitCents: null, ...over });

  it('lets somebody limited to one company ask only for it, and offers them only it', async () => {
    const { service, persons } = database();
    persons.push(person(asker, { companyTenantIds: [PEST] }));
    await expect(service.create(asker, small())).rejects.toMatchObject({ code: 'REQUISITION_COMPANY_NOT_YOURS', message: "You ask for stock only for your own companies, and this is another company's." });
    expect((await service.choices(asker)).companies.map((company) => company.tenantId)).toEqual([PEST]);
  });

  // 2026-11-21: New makes the draft at once, every field blank, so a draft may wait for its company; it is sent only for one of theirs.
  it('lets them keep a draft with no company yet, but not send it until it is one of theirs', async () => {
    const { service, persons } = database();
    persons.push(person(asker, { companyTenantIds: [PEST] }));
    const draft = await service.create(asker, small({ xeroTenantId: null, lines: [] }));
    // Its Document Date is the day it was made (2026-11-21), and stays that day when a save gives none.
    expect(draft).toMatchObject({ status: 'DRAFT', company: null, documentDate: businessDate(), lines: [] });
    expect(draft.number).toMatch(/^PR-/);
    expect(await service.update(asker, draft.id, small({ xeroTenantId: null, lines: [], documentDate: null }))).toMatchObject({ documentDate: draft.requisitionDate });
    expect(await service.update(asker, draft.id, small({ xeroTenantId: null, lines: [], documentDate: '2026-11-02' }))).toMatchObject({ documentDate: '2026-11-02' });
    await expect(service.submit(asker, draft.id)).rejects.toMatchObject({ code: 'REQUISITION_NOT_READY', message: 'Add at least one item.' });
  });

  it('refuses to send a draft with no company for somebody limited to some', async () => {
    const { service, persons, items } = database();
    // An item kept for no company yet, which a requisition with none may ask for.
    const loose = items.find((item) => item.id === FILTER)!;
    loose.xeroTenantId = null;
    const draft = await service.create(asker, small({ xeroTenantId: null, lines: [line(FILTER, 2, 390)] }));
    persons.push(person(asker, { companyTenantIds: [PEST] }));
    await expect(service.submit(asker, draft.id)).rejects.toMatchObject({ code: 'REQUISITION_COMPANY_NOT_YOURS', message: 'You ask for stock only for your own companies: choose one of them.' });
  });

  it('lets an approver decide only for their own companies while the office says so', async () => {
    const { service, persons, setup, requisitionId } = await waiting(asker, small());
    persons.push(person(manager, { companyTenantIds: [PEST] }));
    expect((await service.detail(manager, requisitionId)).can).toMatchObject({
      approve: false,
      sendBack: false,
      reject: false,
      approveBlocked: "You approve only for your own companies, and this is another company's.",
    });
    await expect(service.decide(manager, requisitionId, 'SENT_BACK', { note: 'Which one?' })).rejects.toMatchObject({ code: 'REQUISITION_COMPANY_NOT_YOURS' });

    const steps = (await service.detail(asker, requisitionId)).settings.steps;
    await setup.saveApprovals(owner, { steps, approverOwnCompaniesOnly: false, emailApprovers: false, reapproveChangedOrders: false });
    expect(await service.decide(manager, requisitionId, 'APPROVED', {})).toMatchObject({ status: 'APPROVED' });
  });

  it('never lets an approver above their own limit, and a step can ask for an approver whose limit reaches its top', async () => {
    // $184.80 asked for.
    const { service, persons, setup, requisitionId } = await waiting(asker, small());
    persons.push(person(manager, { approvalLimitCents: 10000 }));
    expect((await service.detail(manager, requisitionId)).can.approveBlocked).toBe('At $184.80 it is above your approval limit of $100.00.');
    await expect(service.decide(manager, requisitionId, 'APPROVED', {})).rejects.toMatchObject({ code: 'REQUISITION_OVER_LIMIT' });

    await setup.saveApprovals(owner, {
      steps: [
        { upToCents: 20000, approver: 'APPROVER_LIMIT', quotesNeeded: 0, reminderDays: null },
        { upToCents: null, approver: 'ANY_AMOUNT', quotesNeeded: 2, reminderDays: null },
      ],
      approverOwnCompaniesOnly: true,
      emailApprovers: false,
      reapproveChangedOrders: false,
    });
    persons[0]!.approvalLimitCents = 19000;
    expect((await service.detail(manager, requisitionId)).can.approveBlocked).toBe('At $184.80 it needs an approver whose own limit is $200.00 or more.');
    persons[0]!.approvalLimitCents = 20000;
    expect(await service.decide(manager, requisitionId, 'APPROVED', {})).toMatchObject({ status: 'APPROVED' });
  });

  it('gives "any amount" in Setup to an approver without the permission, and lets a limit set there cap one who has it', async () => {
    const large1 = await waiting(asker, large());
    large1.persons.push(person(manager, { approvesAnyAmount: true }));
    expect(await large1.service.decide(manager, large1.requisitionId, 'APPROVED', {})).toMatchObject({ status: 'APPROVED' });

    const large2 = await waiting(asker, large());
    large2.persons.push(person(owner, { approvalLimitCents: 50000 }));
    expect((await large2.service.detail(owner, large2.requisitionId)).can.approveBlocked).toBe('At $612.00 it is above your approval limit of $500.00.');
  });
});

describe('the requisition page Setup keeps (2026-11-21)', () => {
  it('refuses to send a requisition missing a field the office requires', async () => {
    const { service, setup } = database();
    const draft = await service.create(asker, small());
    await setup.saveRequisitionPage(owner, { ...DEFAULT_PAGE_LAYOUT, fields: { ...DEFAULT_PAGE_LAYOUT.fields, REQUEST_CODE: { shown: true, required: true } } });
    expect((await service.detail(asker, draft.id)).settings.page.fields.REQUEST_CODE).toEqual({ shown: true, required: true });
    await expect(service.submit(asker, draft.id)).rejects.toMatchObject({ code: 'REQUISITION_NOT_READY', message: 'Choose the request code.' });
  });

  it("tells the form each vendor's open orders, this year's spend and last order", async () => {
    const { db, service } = database();
    db.purchaseOrder.findMany.mockImplementationOnce(async () => [
      { vendorId: HILL, number: 'PO-0031', status: 'SENT', createdAt: new Date(), taxBasisPoints: 825, lines: [{ quantity: 10, unitPriceCents: 1000 }] },
      { vendorId: HILL, number: 'PO-0029', status: 'CLOSED', createdAt: new Date(Date.now() - 3_600_000), taxBasisPoints: 0, lines: [{ quantity: 1, unitPriceCents: 5000 }] },
    ] as never);
    const choices = await service.choices(asker);
    expect(choices.vendorStats).toEqual({ [HILL]: { openOrders: 1, openCents: 10825, orderedThisYearCents: 15825, lastOrder: { number: 'PO-0031', on: expect.any(String) } } });
  });
});
