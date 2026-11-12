import { EMPTY_INVOICE_SETTINGS, billingRuleProblem, invoiceProductProblem, invoiceSettingsProblem } from '@texasrenters/shared';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma, UserRole } from '@prisma/client';

import { insertConsoleInvoice } from '../src/admin/invoice-insert';
import { AddBillingRulesDto, InvoiceSettingsController } from '../src/admin/invoice-settings.controller';
import { InvoiceSettingsService } from '../src/admin/invoice-settings.service';
import { brandFrom, defaultsFrom, newInvoiceDefaults, officeBrand, officePrices } from '../src/admin/invoice-settings';
import { InvoicesService } from '../src/admin/invoices.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * The office's invoice settings (2026-11-06, phase 6): the company details,
 * what a new invoice starts with, and the products and services at its
 * prices. Every blank setting falls back to what the console used before.
 * Database only: nothing billed, nothing sent to Jobber. Names invented.
 */

const ORG = '20000000-0000-4000-8000-000000000001';
const BUILDING = '20000000-0000-4000-8000-000000000030';
const PRODUCT = '20000000-0000-4000-8000-000000000040';
const SAVED_AT = new Date('2026-11-06T15:00:00.000Z');

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

const SERVER_BRAND = { name: 'Server Co', addressLine1: '1 Server Plaza', addressLine2: null, phone: '555-0100', email: null };

const settingsRow = (over: Record<string, unknown> = {}) => ({ ...EMPTY_INVOICE_SETTINGS, updatedAt: SAVED_AT, ...over });
const product = (over: Record<string, unknown> = {}) => ({
  id: PRODUCT,
  name: 'Filter Change',
  nameKey: 'filter change',
  description: 'One filter, any size',
  unitPriceCents: 4500,
  active: true,
  xeroTenantId: null,
  updatedAt: SAVED_AT,
  ...over,
});
/** The companies' books in Xero: two connected, one no longer. */
const HOMES = 'a1000000-0000-4000-8000-000000000001';
const PEST = 'a2000000-0000-4000-8000-000000000002';
const OLD = 'a3000000-0000-4000-8000-000000000003';
const ORGANISATIONS = [
  { xeroTenantId: HOMES, name: 'Example Home Services', status: 'CONNECTED' },
  { xeroTenantId: PEST, name: 'Example Pest Co', status: 'CONNECTED' },
  { xeroTenantId: OLD, name: 'Old Books LLC', status: 'REMOVED' },
];
/** What the office billed in the past six months. */
const BILLED = [
  { name: 'Filter Change', unitPriceCents: 3999, _count: { _all: 40 } },
  { name: 'Pest Control', unitPriceCents: 2500, _count: { _all: 30 } },
  { name: 'Gate Repair', unitPriceCents: 12000, _count: { _all: 2 } },
];

function database() {
  const db = {
    // Which companies' books are read from Xero (2026-11-12): none here.
    xeroSettings: { findMany: jest.fn().mockResolvedValue([]) },
    invoiceSettings: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoiceProduct: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    // What a finished visit bills (2026-11-12): none kept yet.
    invoiceBillingRule: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn().mockResolvedValue({}),
    },
    invoice: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'invoice-1' }),
    },
    invoiceLine: { groupBy: jest.fn().mockResolvedValue(BILLED) },
    xeroOrganisation: {
      findMany: jest.fn(async (args?: { where?: { xeroTenantId?: { in: string[] } } }) =>
        ORGANISATIONS.filter((row) => !args?.where?.xeroTenantId || args.where.xeroTenantId.in.includes(row.xeroTenantId)),
      ),
    },
    // The files on Jobber's invoices, none yet (phase 7).
    invoiceFile: { count: jest.fn().mockResolvedValue(0), groupBy: jest.fn().mockResolvedValue([]) },
    propertywareBuilding: { findFirst: jest.fn().mockResolvedValue({ id: BUILDING, name: 'Building 12', addressLine1: '100 Example Way', city: 'Sampletown' }) },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([{ highest: '8439' }]),
    // Jobber's invoices given their company again (2026-11-11): rows changed.
    $executeRaw: jest.fn<Promise<number>, [TemplateStringsArray, ...unknown[]]>().mockResolvedValue(3),
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((work: unknown) => (Array.isArray(work) ? Promise.all(work) : (work as (tx: typeof db) => unknown)(db)));
  return db;
}

