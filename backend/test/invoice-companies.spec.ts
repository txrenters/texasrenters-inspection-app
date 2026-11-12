import { UserRole } from '@prisma/client';

import { InvoiceBatchService } from '../src/admin/invoice-batch.service';
import { InvoiceEditsService } from '../src/admin/invoice-edits.service';
import { InvoicesService } from '../src/admin/invoices.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * One invoice per company (2026-11-10, phase 3 of the multi-company plan):
 * each product or service goes to the Xero organisation the office chose for
 * it, a visit's services are split one invoice per company, and one invoice
 * never carries two companies' lines. Ids, names and addresses invented.
 */

const ORG = '30000000-0000-4000-8000-000000000001';
const VISIT = '30000000-0000-4000-8000-000000000010';
const BUILDING = '30000000-0000-4000-8000-000000000030';
const INVOICE = '30000000-0000-4000-8000-000000000020';
const HOMES = 'a1000000-0000-4000-8000-000000000001';
const PEST = 'a2000000-0000-4000-8000-000000000002';
const OLD = 'a3000000-0000-4000-8000-000000000003';
const READ_AT = '2026-11-09T15:00:00.000Z';
const date = (day: string) => new Date(`${day}T00:00:00.000Z`);

const office: AuthenticatedUser = {
  id: '30000000-0000-4000-8000-000000000009',
  authUserId: 'auth-office',
  organizationId: ORG,
  displayName: 'Office Coordinator',
  roles: [UserRole.INSPECTION_SUPERVISOR],
  permissions: ['invoices:read', 'invoices:manage'],
  mustChangePassword: false,
  principalType: 'USER',
} as AuthenticatedUser;

const product = (name: string, unitPriceCents: number, xeroTenantId: string | null) => ({
  id: `product-${name}`,
  name,
  nameKey: name.toLowerCase(),
  description: null,
  unitPriceCents,
  active: true,
  xeroTenantId,
  updatedAt: new Date(READ_AT),
});
/** The office's list: filter changes to one company's books, pest control to another's, a lockbox to none yet. */
const PRODUCTS = [product('Filter Change', 3999, HOMES), product('Pest Control', 2500, PEST), product('Lockbox Install', 3000, null)];
/** What a visit bills (2026-11-12): a filter change and pest control wherever they were done. */
const RULES = [
  { id: 'rule-filter', inspectionType: null, service: 'filterChange', productId: 'product-Filter Change' },
  { id: 'rule-pest', inspectionType: null, service: 'pestControl', productId: 'product-Pest Control' },
];
/** Two companies connected, one no longer. */
const ORGANISATIONS = [
  { xeroTenantId: HOMES, name: 'Example Home Services', status: 'CONNECTED' },
  { xeroTenantId: PEST, name: 'Example Pest Co', status: 'CONNECTED' },
  { xeroTenantId: OLD, name: 'Old Books LLC', status: 'REMOVED' },
];

const building = { id: BUILDING, name: 'Building 12', addressLine1: '100 Example Way', city: 'Sampletown' };
const report = (done: Record<string, boolean>) => ({
  services: Object.fromEntries(Object.entries(done).map(([service, yes]) => [service, { done: yes, reason: null, reschedule: false }])),
  filtersInstalled: [],
  notes: null,
});
const visit = (over: Record<string, unknown> = {}) => ({
  id: VISIT,
  inspectionType: 'BENEFIT_PACKAGE',
  scheduledAt: date('2026-11-02'),
  status: 'COMPLETED',
  jobberJobId: 'job-1',
  servicesReport: report({ filterChange: true, pestControl: true }),
  propertywareBuilding: building,
  ...over,
});

