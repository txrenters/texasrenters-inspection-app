import { EMPTY_INVOICE_SETTINGS, invoiceProductProblem, invoiceSettingsProblem } from '@texasrenters/shared';
import { Prisma, UserRole } from '@prisma/client';

import { insertConsoleInvoice } from '../src/admin/invoice-insert';
import { InvoiceSettingsController } from '../src/admin/invoice-settings.controller';
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
  updatedAt: SAVED_AT,
  ...over,
});
/** What the office billed in the past six months. */
const BILLED = [
  { name: 'Filter Change', unitPriceCents: 3999, _count: { _all: 40 } },
  { name: 'Pest Control', unitPriceCents: 2500, _count: { _all: 30 } },
  { name: 'Gate Repair', unitPriceCents: 12000, _count: { _all: 2 } },
];

function database() {
  const db = {
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
    invoice: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'invoice-1' }),
    },
    invoiceLine: { groupBy: jest.fn().mockResolvedValue(BILLED) },
    propertywareBuilding: { findFirst: jest.fn().mockResolvedValue({ id: BUILDING, name: 'Building 12', addressLine1: '100 Example Way', city: 'Sampletown' }) },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([{ highest: '8439' }]),
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((work: (tx: typeof db) => unknown) => work(db));
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
  it("are the office's list first, then what it billed for anything not on it, and nothing set aside", async () => {
    const db = database();
    db.invoiceProduct.findMany.mockResolvedValue([
      product(),
      product({ id: 'p2', name: 'Pest Control', nameKey: 'pest control', active: false, unitPriceCents: 2600, description: null }),
    ]);
    expect(await officePrices(db as never, ORG, '2026-11-06')).toEqual([
      { name: 'Filter Change', unitPriceCents: 4500, description: 'One filter, any size' },
      // Pest Control is set aside: offered from neither the list nor billing.
      { name: 'Gate Repair', unitPriceCents: 12000 },
    ]);
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
      data: { name: 'Filter Change', nameKey: 'filter change', description: 'One filter, any size', unitPriceCents: 4999, active: false },
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
  });
});