const nothingSaved = { ...EMPTY_INVOICE_SETTINGS, expectedUpdatedAt: null };

describe('the company on invoices, receipts and emails', () => {
  it("is each detail the office filled in, else the server's", () => {
    expect(brandFrom(null, SERVER_BRAND)).toEqual(SERVER_BRAND);
    expect(brandFrom({ ...EMPTY_INVOICE_SETTINGS, companyName: 'Example Company', email: ' billing@example.com ', phone: '  ' }, SERVER_BRAND)).toEqual({
      name: 'Example Company',
      addressLine1: '1 Server Plaza',
      addressLine2: null,
      phone: '555-0100',
      email: 'billing@example.com',
    });
  });

  it('is read from the settings for each invoice and receipt', async () => {
    const db = database();
    db.invoiceSettings.findUnique.mockResolvedValue(settingsRow({ companyName: 'Example Company' }));
    expect((await officeBrand(db as never, ORG)).name).toBe('Example Company');
    expect(db.invoiceSettings.findUnique.mock.calls[0][0].where).toEqual({ organizationId: ORG });
  });
});

describe('what a new invoice starts with', () => {
  const fallback = { subject: 'For Services Rendered', termsDays: 30, clientMessage: 'Thank you.', contractDisclaimer: 'Due within 30 days.' };

  it('is each setting the office filled in, else the latest invoice it issued', () => {
    expect(defaultsFrom(EMPTY_INVOICE_SETTINGS, fallback)).toEqual(fallback);
    expect(
      defaultsFrom({ ...EMPTY_INVOICE_SETTINGS, defaultSubject: 'Quarterly service', defaultTermsDays: 15, defaultContractDisclaimer: 'Due in 15 days.' }, fallback),
    ).toEqual({ subject: 'Quarterly service', termsDays: 15, clientMessage: 'Thank you.', contractDisclaimer: 'Due in 15 days.' });
  });

  it("carries the latest invoice's contract text when nothing is set, as Jobber puts it on each one", async () => {
    const db = database();
    db.invoice.findFirst.mockResolvedValue({ subject: 'For Services Rendered', clientMessage: null, paymentTermsDays: 99, contractDisclaimer: 'Due within 30 days.' });
    // Terms the console does not offer fall back to Net 30.
    expect(await newInvoiceDefaults(db as never, ORG)).toEqual({
      subject: 'For Services Rendered',
      termsDays: 30,
      clientMessage: null,
      contractDisclaimer: 'Due within 30 days.',
    });
  });

  it("starts a property's draft from the settings", async () => {
    const db = database();
    db.invoiceSettings.findUnique.mockResolvedValue(settingsRow({ defaultSubject: 'Quarterly service', defaultTermsDays: 15, defaultClientMessage: 'Thanks!' }));
    const draft = await new InvoicesService(db as never).draft(office, { propertyId: BUILDING });
    expect(draft).toMatchObject({ subject: 'Quarterly service', paymentTermsDays: 15, clientMessage: 'Thanks!' });
  });

  it('puts the contract text on the invoice it makes', async () => {
    const db = database();
    await insertConsoleInvoice(db as never, office, {
      subject: 'For Services Rendered',
      clientName: '100 Example Way',
      inspectionId: null,
      propertywareBuildingId: BUILDING,
      jobberJobId: null,
      issuedOn: '2026-11-06',
      paymentTermsDays: 30,
      lines: [{ name: 'Gate Repair', description: null, quantity: 1, unitPriceCents: 12000 }],
      clientMessage: null,
      contractDisclaimer: 'Due within 30 days.',
      clientRequestId: 'web-key-0001',
      asDraft: false,
    });
    expect(db.invoice.create.mock.calls[0][0].data).toMatchObject({ contractDisclaimer: 'Due within 30 days.' });
  });
});

