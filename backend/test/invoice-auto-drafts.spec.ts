import { Prisma, UserRole } from '@prisma/client';

import { InvoiceAutoDraftsScheduler } from '../src/admin/invoice-auto-drafts.scheduler';
import { InvoiceAutoDraftsService, MAX_AUTO_DRAFTS_PER_RUN } from '../src/admin/invoice-auto-drafts.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Draft invoices automatically (2026-11-13; the office: "as long as the jobs
 * are done ... we should automatically draft that too so accounting will only
 * double check them"). Each visit finished since the switch went on is
 * invoiced by itself, by the office's rules, one invoice per company, dated as
 * the New invoice dates them. Ids, names and addresses invented.
 */

const ORG = '40000000-0000-4000-8000-000000000001';
const BUILDING = '40000000-0000-4000-8000-000000000030';
const HOMES = 'b1000000-0000-4000-8000-000000000001';
const PEST = 'b2000000-0000-4000-8000-000000000002';
const ON_SINCE = new Date('2026-11-13T20:00:00.000Z');
const date = (day: string) => new Date(`${day}T00:00:00.000Z`);

const office: AuthenticatedUser = {
  id: '40000000-0000-4000-8000-000000000009',
  authUserId: 'auth-office',
  organizationId: ORG,
  displayName: 'Office Coordinator',
  roles: [UserRole.INSPECTION_SUPERVISOR],
  permissions: ['invoices:read', 'invoices:manage'],
  mustChangePassword: false,
  principalType: 'USER',
} as AuthenticatedUser;

const product = (id: string, name: string, unitPriceCents: number, xeroTenantId: string | null) => ({
  id,
  name,
  nameKey: name.toLowerCase(),
  description: null,
  unitPriceCents,
  active: true,
  xeroTenantId,
});
const PRODUCTS = [
  product('filter', 'Filter Change', 3999, HOMES),
  product('pest-small', 'Pest Control: House under 2,000 sq. ft', 3900, PEST),
  product('pest-large', 'Pest Control: House over 2,000 sq ft', 3900, PEST),
];
/** An occupied visit bills its filter change; pest control done bills by the house's size. */
const RULES = [
  { id: 'rule-occupied', inspectionType: 'OCCUPIED', service: null, productId: 'filter', largeFromSqFt: null, largeProductId: null },
  { id: 'rule-pest', inspectionType: null, service: 'pestControl', productId: 'pest-small', largeFromSqFt: 2000, largeProductId: 'pest-large' },
];

const report = (done: Record<string, boolean>) => ({
  services: Object.fromEntries(Object.entries(done).map(([service, yes]) => [service, { done: yes, reason: null, reschedule: false }])),
  filtersInstalled: [],
  notes: null,
});
const visit = (n: number, over: Record<string, unknown> = {}) => ({
  id: `40000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}`,
  inspectionType: 'OCCUPIED',
  scheduledAt: date('2026-11-13'),
  status: 'TECHNICIAN_SUBMITTED',
  jobberJobId: `job-${n}`,
  servicesReport: report({ filterChange: true, pestControl: true }),
  propertywareBuilding: { id: BUILDING, name: 'Building 12', addressLine1: '100 Example Way', city: 'Sampletown', totalArea: 2887, manualTotalArea: null },
  ...over,
});

function database(settings: Record<string, unknown> = { autoDraftsFrom: ON_SINCE, invoicingTakenOverAt: new Date('2026-11-12T14:14:00.000Z') }) {
  const db = {
    invoiceSettings: {
      findUnique: jest.fn().mockResolvedValue(settings),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn(),
    },
    // Both companies send to Xero, from the switch day.
    xeroSettings: { findMany: jest.fn().mockResolvedValue([{ xeroTenantId: HOMES, sendFrom: date('2026-11-12') }, { xeroTenantId: PEST, sendFrom: date('2026-11-12') }]) },
    xeroOrganisation: {
      findMany: jest.fn().mockResolvedValue([
        { xeroTenantId: HOMES, name: 'Example Home Services', status: 'CONNECTED' },
        { xeroTenantId: PEST, name: 'Example Pest Co', status: 'CONNECTED' },
      ]),
    },
    invoiceProduct: { findMany: jest.fn().mockResolvedValue(PRODUCTS) },
    invoiceBillingRule: { findMany: jest.fn().mockResolvedValue(RULES) },
    inspection: { findMany: jest.fn().mockResolvedValue([visit(1)]) },
    invoice: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([{ locked: '' }]),
    $transaction: jest.fn(),
  };
  db.invoice.create.mockImplementation(async () => ({ id: `invoice-${db.invoice.create.mock.calls.length}` }));
  db.$transaction.mockImplementation((work: (tx: typeof db) => unknown) => work(db));
  return db;
}