/** An invoice as the list reads it, for the answer to a form. */
const summaryRow = (id: string, number: string, xeroTenantId: string | null) => ({
  id,
  number,
  subject: 'For Services Rendered',
  status: 'AWAITING_PAYMENT',
  clientName: '100 Example Way',
  inspectionId: VISIT,
  jobNumber: null,
  issuedOn: date('2026-11-03'),
  dueOn: date('2099-12-03'),
  totalCents: 3999,
  balanceCents: 3999,
  jobberWebUrl: null,
  propertywareBuilding: building,
  xeroOrganisation: xeroTenantId ? { xeroTenantId, name: ORGANISATIONS.find((row) => row.xeroTenantId === xeroTenantId)!.name } : null,
});

function database() {
  const db = {
    // Which companies' books are read from Xero (2026-11-12): none here.
    xeroSettings: { findMany: jest.fn().mockResolvedValue([]) },
    invoice: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: {}, _max: { syncedAt: null } }),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoiceLine: { groupBy: jest.fn().mockResolvedValue([]), deleteMany: jest.fn(), createMany: jest.fn() },
    invoiceSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    invoiceProduct: { findMany: jest.fn().mockResolvedValue(PRODUCTS) },
    invoiceBillingRule: { findMany: jest.fn().mockResolvedValue(RULES) },
    xeroOrganisation: { findMany: jest.fn().mockResolvedValue(ORGANISATIONS) },
    invoicePayment: { aggregate: jest.fn().mockResolvedValue({ _sum: { amountCents: 0 }, _max: { paidOn: null } }) },
    inspection: { findFirst: jest.fn().mockResolvedValue(visit()), findMany: jest.fn().mockResolvedValue([]) },
    propertywareBuilding: { findFirst: jest.fn().mockResolvedValue(building) },
    jobberConnection: { findUnique: jest.fn().mockResolvedValue(null) },
    auditLog: { create: jest.fn() },
    // The number lock, then the highest number the office has: one more for each invoice made.
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  db.invoice.create.mockImplementation(async () => ({ id: `invoice-${db.invoice.create.mock.calls.length}` }));
  db.$queryRaw.mockImplementation(async () => [{ highest: String(8439 + db.invoice.create.mock.calls.length) }]);
  db.$transaction.mockImplementation((work: (tx: typeof db) => unknown) => work(db));
  return db;
}

const form = {
  inspectionId: VISIT,
  subject: 'For Services Rendered',
  issuedOn: '2026-11-03',
  paymentTermsDays: 30,
  clientRequestId: 'web-form-0001',
};
const filter = { name: 'Filter Change', quantity: 1, unitPriceCents: 3999 };
const pest = { name: 'Pest Control', quantity: 1, unitPriceCents: 2500 };
const typed = { name: 'Trip charge', quantity: 1, unitPriceCents: 1500 };

beforeEach(() => {
  process.env.JOBBER_INVOICE_WRITES_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.JOBBER_INVOICE_WRITES_ENABLED;
});

describe("a finished visit's draft", () => {
  it('is one invoice per company: each company’s services on its own', async () => {
    const draft = await new InvoicesService(database() as never).draft(office, { inspectionId: VISIT });
    expect(draft.invoices).toEqual([
      { xeroTenantId: HOMES, lineItems: [{ name: 'Filter Change', description: null, quantity: 1, unitPriceCents: 3999 }] },
      { xeroTenantId: PEST, lineItems: [{ name: 'Pest Control', description: null, quantity: 1, unitPriceCents: 2500 }] },
    ]);
    // What each can go to, connected ones first, and each product's company for a line added by hand.
    expect(draft.organisations).toEqual([
      { tenantId: HOMES, name: 'Example Home Services', connected: true },
      { tenantId: PEST, name: 'Example Pest Co', connected: true },
      { tenantId: OLD, name: 'Old Books LLC', connected: false },
    ]);
    expect(draft.products.find((item) => item.name === 'Pest Control')).toMatchObject({ xeroTenantId: PEST });
  });

  it('keeps the services that go to no company on an invoice of their own', async () => {
    const db = database();
    db.invoiceProduct.findMany.mockResolvedValue([product('Filter Change', 3999, HOMES), product('Pest Control', 2500, null)]);
    const draft = await new InvoicesService(db as never).draft(office, { inspectionId: VISIT });
    expect(draft.invoices.map((part) => [part.xeroTenantId, part.lineItems.map((line) => line.name)])).toEqual([
      [HOMES, ['Filter Change']],
      [null, ['Pest Control']],
    ]);
  });
});