describe("a new invoice's prices", () => {
  it("are the office's list alone (2026-11-12): nothing billed in Jobber, and nothing set aside", async () => {
    const db = database();
    db.invoiceProduct.findMany.mockResolvedValue([
      product(),
      product({ id: 'p2', name: 'Pest Control', nameKey: 'pest control', active: false, unitPriceCents: 2600, description: null }),
    ]);
    expect(await officePrices(db as never, ORG)).toEqual([{ name: 'Filter Change', unitPriceCents: 4500, description: 'One filter, any size', xeroTenantId: null }]);
    // Gate Repair was billed, but is not on the list: it prices nothing.
    expect(db.invoiceLine.groupBy).not.toHaveBeenCalled();
  });
});

describe('saving the settings', () => {
  it('makes them the first time, and puts each change on the record', async () => {
    const db = database();
    const service = new InvoiceSettingsService(db as never);
    await service.save(office, { ...nothingSaved, companyName: ' Example Company ', defaultTermsDays: 15 });

    expect(db.invoiceSettings.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: ORG, companyName: 'Example Company', defaultTermsDays: 15, email: null }),
    });
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'INVOICE_SETTINGS_CHANGED',
      actorUserId: office.id,
      metadata: { changes: ['Company name: (blank) → Example Company', 'Payment terms: (blank) → Net 15'] },
    });
  });

  it('changes them only as they were read, so two people cannot both win', async () => {
    const db = database();
    db.invoiceSettings.findUnique.mockResolvedValue(settingsRow({ companyName: 'Example Company' }));
    const service = new InvoiceSettingsService(db as never);

    // Read before somebody else saved.
    await expect(service.save(office, { ...nothingSaved, companyName: 'Other Name' })).rejects.toMatchObject({ code: 'INVOICE_SETTINGS_CHANGED' });
    await expect(
      service.save(office, { ...nothingSaved, companyName: 'Other Name', expectedUpdatedAt: '2026-11-06T14:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'INVOICE_SETTINGS_CHANGED' });

    // Saved in between the read and the write.
    db.invoiceSettings.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.save(office, { ...nothingSaved, companyName: 'Other Name', expectedUpdatedAt: SAVED_AT.toISOString() }),
    ).rejects.toMatchObject({ code: 'INVOICE_SETTINGS_CHANGED' });
    expect(db.invoiceSettings.updateMany.mock.calls[0][0].where).toEqual({ organizationId: ORG, updatedAt: SAVED_AT });
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('writes nothing when nothing changed, and refuses an address that is not one', async () => {
    const db = database();
    const service = new InvoiceSettingsService(db as never);
    await service.save(office, { ...nothingSaved, companyName: '   ' });
    expect(db.invoiceSettings.create).not.toHaveBeenCalled();
    await expect(service.save(office, { ...nothingSaved, email: 'billing@example' })).rejects.toMatchObject({
      code: 'INVOICE_SETTINGS_INVALID',
      message: 'billing@example is not an email address.',
    });
  });

  it('answers with the settings, their fallbacks and what was billed but is not on the list', async () => {
    const db = database();
    db.invoiceProduct.findMany.mockResolvedValue([product()]);
    const view = await new InvoiceSettingsService(db as never).read(office);
    expect(view.updatedAt).toBeNull();
    expect(view.defaults).toMatchObject({ subject: 'For Services Rendered', termsDays: 30 });
    expect(view.products).toEqual([expect.objectContaining({ id: PRODUCT, name: 'Filter Change', unitPriceCents: 4500, active: true })]);
    expect(view.billed.map((price) => price.name)).toEqual(['Pest Control', 'Gate Repair']);
  });

  it('offers nothing Jobber billed once the console makes the invoices (2026-11-12): the list is the office’s own', async () => {
    const db = database();
    db.invoiceSettings.findUnique.mockImplementation(async ({ select }: { select?: Record<string, unknown> }) =>
      select && 'invoicingTakenOverAt' in select ? { invoicingTakenOverAt: new Date('2026-11-12T15:00:00.000Z') } : null,
    );
    const view = await new InvoiceSettingsService(db as never).read(office);
    expect(view.billed).toEqual([]);
    expect(db.invoiceLine.groupBy).not.toHaveBeenCalled();
    // And says so (2026-11-13): the page asks no payment terms and keeps no files from Jobber.
    expect(view.madeInConsole).toBe(true);
    expect((await new InvoiceSettingsService(database() as never).read(office)).madeInConsole).toBe(false);
  });
});

describe('the products and services list', () => {
  it('adds them, each name once whatever its case, on the record', async () => {
    const db = database();
    const service = new InvoiceSettingsService(db as never);
    await service.addProducts(office, { products: [{ name: ' Pest Control ', unitPriceCents: 2500 }, { name: 'Gate Repair', description: 'Hinges', unitPriceCents: 12000 }] });
    expect(db.invoiceProduct.createMany).toHaveBeenCalledWith({
      data: [
        { organizationId: ORG, name: 'Pest Control', nameKey: 'pest control', description: null, unitPriceCents: 2500 },
        { organizationId: ORG, name: 'Gate Repair', nameKey: 'gate repair', description: 'Hinges', unitPriceCents: 12000 },
      ],
    });
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'INVOICE_PRODUCTS_ADDED',
      metadata: { products: ['Pest Control: $25.00', 'Gate Repair: $120.00'] },
    });

    await expect(
      service.addProducts(office, { products: [{ name: 'Filter', unitPriceCents: 1 }, { name: 'FILTER', unitPriceCents: 2 }] }),
    ).rejects.toMatchObject({ message: 'A product is listed twice.' });
  });

  it('says when a name is already on it, or set aside, and adds nothing', async () => {
    const db = database();
    const service = new InvoiceSettingsService(db as never);
    db.invoiceProduct.findMany.mockResolvedValue([{ name: 'Filter Change', nameKey: 'filter change', active: false }]);
    await expect(service.addProducts(office, { products: [{ name: 'filter change', unitPriceCents: 4000 }] })).rejects.toMatchObject({
      code: 'INVOICE_PRODUCT_EXISTS',
      message: 'Filter Change is on the list, set aside. Offer it again instead.',
    });
    expect(db.invoiceProduct.createMany).not.toHaveBeenCalled();
  });

  it('changes one as it was read, and sets one aside rather than deleting it', async () => {
    const db = database();
    const service = new InvoiceSettingsService(db as never);
    db.invoiceProduct.findFirst.mockResolvedValue(product());

    await service.changeProduct(office, PRODUCT, { unitPriceCents: 4999, active: false, expectedUpdatedAt: SAVED_AT.toISOString() });
    expect(db.invoiceProduct.updateMany).toHaveBeenCalledWith({
      where: { id: PRODUCT, organizationId: ORG, updatedAt: SAVED_AT },
      data: { name: 'Filter Change', nameKey: 'filter change', description: 'One filter, any size', unitPriceCents: 4999, active: false, xeroTenantId: null },
    });
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'INVOICE_PRODUCT_CHANGED',
      entityId: PRODUCT,
      metadata: { changes: ['Price: $45.00 → $49.99', 'Set aside'] },
    });

    await expect(service.changeProduct(office, PRODUCT, { unitPriceCents: 1, expectedUpdatedAt: '2026-11-05T00:00:00.000Z' })).rejects.toMatchObject({
      code: 'INVOICE_SETTINGS_CHANGED',
    });
    db.invoiceProduct.findFirst.mockResolvedValue(null);
    await expect(service.changeProduct(office, PRODUCT, { unitPriceCents: 1, expectedUpdatedAt: SAVED_AT.toISOString() })).rejects.toMatchObject({
      code: 'INVOICE_PRODUCT_NOT_FOUND',
    });
  });

  it('keeps its Xero choices through a new name, and clears them on a move to another company (2026-11-13)', async () => {
    const chosen = { xeroTenantId: HOMES, xeroAccountId: 'a-410', xeroItemCode: 'FILTER', xeroTrackingGroup: 'Air Filter Income' };
    const db = database();
    const service = new InvoiceSettingsService(db as never);
    db.invoiceProduct.findFirst.mockResolvedValue(product(chosen));

    // Renamed: they go with it -- nothing of them is written.
    await service.changeProduct(office, PRODUCT, { name: 'Air Filter', expectedUpdatedAt: SAVED_AT.toISOString() });
    expect(db.invoiceProduct.updateMany.mock.calls[0]![0].data).toEqual(expect.objectContaining({ name: 'Air Filter', nameKey: 'air filter' }));
    expect(db.invoiceProduct.updateMany.mock.calls[0]![0].data).not.toHaveProperty('xeroAccountId');

    // Moved to another company's books: they are that company's to choose, and the record says so.
    db.auditLog.create.mockClear();
    await service.changeProduct(office, PRODUCT, { xeroTenantId: PEST, expectedUpdatedAt: SAVED_AT.toISOString() });
    expect(db.invoiceProduct.updateMany.mock.calls[1]![0].data).toMatchObject({ xeroTenantId: PEST, xeroAccountId: null, xeroItemCode: null, xeroTrackingGroup: null });
    expect(db.auditLog.create.mock.calls[0][0].data.metadata.changes).toContain('Its account, item and tracking in Xero: cleared, to be chosen for its new company');
  });

  it('sends one to one of the office’s Xero organisations -- connected ones only -- on the record', async () => {
    const db = database();
    const service = new InvoiceSettingsService(db as never);
    db.invoiceProduct.findFirst.mockResolvedValue(product());

    await service.changeProduct(office, PRODUCT, { xeroTenantId: PEST, expectedUpdatedAt: SAVED_AT.toISOString() });
    expect(db.invoiceProduct.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ xeroTenantId: PEST }) }));
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({ metadata: { changes: ['Xero organisation: none → Example Pest Co'] } });
    // Jobber's invoices that bill it go to its company now (2026-11-11): one statement, the office's only, none in Xero already.
    const regroup = db.$executeRaw.mock.calls.map(([strings]) => strings.join('?')).find((text) => text.includes('UPDATE "Invoice"'))!;
    expect(regroup).toContain(`i."origin" = 'JOBBER'`);
    expect(regroup).toContain('i."organizationId" = ?::uuid');
    expect(regroup).toContain('s."xeroInvoiceId" IS NOT NULL');

    // One no longer connected is not offered, and one that is not the office's is not either.
    for (const tenantId of [OLD, 'b9000000-0000-4000-8000-000000000009'])
      await expect(service.changeProduct(office, PRODUCT, { xeroTenantId: tenantId, expectedUpdatedAt: SAVED_AT.toISOString() })).rejects.toMatchObject({
        code: 'INVOICE_PRODUCT_INVALID',
        message: 'That Xero organisation is not connected. Choose one that is.',
      });

    // Back to none.
    db.invoiceProduct.findFirst.mockResolvedValue(product({ xeroTenantId: PEST }));
    db.auditLog.create.mockClear();
    await service.changeProduct(office, PRODUCT, { xeroTenantId: null, expectedUpdatedAt: SAVED_AT.toISOString() });
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({ metadata: { changes: ['Xero organisation: Example Pest Co → none'] } });
  });

  it('leaves Jobber’s invoices with the companies they had once the console makes the invoices (2026-11-12)', async () => {
    const db = database();
    db.invoiceSettings.findUnique.mockImplementation(async ({ select }: { select?: Record<string, unknown> }) =>
      select && 'invoicingTakenOverAt' in select ? { invoicingTakenOverAt: new Date('2026-11-12T15:00:00.000Z') } : null,
    );
    db.invoiceProduct.findFirst.mockResolvedValue(product());
    await new InvoiceSettingsService(db as never).changeProduct(office, PRODUCT, { xeroTenantId: PEST, expectedUpdatedAt: SAVED_AT.toISOString() });
    expect(db.invoiceProduct.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ xeroTenantId: PEST }) }));
    expect(db.$executeRaw.mock.calls.some(([strings]) => strings.join('?').includes('UPDATE "Invoice"'))).toBe(false);
  });

  it('keeps a product with an organisation since disconnected, and names it', async () => {
    const db = database();
    db.invoiceProduct.findFirst.mockResolvedValue(product({ xeroTenantId: OLD }));
    // A price change leaves the organisation as it was: no check on it.
    await new InvoiceSettingsService(db as never).changeProduct(office, PRODUCT, { unitPriceCents: 5000, expectedUpdatedAt: SAVED_AT.toISOString() });
    expect(db.invoiceProduct.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ xeroTenantId: OLD }) }));
    // Nor are Jobber's invoices given their company again: a price says nothing of whose books they go to.
    expect(db.$executeRaw.mock.calls.some(([strings]) => strings.join('?').includes('UPDATE "Invoice"'))).toBe(false);
  });

  it('offers the office’s organisations, connected first, with each product’s choice', async () => {
    const db = database();
    db.invoiceProduct.findMany.mockResolvedValue([product({ xeroTenantId: HOMES })]);
    const view = await new InvoiceSettingsService(db as never).read(office);
    expect(view.organisations).toEqual([
      { tenantId: HOMES, name: 'Example Home Services', connected: true },
      { tenantId: PEST, name: 'Example Pest Co', connected: true },
      { tenantId: OLD, name: 'Old Books LLC', connected: false },
    ]);
    expect(view.products[0]!.xeroTenantId).toBe(HOMES);
  });

  it('refuses a rename to a name already on the list', async () => {
    const db = database();
    db.invoiceProduct.findFirst.mockResolvedValue(product());
    db.invoiceProduct.updateMany.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }));
    await expect(
      new InvoiceSettingsService(db as never).changeProduct(office, PRODUCT, { name: 'Pest Control', expectedUpdatedAt: SAVED_AT.toISOString() }),
    ).rejects.toMatchObject({ code: 'INVOICE_PRODUCT_EXISTS', message: 'Pest Control is already on the list.' });
  });
});

