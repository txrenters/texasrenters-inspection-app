import { UserRole } from '@prisma/client';

import { InvoiceBatchService, batchLines } from '../src/admin/invoice-batch.service';
import { InvoiceEditsService } from '../src/admin/invoice-edits.service';
import { nextInvoiceNumber } from '../src/admin/invoice-numbers';
import { InvoicesController } from '../src/admin/invoices.controller';
import { InvoicesService } from '../src/admin/invoices.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Making invoices (2026-11-06, phase 4): numbered next in the office's
 * sequence, for a property no visit covers, as drafts, and many at once from
 * the finished visits nobody has invoiced. Ids, names and addresses invented.
 */

const ORG = '20000000-0000-4000-8000-000000000001';
const VISIT = '20000000-0000-4000-8000-000000000010';
const VISIT_2 = '20000000-0000-4000-8000-000000000011';
const INVOICE = '20000000-0000-4000-8000-000000000020';
const BUILDING = '20000000-0000-4000-8000-000000000030';
const date = (day: string) => new Date(`${day}T00:00:00.000Z`);

const office: AuthenticatedUser = {
  id: '20000000-0000-4000-8000-000000000009',
  authUserId: 'auth-office',
  organizationId: ORG,
  displayName: 'Office Coordinator',
  roles: [UserRole.INSPECTION_SUPERVISOR],
  permissions: ['invoices:read', 'invoices:manage'],
  mustChangePassword: false,
  principalType: 'USER',
} as AuthenticatedUser;

const building = { id: BUILDING, name: 'Building 12', addressLine1: '100 Example Way', city: 'Sampletown' };
const report = (done: Record<string, boolean>) => ({
  services: Object.fromEntries(Object.entries(done).map(([service, yes]) => [service, { done: yes, reason: null, reschedule: false }])),
  filtersInstalled: [],
  notes: null,
});
const visit = (over: Record<string, unknown> = {}) => ({
  id: VISIT,
  inspectionType: 'OCCUPIED',
  scheduledAt: date('2026-11-02'),
  status: 'COMPLETED',
  jobberJobId: 'job-1',
  servicesReport: report({ filterChange: true, pestControl: true }),
  propertywareBuilding: building,
  ...over,
});
/** What the office billed in Jobber: it prices nothing any more (2026-11-12). */
const PRICES = [
  { name: 'Filter Change', unitPriceCents: 3999, _count: { _all: 40 } },
  { name: 'Pest Control', unitPriceCents: 2500, _count: { _all: 30 } },
];
/** The office's list, and what a visit bills of it (2026-11-12): an occupied visit a filter change, pest control where it was done. */
const product = (id: string, name: string, unitPriceCents: number, over: Record<string, unknown> = {}) => ({
  id,
  name,
  nameKey: name.toLowerCase(),
  description: null,
  unitPriceCents,
  active: true,
  xeroTenantId: null,
  updatedAt: new Date('2026-11-01T00:00:00.000Z'),
  ...over,
});
const PRODUCTS = [product('product-filter', 'Filter Change', 3999), product('product-pest', 'Pest Control', 2500), product('product-flea', 'Flea Treatment', 0)];
const RULES = [
  { id: 'rule-1', inspectionType: 'OCCUPIED' as const, service: null, productId: 'product-filter' },
  { id: 'rule-2', inspectionType: null, service: 'pestControl' as const, productId: 'product-pest' },
  { id: 'rule-3', inspectionType: null, service: 'fleaTreatment' as const, productId: 'product-flea' },
];
const BASIS = { rules: RULES, products: PRODUCTS };

function database() {
  const db = {
    invoice: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: INVOICE }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoiceLine: { groupBy: jest.fn().mockResolvedValue(PRICES) },
    // No invoice settings saved, and no price list: the fallbacks (2026-11-06, phase 6).
    invoiceSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    invoiceProduct: { findMany: jest.fn().mockResolvedValue(PRODUCTS) },
    invoiceBillingRule: { findMany: jest.fn().mockResolvedValue(RULES) },
    // No Xero organisation: every invoice belongs to no company (2026-11-10).
    xeroOrganisation: { findMany: jest.fn().mockResolvedValue([]) },
    invoicePayment: { aggregate: jest.fn().mockResolvedValue({ _sum: { amountCents: 0 }, _max: { paidOn: null } }) },
    inspection: { findFirst: jest.fn().mockResolvedValue(visit()), findMany: jest.fn().mockResolvedValue([]) },
    propertywareBuilding: { findFirst: jest.fn().mockResolvedValue(building) },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([{ highest: '8439' }]),
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((work: (tx: typeof db) => unknown) => work(db));
  return db;
}