const NOW = new Date('2026-11-13T21:30:00.000Z');
beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
});
afterEach(() => jest.useRealTimers());

describe('drafting a finished visit’s invoices by itself', () => {
  it('drafts nothing while the switch is off', async () => {
    const db = database({ autoDraftsFrom: null, invoicingTakenOverAt: new Date('2026-11-12T14:14:00.000Z') });
    expect(await new InvoiceAutoDraftsService(db as never).run(ORG)).toEqual({ drafted: 0, left: 0 });
    expect(db.inspection.findMany).not.toHaveBeenCalled();
    expect(db.invoice.create).not.toHaveBeenCalled();
  });

  it('looks only at visits finished since it went on, with no invoice ever, that the technician got into', async () => {
    const db = database();
    db.inspection.findMany.mockResolvedValue([]);
    await new InvoiceAutoDraftsService(db as never).run(ORG);
    const where = db.inspection.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ organizationId: ORG, propertywareBuildingId: { not: null }, invoices: { none: {} } });
    expect(where.AND).toEqual([
      { OR: [{ submittedAt: { gte: ON_SINCE } }, { completedAt: { gte: ON_SINCE } }] },
      { OR: [{ completionBlockedReason: null }, { NOT: { completionBlockedReason: { startsWith: 'Could not get in' } } }] },
    ]);
  });

  it('makes one draft per company, dated on the visit’s day and due at the month’s end, made by nobody', async () => {
    const db = database();
    expect(await new InvoiceAutoDraftsService(db as never).run(ORG)).toEqual({ drafted: 1, left: 0 });

    const made = db.invoice.create.mock.calls.map((call) => call[0].data);
    expect(made).toHaveLength(2);
    expect(made.map((data) => [data.xeroTenantId, data.lines.create.map((line: { name: string }) => line.name)])).toEqual([
      [HOMES, ['Filter Change']],
      // A house of 2,887 sq ft: pest control's larger item.
      [PEST, ['Pest Control: House over 2,000 sq ft']],
    ]);
    for (const data of made)
      expect(data).toMatchObject({
        status: 'DRAFT',
        number: null,
        issuedOn: date('2026-11-13'),
        dueOn: date('2026-11-30'),
        paymentTermsDays: 17,
        xeroDatesChosen: true,
        xeroReference: '100 Example Way',
        clientName: '100 Example Way',
        subject: 'For Services Rendered',
      });
    expect(made.map((data) => data.clientRequestId)).toEqual([`auto:${visit(1).id}:1`, `auto:${visit(1).id}:2`]);
    expect(made.every((data) => data.createdById === undefined)).toBe(true);
    expect(db.auditLog.create.mock.calls.map((call) => [call[0].data.action, call[0].data.actorUserId, call[0].data.metadata.batch])).toEqual([
      ['INVOICE_CREATED', undefined, 'automatic'],
      ['INVOICE_CREATED', undefined, 'automatic'],
    ]);
  });

  it('leaves a visit no rule covers for the office, and drafts at most 50 of a backlog of 200 in a run', async () => {
    const db = database();
    db.inspection.findMany.mockResolvedValue([
      // Move-ins bill nothing here: no rule.
      visit(0, { inspectionType: 'MOVE_IN', servicesReport: null }),
      ...Array.from({ length: 199 }, (_, index) => visit(index + 1, { servicesReport: report({ filterChange: true }) })),
    ]);
    expect(await new InvoiceAutoDraftsService(db as never).run(ORG)).toEqual({ drafted: MAX_AUTO_DRAFTS_PER_RUN, left: 1 });
    expect(db.invoice.create).toHaveBeenCalledTimes(MAX_AUTO_DRAFTS_PER_RUN);
    expect(db.inspection.findMany.mock.calls[0][0].take).toBe(200);
  });

  it('passes over a visit another server drafted a moment ago', async () => {
    const db = database();
    db.invoice.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('taken', { code: 'P2002', clientVersion: 'test' }));
    expect(await new InvoiceAutoDraftsService(db as never).run(ORG)).toEqual({ drafted: 0, left: 0 });
  });

  it('drafts nothing before the console makes the invoices', async () => {
    const db = database({ autoDraftsFrom: ON_SINCE, invoicingTakenOverAt: null });
    expect(await new InvoiceAutoDraftsService(db as never).run(ORG)).toEqual({ drafted: 0, left: 0 });
    expect(db.invoice.create).not.toHaveBeenCalled();
  });
});