describe('the rules', () => {
  it('are the same on the page and the server', () => {
    expect(invoiceSettingsProblem({ ...EMPTY_INVOICE_SETTINGS, defaultTermsDays: 10 })).toBe('Choose the payment terms from the list.');
    expect(invoiceProductProblem({ name: ' ', unitPriceCents: 100 })).toBe('Give the product or service a name.');
    expect(invoiceProductProblem({ name: 'Gate', unitPriceCents: -1 })).toBe('Give a price of $0.00 or more.');
    expect(invoiceProductProblem({ name: 'Gate', unitPriceCents: 100_000_001 })).toBe('Give a price of $1,000,000.00 or less.');
  });
});

describe('who may change them', () => {
  it('is whoever makes invoices, which an API key never is; whoever reads invoices reads them', () => {
    const permissions = (method: keyof InvoiceSettingsController) =>
      Reflect.getMetadata('permissions', (InvoiceSettingsController.prototype as unknown as Record<string, object>)[method]!);
    expect(permissions('read')).toEqual(['invoices:read']);
    expect(permissions('save')).toEqual(['invoices:read', 'invoices:manage']);
    expect(permissions('addProducts')).toEqual(['invoices:read', 'invoices:manage']);
    expect(permissions('changeProduct')).toEqual(['invoices:read', 'invoices:manage']);
    expect(permissions('addBillingRules')).toEqual(['invoices:read', 'invoices:manage']);
    expect(permissions('removeBillingRule')).toEqual(['invoices:read', 'invoices:manage']);
  });
});