const invoicesOver = (db: ReturnType<typeof database>) => {
  const service = new InvoicesService(db as never);
  jest.spyOn(service, 'one').mockResolvedValue({ id: INVOICE } as never);
  return service;
};

const create = {
  subject: 'For Services Rendered',
  issuedOn: '2026-11-03',
  paymentTermsDays: 30,
  lineItems: [{ name: 'Gate repair', quantity: 1, unitPriceCents: 12000 }],
  clientRequestId: 'web-key-0001',
};

beforeEach(() => {
  process.env.JOBBER_INVOICE_WRITES_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.JOBBER_INVOICE_WRITES_ENABLED;
});

describe("the office's next invoice number", () => {
  it('is one above the highest it has, behind a lock held until the write commits', async () => {
    const db = database();
    await expect(nextInvoiceNumber(db as never, ORG)).resolves.toBe('8440');
    const [lock, highest] = db.$queryRaw.mock.calls.map((call) => (call[0] as string[]).join('?'));
    expect(lock).toContain('pg_advisory_xact_lock');
    // Plain digits only: a number typed as "8439-A" is not where the sequence goes on from.
    expect(highest).toContain(`"number" ~ '^[0-9]{1,15}$'`);
    expect(db.$queryRaw.mock.calls[0]).toContain(`invoice-number:${ORG}`);
  });

  it('starts at 1 for an office with none', async () => {
    const db = database();
    db.$queryRaw.mockResolvedValue([{ highest: null }]);
    await expect(nextInvoiceNumber(db as never, ORG)).resolves.toBe('1');
  });
});