describe('the invoices one form makes', () => {
  it('makes one per company, together, each numbered next and keyed by the form', async () => {
    const db = database();
    db.invoice.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([summaryRow('invoice-2', '8441', PEST), summaryRow('invoice-1', '8440', HOMES)]);

    const made = await new InvoicesService(db as never).createPerCompany(office, {
      ...form,
      invoices: [
        { xeroTenantId: HOMES, lineItems: [filter] },
        { xeroTenantId: PEST, lineItems: [pest] },
      ],
    });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.invoice.create.mock.calls.map((call) => call[0].data)).toEqual([
      expect.objectContaining({ number: '8440', xeroTenantId: HOMES, clientRequestId: 'web-form-0001:1', totalCents: 3999 }),
      expect.objectContaining({ number: '8441', xeroTenantId: PEST, clientRequestId: 'web-form-0001:2', totalCents: 2500 }),
    ]);
    expect(db.auditLog.create.mock.calls.map((call) => call[0].data.metadata.xeroTenantId)).toEqual([HOMES, PEST]);
    // In the order asked for, each saying whose books it goes to.
    expect(made.invoices.map((invoice) => [invoice.number, invoice.company])).toEqual([
      ['8440', { tenantId: HOMES, name: 'Example Home Services' }],
      ['8441', { tenantId: PEST, name: 'Example Pest Co' }],
    ]);
  });

  it('works out a company left out from the lines', async () => {
    const db = database();
    db.invoice.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([summaryRow('invoice-1', '8440', PEST)]);
    await new InvoicesService(db as never).createPerCompany(office, { ...form, invoices: [{ lineItems: [pest, typed] }] });
    expect(db.invoice.create.mock.calls[0][0].data).toMatchObject({ xeroTenantId: PEST, totalCents: 4000 });
  });

  it('refuses two invoices for one company, and makes neither', async () => {
    const db = database();
    await expect(
      new InvoicesService(db as never).createPerCompany(office, {
        ...form,
        invoices: [{ lineItems: [filter] }, { xeroTenantId: HOMES, lineItems: [typed] }],
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_INVALID', message: 'Two invoices go to Example Home Services: put their lines on one.' });
    expect(db.invoice.create).not.toHaveBeenCalled();
  });

  it('makes none when one of them cannot be made', async () => {
    const db = database();
    await expect(
      new InvoicesService(db as never).createPerCompany(office, {
        ...form,
        invoices: [
          { xeroTenantId: HOMES, lineItems: [filter] },
          { xeroTenantId: PEST, lineItems: [{ ...pest, unitPriceCents: 0 }] },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_INVALID', message: 'The invoice for Example Pest Co: The invoice comes to nothing.' });
    expect(db.invoice.create).not.toHaveBeenCalled();
  });

  it('answers a resend with what it made; the same key for another set of invoices is a mistake', async () => {
    const db = database();
    const made = [
      { id: 'invoice-1', inspectionId: VISIT, propertywareBuildingId: BUILDING, clientRequestId: 'web-form-0001:1' },
      { id: 'invoice-2', inspectionId: VISIT, propertywareBuildingId: BUILDING, clientRequestId: 'web-form-0001:2' },
    ];
    db.invoice.findMany.mockResolvedValueOnce(made).mockResolvedValueOnce([summaryRow('invoice-1', '8440', HOMES), summaryRow('invoice-2', '8441', PEST)]);
    const service = new InvoicesService(db as never);
    const invoices = [
      { xeroTenantId: HOMES, lineItems: [filter] },
      { xeroTenantId: PEST, lineItems: [pest] },
    ];
    await expect(service.createPerCompany(office, { ...form, invoices })).resolves.toMatchObject({ invoices: [{ id: 'invoice-1' }, { id: 'invoice-2' }] });
    expect(db.invoice.create).not.toHaveBeenCalled();

    db.invoice.findMany.mockResolvedValueOnce(made);
    await expect(
      service.createPerCompany(office, { ...form, invoices: [...invoices, { xeroTenantId: null, lineItems: [typed] }] }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});

describe('one invoice', () => {
  const create = { ...form, lineItems: [filter] };
  const invoices = (db: ReturnType<typeof database>) => {
    const service = new InvoicesService(db as never);
    jest.spyOn(service, 'one').mockResolvedValue({ id: INVOICE } as never);
    return service;
  };

  it('goes to its lines’ company', async () => {
    const db = database();
    await invoices(db).create(office, create);
    expect(db.invoice.create.mock.calls[0][0].data).toMatchObject({ xeroTenantId: HOMES, clientRequestId: 'web-form-0001' });
  });

  it('never carries two companies’ lines', async () => {
    const db = database();
    await expect(invoices(db).create(office, { ...create, lineItems: [filter, pest] })).rejects.toMatchObject({
      code: 'INVOICE_INVALID',
      message: 'Filter Change goes to Example Home Services and Pest Control to Example Pest Co: make one invoice for each company.',
    });
    expect(db.invoice.create).not.toHaveBeenCalled();
  });

  it('refuses a line of another company than the one chosen', async () => {
    await expect(invoices(database()).create(office, { ...create, xeroTenantId: PEST })).rejects.toMatchObject({
      code: 'INVOICE_INVALID',
      message: 'Filter Change goes to Example Home Services, not to Example Pest Co: it belongs on the invoice for Example Home Services.',
    });
  });

  it('goes to the company chosen when no line says, only one connected now', async () => {
    const db = database();
    await invoices(db).create(office, { ...create, lineItems: [typed], xeroTenantId: PEST });
    expect(db.invoice.create.mock.calls[0][0].data).toMatchObject({ xeroTenantId: PEST });

    for (const tenantId of [OLD, 'b9000000-0000-4000-8000-000000000009'])
      await expect(invoices(database()).create(office, { ...create, lineItems: [typed], xeroTenantId: tenantId })).rejects.toMatchObject({
        code: 'INVOICE_INVALID',
        message: 'That Xero organisation is not connected.',
      });
  });

  it('keeps a product’s company though the organisation was since disconnected: it is sent once it is back', async () => {
    const db = database();
    db.invoiceProduct.findMany.mockResolvedValue([product('Filter Change', 3999, OLD)]);
    await invoices(db).create(office, { ...create, xeroTenantId: OLD });
    expect(db.invoice.create.mock.calls[0][0].data).toMatchObject({ xeroTenantId: OLD });
  });

  it('belongs to no company when nothing says, as before Xero', async () => {
    const db = database();
    db.invoiceProduct.findMany.mockResolvedValue([]);
    db.xeroOrganisation.findMany.mockResolvedValue([]);
    await invoices(db).create(office, { ...create, lineItems: [filter, pest] });
    expect(db.invoice.create.mock.calls[0][0].data).toMatchObject({ xeroTenantId: null });
  });
});

describe('a batch', () => {
  const batchOver = (db: ReturnType<typeof database>) => new InvoiceBatchService(db as never, new InvoicesService(db as never));

  it('lists each visit’s invoices, one per company', async () => {
    const db = database();
    db.inspection.findMany.mockResolvedValue([visit()]);
    const list = await batchOver(db).uninvoiced(office, { from: '2026-11-01', to: '2026-11-07' });
    expect(list.items[0]!.invoices).toEqual([
      { xeroTenantId: HOMES, company: 'Example Home Services', lineItems: [expect.objectContaining({ name: 'Filter Change' })], totalCents: 3999, toXero: false },
      { xeroTenantId: PEST, company: 'Example Pest Co', lineItems: [expect.objectContaining({ name: 'Pest Control' })], totalCents: 2500, toXero: false },
    ]);
    expect(list.items[0]!.totalCents).toBe(6499);
  });

  it('makes the invoice of a company that sends to Xero a draft with no number of its own (2026-11-12): Xero numbers it there', async () => {
    const db = database();
    db.xeroSettings.findMany.mockResolvedValue([{ xeroTenantId: HOMES }]);
    db.inspection.findMany.mockResolvedValue([visit()]);
    const list = await batchOver(db).uninvoiced(office, { from: '2026-11-01', to: '2026-11-07' });
    expect(list.items[0]!.invoices.map((part) => [part.company, part.toXero])).toEqual([
      ['Example Home Services', true],
      ['Example Pest Co', false],
    ]);

    const result = await batchOver(db).batch(office, { inspectionIds: [VISIT], issuedOn: '2026-11-03', paymentTermsDays: 30, clientRequestId: 'web-batch-0002' });
    expect(result.created.map((made) => [made.company, made.number])).toEqual([
      ['Example Home Services', null],
      ['Example Pest Co', expect.stringMatching(/^\d+$/)],
    ]);
    expect(db.invoice.create.mock.calls.map((call) => [call[0].data.xeroTenantId, call[0].data.status, call[0].data.number])).toEqual([
      [HOMES, 'DRAFT', null],
      [PEST, 'AWAITING_PAYMENT', expect.stringMatching(/^\d+$/)],
    ]);
  });

  it('lists visits only from the day the console began making the invoices (2026-11-12): those before were billed in Jobber or Xero', async () => {
    const db = database();
    db.invoiceSettings.findUnique.mockImplementation(async ({ select }: { select: Record<string, unknown> }) =>
      'invoicingTakenOverAt' in select ? { invoicingTakenOverAt: new Date('2026-11-04T15:00:00.000Z') } : null,
    );
    db.inspection.findMany.mockResolvedValue([]);
    const list = await batchOver(db).uninvoiced(office, { from: '2026-11-01', to: '2026-11-07' });
    expect(list.startsOn).toBe('2026-11-04');
    expect(db.inspection.findMany.mock.calls[0][0].where.scheduledAt).toEqual({
      gte: new Date('2026-11-04T00:00:00.000Z'),
      lt: new Date('2026-11-08T00:00:00.000Z'),
    });
  });

  it('makes a visit’s invoices together, each to its company, keyed by its place', async () => {
    const db = database();
    const result = await batchOver(db).batch(office, { inspectionIds: [VISIT], issuedOn: '2026-11-03', paymentTermsDays: 30, clientRequestId: 'web-batch-0001' });
    expect(result).toEqual({
      created: [
        { inspectionId: VISIT, invoiceId: 'invoice-1', number: '8440', totalCents: 3999, company: 'Example Home Services' },
        { inspectionId: VISIT, invoiceId: 'invoice-2', number: '8441', totalCents: 2500, company: 'Example Pest Co' },
      ],
      skipped: [],
    });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.invoice.create.mock.calls.map((call) => [call[0].data.clientRequestId, call[0].data.xeroTenantId])).toEqual([
      [`web-batch-0001:${VISIT}:1`, HOMES],
      [`web-batch-0001:${VISIT}:2`, PEST],
    ]);
  });
});

describe('an edit', () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    id: INVOICE,
    origin: 'CONSOLE',
    status: 'AWAITING_PAYMENT',
    number: '8440',
    subject: 'For Services Rendered',
    issuedOn: date('2026-11-01'),
    dueOn: date('2099-12-01'),
    paidOn: null,
    totalCents: 3999,
    balanceCents: 3999,
    discountCents: 0,
    discountRate: null,
    discountKind: null,
    taxRateName: null,
    taxRatePercent: null,
    clientMessage: null,
    contractDisclaimer: null,
    updatedAt: new Date(READ_AT),
    xeroTenantId: HOMES,
    xeroSync: null,
    lines: [{ name: 'Filter Change', quantity: 1, unitPriceCents: 3999, description: null, serviceOn: null, taxable: true }],
    ...over,
  });
  const edit = (lineItems: { name: string; quantity: number; unitPriceCents: number }[]) => ({
    subject: 'For Services Rendered',
    number: '8440',
    issuedOn: '2026-11-01',
    dueOn: '2099-12-01',
    lineItems,
    discount: null,
    tax: null,
    clientMessage: null,
    contractDisclaimer: null,
    expectedUpdatedAt: READ_AT,
  });
  const editsOver = (row: Record<string, unknown>) => {
    const db = database();
    db.invoice.findFirst.mockResolvedValue(row);
    return { db, edits: new InvoiceEditsService(db as never, { one: jest.fn().mockResolvedValue({ id: INVOICE }) } as never) };
  };
  const changes = (db: ReturnType<typeof database>) => db.auditLog.create.mock.calls[0][0].data.metadata.changes as { field: string }[];

  it('moves to its lines’ company, on the record, while it is not in Xero yet', async () => {
    const { db, edits } = editsOver(stored());
    await edits.edit(office, INVOICE, edit([pest]));
    expect(db.invoice.updateMany.mock.calls[0][0].data).toMatchObject({ xeroTenantId: PEST });
    expect(changes(db)).toContainEqual({ field: 'Company', from: 'Example Home Services', to: 'Example Pest Co' });
  });

  it('stays where it is when no line says', async () => {
    const { db, edits } = editsOver(stored());
    await edits.edit(office, INVOICE, edit([typed]));
    expect(db.invoice.updateMany.mock.calls[0][0].data).toMatchObject({ xeroTenantId: HOMES });
    expect(changes(db).map((change) => change.field)).not.toContain('Company');
  });

  it('never moves to another company once it is in a company’s books in Xero', async () => {
    const { db, edits } = editsOver(stored({ xeroSync: { xeroInvoiceId: 'xero-1' } }));
    await expect(edits.edit(office, INVOICE, edit([pest]))).rejects.toMatchObject({ code: 'INVOICE_IN_XERO' });
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
  });

  it('never takes two companies’ lines', async () => {
    const { db, edits } = editsOver(stored());
    await expect(edits.edit(office, INVOICE, edit([filter, pest]))).rejects.toMatchObject({ code: 'INVOICE_INVALID' });
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
  });

  it('lets one made before invoices had a company, already on two, be corrected: it stays with none', async () => {
    const mixed = stored({ xeroTenantId: null, lines: [...stored().lines, { ...pest, description: null, serviceOn: null, taxable: true }] });
    const { db, edits } = editsOver(mixed);
    await edits.edit(office, INVOICE, edit([filter, { ...pest, unitPriceCents: 2600 }]));
    expect(db.invoice.updateMany.mock.calls[0][0].data).toMatchObject({ xeroTenantId: null });
  });

  it('leaves one read from Jobber with no company: Jobber’s are not sent', async () => {
    const { db, edits } = editsOver(stored({ origin: 'JOBBER', xeroTenantId: null }));
    await edits.edit(office, INVOICE, edit([filter, pest]));
    expect(db.invoice.updateMany.mock.calls[0][0].data).toMatchObject({ xeroTenantId: null });
    expect(db.invoiceProduct.findMany).not.toHaveBeenCalled();
  });
});

describe('the list', () => {
  it('shows one company’s invoices, or those of none, and the organisations to choose from', async () => {
    const db = database();
    const service = new InvoicesService(db as never);
    const list = await service.list(office, { company: PEST });
    expect(db.invoice.findMany.mock.calls[0][0].where.AND[0]).toMatchObject({ organizationId: ORG, xeroTenantId: PEST });
    expect(list.organisations).toHaveLength(3);

    await service.list(office, { company: 'none' });
    expect(db.invoice.findMany.mock.calls[1][0].where.AND[0]).toMatchObject({ organizationId: ORG, xeroTenantId: null });
  });
});