describe('the switch', () => {
  it('goes on from now, against the switch as it was read, and is on the record', async () => {
    const db = database({ autoDraftsFrom: null, autoDraftsUpdatedAt: null, invoicingTakenOverAt: new Date('2026-11-12T14:14:00.000Z') });
    db.invoiceSettings.updateMany.mockResolvedValue({ count: 0 });
    await new InvoiceAutoDraftsService(db as never).save(office, { on: true, expectedUpdatedAt: null });
    expect(db.invoiceSettings.create).toHaveBeenCalledWith({ data: { organizationId: ORG, autoDraftsFrom: NOW, autoDraftsUpdatedAt: NOW } });
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({
      actorUserId: office.id,
      action: 'INVOICE_AUTO_DRAFTS_CHANGED',
      metadata: { changes: ['Draft invoices automatically: off → on'] },
    });
  });

  it('refuses a change made against an old read, and turning it on before the console makes the invoices', async () => {
    const stamp = new Date('2026-11-13T19:00:00.000Z');
    const db = database({ autoDraftsFrom: null, autoDraftsUpdatedAt: stamp, invoicingTakenOverAt: new Date('2026-11-12T14:14:00.000Z') });
    await expect(new InvoiceAutoDraftsService(db as never).save(office, { on: true, expectedUpdatedAt: null })).rejects.toMatchObject({ code: 'INVOICE_SETTINGS_CHANGED' });

    const early = database({ autoDraftsFrom: null, autoDraftsUpdatedAt: null, invoicingTakenOverAt: null });
    await expect(new InvoiceAutoDraftsService(early as never).save(office, { on: true, expectedUpdatedAt: null })).rejects.toMatchObject({
      code: 'INVOICE_AUTO_DRAFTS_TOO_EARLY',
    });
    expect(early.auditLog.create).not.toHaveBeenCalled();
  });

  it('goes off as read', async () => {
    const stamp = new Date('2026-11-13T19:00:00.000Z');
    const db = database({ autoDraftsFrom: ON_SINCE, autoDraftsUpdatedAt: stamp, invoicingTakenOverAt: new Date('2026-11-12T14:14:00.000Z') });
    await new InvoiceAutoDraftsService(db as never).save(office, { on: false, expectedUpdatedAt: stamp.toISOString() });
    expect(db.invoiceSettings.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, autoDraftsUpdatedAt: stamp },
      data: { autoDraftsFrom: null, autoDraftsUpdatedAt: NOW },
    });
  });
});

describe('the schedule', () => {
  it('runs each office whose switch is on, and one office’s trouble stops no other', async () => {
    const prisma = { invoiceSettings: { findMany: jest.fn().mockResolvedValue([{ organizationId: ORG }, { organizationId: 'other-org' }]) } };
    const drafts = { run: jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ drafted: 1, left: 0 }) };
    await new InvoiceAutoDraftsScheduler(prisma as never, drafts as never).tick();
    expect(prisma.invoiceSettings.findMany).toHaveBeenCalledWith({ where: { autoDraftsFrom: { not: null } }, select: { organizationId: true } });
    expect(drafts.run.mock.calls).toEqual([[ORG], ['other-org']]);
  });
});