describe('making one invoice', () => {
  it('numbers it next in the sequence', async () => {
    const db = database();
    await invoicesOver(db).create(office, { ...create, inspectionId: VISIT });
    expect(db.invoice.create.mock.calls[0][0].data).toMatchObject({ number: '8440', status: 'AWAITING_PAYMENT', inspectionId: VISIT });
    expect(db.auditLog.create.mock.calls[0][0].data.metadata).toMatchObject({ number: '8440', draft: false });
  });

  it('makes one out to a property no visit covers', async () => {
    const db = database();
    await invoicesOver(db).create(office, { ...create, propertyId: BUILDING });
    expect(db.propertywareBuilding.findFirst).toHaveBeenCalledWith({
      where: { id: BUILDING, organizationId: ORG, isActive: true },
      select: { id: true, name: true, addressLine1: true, city: true },
    });
    expect(db.inspection.findFirst).not.toHaveBeenCalled();
    expect(db.invoice.create.mock.calls[0][0].data).toMatchObject({
      inspectionId: null,
      propertywareBuildingId: BUILDING,
      clientName: '100 Example Way',
      jobberJobId: null,
      totalCents: 12000,
    });
  });

  it('keeps a draft unnumbered, owed by nobody until it is marked sent', async () => {
    const db = database();
    await invoicesOver(db).create(office, { ...create, propertyId: BUILDING, asDraft: true });
    expect(db.invoice.create.mock.calls[0][0].data).toMatchObject({ number: null, status: 'DRAFT' });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('invoices a visit or a property, never both or neither', async () => {
    const service = invoicesOver(database());
    await expect(service.create(office, { ...create, inspectionId: VISIT, propertyId: BUILDING })).rejects.toMatchObject({
      code: 'INVOICE_INVALID',
    });
    await expect(service.create(office, create)).rejects.toMatchObject({ code: 'INVOICE_INVALID' });
  });

  it("refuses a property that is not the office's, or no longer active", async () => {
    const db = database();
    db.propertywareBuilding.findFirst.mockResolvedValue(null);
    await expect(invoicesOver(db).create(office, { ...create, propertyId: BUILDING })).rejects.toMatchObject({ code: 'PROPERTY_NOT_FOUND' });
  });

  it("answers a resend with the invoice it made, for the same property; another property's is a mistake", async () => {
    const db = database();
    db.invoice.findMany.mockResolvedValue([{ id: INVOICE, inspectionId: null, propertywareBuildingId: BUILDING, clientRequestId: 'web-key-0001' }]);
    const service = invoicesOver(db);
    await service.create(office, { ...create, propertyId: BUILDING });
    expect(db.invoice.create).not.toHaveBeenCalled();
    await expect(service.create(office, { ...create, propertyId: '20000000-0000-4000-8000-000000000031' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it("starts a property's draft with no lines and the office's wording", async () => {
    const db = database();
    db.invoice.findFirst.mockResolvedValue({ subject: 'Quarterly service', clientMessage: 'Thank you.', paymentTermsDays: 15 });
    const draft = await new InvoicesService(db as never).draft(office, { propertyId: BUILDING });
    expect(draft).toMatchObject({
      inspection: null,
      property: { id: BUILDING, address: '100 Example Way' },
      clientName: '100 Example Way',
      subject: 'Quarterly service',
      paymentTermsDays: 15,
      // One invoice, with no lines and no company chosen yet.
      invoices: [{ xeroTenantId: null, lineItems: [] }],
      existing: [],
    });
    // The office's list, and only it (2026-11-12).
    expect(draft.products.map((product) => product.name)).toEqual(['Filter Change', 'Pest Control', 'Flea Treatment']);
  });
});

describe('marking a draft sent', () => {
  const READ_AT = '2026-11-01T15:00:00.000Z';
  const draftRow = (number: string | null) => ({
    id: INVOICE,
    status: 'DRAFT',
    number,
    subject: 'For Services Rendered',
    issuedOn: date('2026-11-01'),
    dueOn: date('2026-12-01'),
    paidOn: null,
    totalCents: 12000,
    balanceCents: 12000,
    updatedAt: new Date(READ_AT),
    lines: [],
  });

  it('numbers an unnumbered draft next in the sequence, and keeps a number it has', async () => {
    const db = database();
    db.invoice.findFirst.mockResolvedValue(draftRow(null));
    const edits = new InvoiceEditsService(db as never, { one: jest.fn() } as never);
    await edits.changeStatus(office, INVOICE, { action: 'MARK_SENT', expectedUpdatedAt: READ_AT });
    expect(db.invoice.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'AWAITING_PAYMENT', number: '8440' });
    expect(db.auditLog.create.mock.calls[0][0].data.metadata).toMatchObject({ number: '8440' });

    const numbered = database();
    numbered.invoice.findFirst.mockResolvedValue(draftRow('8100'));
    await new InvoiceEditsService(numbered as never, { one: jest.fn() } as never).changeStatus(office, INVOICE, {
      action: 'MARK_SENT',
      expectedUpdatedAt: READ_AT,
    });
    expect(numbered.invoice.updateMany.mock.calls[0][0].data).not.toHaveProperty('number');
  });
});

describe('a batch', () => {
  const batchOver = (db: ReturnType<typeof database>) => new InvoiceBatchService(db as never, new InvoicesService(db as never));
  const input = { inspectionIds: [VISIT, VISIT_2], issuedOn: '2026-11-03', paymentTermsDays: 30, clientRequestId: 'web-batch-0001' };

  it("bills each visit as the office's rules say, at the list's prices, and says why one cannot be billed (2026-11-12)", () => {
    expect(batchLines(visit(), BASIS)).toEqual({
      lineItems: [
        { name: 'Filter Change', description: null, quantity: 1, unitPriceCents: 3999 },
        { name: 'Pest Control', description: null, quantity: 1, unitPriceCents: 2500 },
      ],
      totalCents: 6499,
      problem: null,
    });
    // Its type bills the filter change, whatever the report says.
    expect(batchLines(visit({ servicesReport: null }), BASIS).lineItems.map((line) => line.name)).toEqual(['Filter Change']);
    expect(batchLines(visit({ inspectionType: 'ROOF', servicesReport: report({}) }), BASIS)).toMatchObject({
      lineItems: [],
      problem: 'No rule says what this visit bills (Roof inspection). Add one under Invoices → Settings.',
    });
    expect(batchLines(visit({ servicesReport: report({ fleaTreatment: true }) }), BASIS).problem).toBe('No price yet for Flea Treatment. Set one under Invoices → Settings.');
    // Jobber's billing prices nothing.
    expect(batchLines(visit(), { rules: RULES, products: [] }).problem).toBe('A product a rule bills is set aside. Offer it again, or change the rule, under Invoices → Settings.');
  });

  it('lists the finished visits in the days asked for that have no invoice, in its own office', async () => {
    const db = database();
    db.inspection.findMany.mockResolvedValue([visit()]);
    const list = await batchOver(db).uninvoiced(office, { from: '2026-11-01', to: '2026-11-07' });

    expect(db.inspection.findMany.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      status: { in: expect.arrayContaining(['COMPLETED', 'TECHNICIAN_SUBMITTED']) },
      scheduledAt: { gte: date('2026-11-01'), lt: date('2026-11-08') },
      propertywareBuildingId: { not: null },
      invoices: { none: { status: { not: 'VOIDED' } } },
    });
    expect(list).toEqual({
      items: [
        expect.objectContaining({ inspectionId: VISIT, scheduledOn: '2026-11-02', clientName: '100 Example Way', totalCents: 6499, problem: null }),
      ],
      truncated: false,
      // The office's terms for the batch: its settings, else the latest invoice's, else Net 30.
      paymentTermsDays: 30,
    });
  });

  it('refuses days the wrong way round, or more than three months of them', async () => {
    const service = batchOver(database());
    await expect(service.uninvoiced(office, { from: '2026-11-07', to: '2026-11-01' })).rejects.toMatchObject({ code: 'INVOICE_BATCH_INVALID' });
    await expect(service.uninvoiced(office, { from: '2026-01-01', to: '2026-11-01' })).rejects.toMatchObject({ code: 'INVOICE_BATCH_INVALID' });
  });

  it('makes one numbered invoice per visit it can bill, keyed by the batch and the visit, and skips the rest with the reason', async () => {
    const db = database();
    db.inspection.findFirst
      .mockResolvedValueOnce(visit())
      .mockResolvedValueOnce(visit({ id: VISIT_2, inspectionType: 'ROOF', servicesReport: report({ filterChange: false }) }));
    db.invoice.create.mockResolvedValue({ id: INVOICE });

    const result = await batchOver(db).batch(office, input);

    expect(result).toEqual({
      created: [{ inspectionId: VISIT, invoiceId: INVOICE, number: '8440', totalCents: 6499, company: null }],
      skipped: [{ inspectionId: VISIT_2, reason: 'No rule says what this visit bills (Roof inspection). Add one under Invoices → Settings.' }],
    });
    expect(db.invoice.create.mock.calls[0][0].data).toMatchObject({
      inspectionId: VISIT,
      // Keyed by the batch, the visit, and its place among the visit's invoices.
      clientRequestId: `web-batch-0001:${VISIT}:1`,
      xeroTenantId: null,
      status: 'AWAITING_PAYMENT',
    });
    expect(db.auditLog.create.mock.calls[0][0].data.metadata).toMatchObject({ batch: 'web-batch-0001' });
  });

  it('skips a visit invoiced meanwhile, seen under the lock', async () => {
    const db = database();
    db.invoice.findFirst
      .mockResolvedValueOnce(null) // the office's latest invoice, for its wording
      .mockResolvedValueOnce({ id: 'someone-else' }); // invoiced a moment ago
    const result = await batchOver(db).batch(office, { ...input, inspectionIds: [VISIT] });
    expect(result.skipped).toEqual([{ inspectionId: VISIT, reason: 'The visit has an invoice already.' }]);
    expect(db.invoice.create).not.toHaveBeenCalled();
  });

  it('answers a resend with what the batch already made, making nothing twice', async () => {
    const db = database();
    const key = `web-batch-0001:${VISIT}:1`;
    db.invoice.findMany.mockImplementation(async ({ where }: { where: { clientRequestId?: { in: string[] } } }) =>
      where.clientRequestId?.in.includes(key) ? [{ id: INVOICE, number: '8440', totalCents: 6499, xeroTenantId: null, clientRequestId: key }] : [],
    );
    const result = await batchOver(db).batch(office, { ...input, inspectionIds: [VISIT] });
    expect(result.created).toEqual([{ inspectionId: VISIT, invoiceId: INVOICE, number: '8440', totalCents: 6499, company: null }]);
    expect(db.invoice.create).not.toHaveBeenCalled();
  });

  it('makes drafts when asked, unnumbered', async () => {
    const db = database();
    await batchOver(db).batch(office, { ...input, inspectionIds: [VISIT], asDraft: true });
    expect(db.invoice.create.mock.calls[0][0].data).toMatchObject({ number: null, status: 'DRAFT' });
  });

  it('is refused while Jobber holds the invoices, and for a day to come', async () => {
    const db = database();
    await expect(batchOver(db).batch(office, { ...input, issuedOn: '2099-01-01' })).rejects.toMatchObject({ code: 'INVOICE_BATCH_INVALID' });
    delete process.env.JOBBER_INVOICE_WRITES_ENABLED;
    await expect(batchOver(db).batch(office, input)).rejects.toMatchObject({ code: 'INVOICE_WRITES_OFF' });
    expect(db.invoice.create).not.toHaveBeenCalled();
  });
});

describe('who may do what', () => {
  const permissionsOf = (name: string) =>
    Reflect.getMetadata('permissions', (InvoicesController.prototype as unknown as Record<string, object>)[name]!) as string[];

  it('keeps the batch to the grant that makes invoices', () => {
    expect(permissionsOf('uninvoiced')).toEqual(['invoices:read', 'invoices:manage']);
    expect(permissionsOf('batch')).toEqual(['invoices:read', 'invoices:manage']);
  });
});