describe('what a finished visit bills (2026-11-12)', () => {
  const HVAC_PRODUCT = product({ id: 'p2', name: 'HVAC Inspection & Filter Change', nameKey: 'hvac inspection & filter change', unitPriceCents: 6450, description: null });
  const PEST_PRODUCT = product({ id: 'p3', name: 'Pest Control', nameKey: 'pest control', unitPriceCents: 3900, description: null, xeroTenantId: PEST });
  /** Six months of invoices, as THMP's read on 2026-11-12: visits invoiced by type, and by type and product. */
  const pastInvoices = (db: ReturnType<typeof database>) =>
    db.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (!sql.includes('"Inspection"')) return [{ highest: '8439' }];
      if (!sql.includes('"InvoiceLine"'))
        return [
          { type: 'OCCUPIED', visits: BigInt(470) },
          { type: 'HVAC', visits: BigInt(179) },
          { type: 'ROOF', visits: BigInt(2) },
        ];
      return [
        { type: 'OCCUPIED', nameKey: 'filter change', visits: BigInt(468) },
        { type: 'HVAC', nameKey: 'hvac inspection & filter change', visits: BigInt(173) },
        { type: 'HVAC', nameKey: 'filter change', visits: BigInt(6) },
        // Two roof visits are no pattern; a move-out inspection is not on the list.
        { type: 'ROOF', nameKey: 'filter change', visits: BigInt(2) },
        { type: 'MOVE_OUT', nameKey: 'move out inspection', visits: BigInt(54) },
      ];
    });

  it('suggests, for each visit type, the product on the list billed on most of its visits in the past six months', async () => {
    const db = database();
    db.invoiceProduct.findMany.mockResolvedValue([product(), HVAC_PRODUCT]);
    pastInvoices(db);
    const view = await new InvoiceSettingsService(db as never).read(office);
    expect(view.suggestedRules).toEqual([
      { inspectionType: 'OCCUPIED', productId: PRODUCT, seen: 468, of: 470 },
      { inspectionType: 'HVAC', productId: 'p2', seen: 173, of: 179 },
    ]);
    expect(view.billingRules).toEqual([]);
    // Read in the office's own scope: raw SQL sets it.
    expect(db.$executeRaw.mock.calls[0]).toContain(ORG);
  });

  it("suggests nothing more for a type the office has a rule for, and lists the office's rules", async () => {
    const db = database();
    db.invoiceProduct.findMany.mockResolvedValue([product(), HVAC_PRODUCT]);
    db.invoiceBillingRule.findMany.mockResolvedValue([{ id: 'rule-1', inspectionType: 'OCCUPIED', service: null, productId: 'p2' }]);
    pastInvoices(db);
    const view = await new InvoiceSettingsService(db as never).read(office);
    expect(view.suggestedRules.map((rule) => rule.inspectionType)).toEqual(['HVAC']);
    expect(view.billingRules).toEqual([{ id: 'rule-1', inspectionType: 'OCCUPIED', service: null, productId: 'p2' }]);
  });

  it('keeps the rules confirmed, each once, on the record', async () => {
    const db = database();
    db.invoiceProduct.findMany.mockResolvedValue([product(), PEST_PRODUCT]);
    const service = new InvoiceSettingsService(db as never);
    await service.addBillingRules(office, {
      rules: [
        { inspectionType: 'OCCUPIED', service: null, productId: PRODUCT },
        { inspectionType: null, service: 'pestControl', productId: 'p3' },
        { inspectionType: 'OCCUPIED', service: null, productId: PRODUCT },
      ],
    });
    expect(db.invoiceBillingRule.createMany).toHaveBeenCalledWith({
      data: [
        { organizationId: ORG, inspectionType: 'OCCUPIED', service: null, productId: PRODUCT },
        { organizationId: ORG, inspectionType: null, service: 'pestControl', productId: 'p3' },
      ],
      skipDuplicates: true,
    });
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'INVOICE_BILLING_RULES_ADDED',
      actorUserId: office.id,
      metadata: { rules: ['Occupied inspection visits → Filter Change ($45.00)', 'Visits with pest control done → Pest Control ($39.00)'] },
    });

    // Confirmed again: nothing is added, nothing recorded.
    const again = database();
    again.invoiceProduct.findMany.mockResolvedValue([product()]);
    again.invoiceBillingRule.findMany.mockResolvedValue([{ inspectionType: 'OCCUPIED', service: null, productId: PRODUCT }]);
    await new InvoiceSettingsService(again as never).addBillingRules(office, { rules: [{ inspectionType: 'OCCUPIED', service: null, productId: PRODUCT }] });
    expect(again.invoiceBillingRule.createMany).not.toHaveBeenCalled();
    expect(again.auditLog.create).not.toHaveBeenCalled();
  });

  it('refuses a rule for no visits in particular, for a product set aside, or for one not on its own list', async () => {
    expect(billingRuleProblem({ inspectionType: null, service: null })).toBe('Say which visits it is for: their type, a service done, or both.');
    const db = database();
    const service = new InvoiceSettingsService(db as never);
    await expect(service.addBillingRules(office, { rules: [{ inspectionType: null, service: null, productId: PRODUCT }] })).rejects.toMatchObject({
      code: 'INVOICE_BILLING_RULE_INVALID',
    });
    db.invoiceProduct.findMany.mockResolvedValue([product({ active: false })]);
    await expect(service.addBillingRules(office, { rules: [{ inspectionType: 'OCCUPIED', service: null, productId: PRODUCT }] })).rejects.toMatchObject({
      code: 'INVOICE_BILLING_RULE_INVALID',
      message: 'Filter Change is set aside. Offer it again first.',
    });
    db.invoiceProduct.findMany.mockResolvedValue([]);
    await expect(service.addBillingRules(office, { rules: [{ inspectionType: 'OCCUPIED', service: null, productId: PRODUCT }] })).rejects.toMatchObject({
      code: 'INVOICE_PRODUCT_NOT_FOUND',
    });
    // Looked for in its own office only.
    expect(db.invoiceProduct.findMany.mock.calls.at(-1)![0].where).toEqual({ organizationId: ORG, id: { in: [PRODUCT] } });
    expect(db.invoiceBillingRule.createMany).not.toHaveBeenCalled();
  });

  it('removes a rule of its own office, on the record', async () => {
    const db = database();
    db.invoiceBillingRule.findFirst.mockResolvedValue({ id: 'rule-1', inspectionType: 'HVAC', service: null, product: { name: 'HVAC Inspection & Filter Change' } });
    await new InvoiceSettingsService(db as never).removeBillingRule(office, 'rule-1');
    expect(db.invoiceBillingRule.findFirst.mock.calls[0][0].where).toEqual({ id: 'rule-1', organizationId: ORG });
    expect(db.invoiceBillingRule.delete).toHaveBeenCalledWith({ where: { id: 'rule-1' } });
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'INVOICE_BILLING_RULE_REMOVED',
      metadata: { rule: 'HVAC inspection visits → HVAC Inspection & Filter Change' },
    });

    db.invoiceBillingRule.findFirst.mockResolvedValue(null);
    await expect(new InvoiceSettingsService(db as never).removeBillingRule(office, 'rule-9')).rejects.toMatchObject({ code: 'INVOICE_BILLING_RULE_NOT_FOUND' });
  });

  it('takes every field of a rule through the request check, and nothing else', async () => {
    const errorsFor = (body: unknown) => validate(plainToInstance(AddBillingRulesDto, body), { whitelist: true, forbidNonWhitelisted: true });
    const rule = { inspectionType: 'HVAC', service: 'pestControl', productId: '30000000-0000-4000-8000-000000000001' };
    expect(await errorsFor({ rules: [rule] })).toEqual([]);
    expect(await errorsFor({ rules: [{ ...rule, inspectionType: null, service: null }] })).toEqual([]);
    expect(await errorsFor({ rules: [{ ...rule, inspectionType: 'GARDEN' }] })).not.toEqual([]);
    expect(await errorsFor({ rules: [{ ...rule, service: 'mowing' }] })).not.toEqual([]);
    expect(await errorsFor({ rules: [{ ...rule, productId: 'p1' }] })).not.toEqual([]);
    expect(await errorsFor({ rules: [{ ...rule, price: 100 }] })).not.toEqual([]);
    expect(await errorsFor({ rules: [] })).not.toEqual([]);
  });
});
