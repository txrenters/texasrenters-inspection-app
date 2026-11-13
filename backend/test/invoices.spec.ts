import { MACHINE_FORBIDDEN_PERMISSIONS } from '@texasrenters/shared';
import { Prisma, UserRole } from '@prisma/client';

import { InvoicesController, PaymentsController } from '../src/admin/invoices.controller';
import { InvoicesService, jobberRead, priceList, servicesDone } from '../src/admin/invoices.service';
import type { AuthenticatedUser } from '../src/common/auth';
import { shownInvoices } from '../src/admin/shown-invoices';

/**
 * Invoices and payments in the console (2026-11-05): the console's copy of
 * Jobber's read back, a finished visit's invoice drafted, and the two money
 * writes -- held off until the console sends them to Jobber, and held to the
 * office's rules when on. Addresses, people and ids invented.
 */

const ORG = '20000000-0000-4000-8000-000000000001';
const VISIT = '20000000-0000-4000-8000-000000000010';
const INVOICE = '20000000-0000-4000-8000-000000000020';
const BUILDING = '20000000-0000-4000-8000-000000000030';

const office: AuthenticatedUser = {
  id: '20000000-0000-4000-8000-000000000009',
  authUserId: 'auth-office',
  organizationId: ORG,
  displayName: 'Office Coordinator',
  roles: [UserRole.INSPECTION_SUPERVISOR],
  permissions: ['invoices:read', 'invoices:manage', 'payments:record'],
  mustChangePassword: false,
  principalType: 'USER',
} as AuthenticatedUser;

const PAST = '2020-03-01';
const AHEAD = '2099-03-01';
const date = (day: string) => new Date(`${day}T00:00:00.000Z`);

const building = { id: BUILDING, name: 'Building 12', addressLine1: '100 Example Way', city: 'Sampletown' };

const invoiceRow = (over: Record<string, unknown> = {}) => ({
  id: INVOICE,
  number: '8439',
  subject: 'For Services Rendered',
  status: 'AWAITING_PAYMENT',
  clientName: '100 Example Way',
  inspectionId: VISIT,
  jobNumber: '20625',
  issuedOn: date('2020-02-01'),
  dueOn: date(AHEAD),
  totalCents: 3999,
  balanceCents: 3999,
  jobberWebUrl: 'https://secure.getjobber.com/invoices/1',
  propertywareBuilding: building,
  jobberClientId: 'client-1',
  propertywareBuildingId: BUILDING,
  paymentTermsDays: 30,
  billingAddress: null,
  subtotalCents: 3999,
  taxCents: 0,
  clientMessage: null,
  createdAt: new Date('2020-02-01T15:00:00.000Z'),
  updatedAt: new Date('2020-02-02T15:00:00.000Z'),
  lines: [
    {
      name: 'Filter Change',
      description: null,
      quantity: 1,
      unitPriceCents: 3999,
      totalCents: 3999,
      taxable: null,
      serviceOn: null,
      productName: null,
      category: null,
    },
  ],
  payments: [],
  contractDisclaimer: null,
  billingName: null,
  propertyAddress: null,
  billingSameAsProperty: null,
  clientEmails: [],
  clientPhones: [],
  paidOn: null,
  viewedAt: null,
  salespersonName: null,
  jobTitle: null,
  discountCents: 0,
  discountRate: null,
  discountKind: null,
  depositCents: 0,
  tipsCents: 0,
  taxRateName: null,
  taxRatePercent: null,
  taxInclusive: null,
  customFields: null,
  notes: [],
  files: [],
  deliveries: [],
  ...over,
});

const finishedVisit = (over: Record<string, unknown> = {}) => ({
  id: VISIT,
  inspectionType: 'OCCUPIED',
  scheduledAt: date('2020-02-01'),
  status: 'COMPLETED',
  jobberJobId: 'job-1',
  assignments: [],
  servicesReport: {
    services: { filterChange: { done: true, reason: null, reschedule: false }, pestControl: { done: false, reason: 'Dog', reschedule: true } },
    filtersInstalled: ['20x25x1'],
    notes: null,
  },
  propertywareBuilding: building,
  ...over,
});

function database() {
  const db = {
    // Which companies' books are read from Xero (2026-11-12): none here.
    xeroSettings: { findMany: jest.fn().mockResolvedValue([]) },
    invoice: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: {}, _max: { syncedAt: null } }),
      create: jest.fn().mockResolvedValue({ id: INVOICE }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    invoiceLine: { groupBy: jest.fn().mockResolvedValue([]) },
    // No invoice settings saved, and no price list: the fallbacks (2026-11-06, phase 6).
    invoiceSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    invoiceProduct: { findMany: jest.fn().mockResolvedValue([]) },
    // No rules yet (2026-11-12): a visit's draft has no lines.
    invoiceBillingRule: { findMany: jest.fn().mockResolvedValue([]) },
    // No Xero organisation: every invoice belongs to no company (2026-11-10).
    xeroOrganisation: { findMany: jest.fn().mockResolvedValue([]) },
    invoicePayment: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: { amountCents: null } }),
      create: jest.fn().mockResolvedValue({ id: 'payment-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    inspection: { findFirst: jest.fn().mockResolvedValue(finishedVisit()) },
    jobberConnection: { findUnique: jest.fn().mockResolvedValue(null) },
    auditLog: { create: jest.fn() },
    // The number lock, then the highest number the office has: #8439.
    $queryRaw: jest.fn().mockResolvedValue([{ highest: '8439' }]),
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((work: (tx: typeof db) => unknown) => work(db));
  return db;
}

const serviceOver = (db: ReturnType<typeof database>) => new InvoicesService(db as never);

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

describe('the invoice list', () => {
  it("counts Jobber's Overview and the Status pill from what is stored, past due by the due day", async () => {
    const db = database();
    db.invoice.findMany.mockResolvedValue([invoiceRow({ dueOn: date(PAST) }), invoiceRow({ id: 'other', dueOn: date(AHEAD) })]);
    db.invoice.count.mockResolvedValue(2);
    db.invoice.groupBy.mockResolvedValue([
      { status: 'AWAITING_PAYMENT', _count: { _all: 5 }, _sum: { totalCents: 20000, balanceCents: 15000 } },
      { status: 'DRAFT', _count: { _all: 2 }, _sum: { totalCents: 7998, balanceCents: 7998 } },
      { status: 'PAID', _count: { _all: 40 }, _sum: { totalCents: 160000, balanceCents: 0 } },
    ]);
    db.invoice.aggregate
      .mockResolvedValueOnce({ _count: { _all: 3 }, _sum: { balanceCents: 9000 } }) // past due
      .mockResolvedValueOnce({ _count: { _all: 4 }, _sum: { totalCents: 15996 } }) // issued, last 30
      .mockResolvedValueOnce({ _count: { _all: 6 }, _sum: { totalCents: 23994 } }) // the 30 before
      .mockResolvedValueOnce({ _max: { syncedAt: new Date('2026-11-05T12:00:00.000Z') } });

    const list = await serviceOver(db).list(office, {});

    expect(list.items.map((item) => item.status)).toEqual(['PAST_DUE', 'AWAITING_PAYMENT']);
    expect(list.overview).toEqual({
      pastDue: { count: 3, amountCents: 9000 },
      notYetDue: { count: 2, amountCents: 6000 },
      draft: { count: 2, amountCents: 7998 },
    });
    expect(list.issued.last30).toEqual({ count: 4, amountCents: 15996 });
    expect(list.filterCounts).toMatchObject({ all: 47, awaiting_payment: 5, past_due: 3, not_yet_due: 2, draft: 2, paid: 40, voided: 0 });
    expect(list.syncedAt).toBe('2026-11-05T12:00:00.000Z');
    expect(list.items[0]).toMatchObject({ property: { id: BUILDING, address: '100 Example Way', city: 'Sampletown' } });
  });

  it("keeps the office's own organization, and filters past due by a due day already gone", async () => {
    const db = database();

    await serviceOver(db).list(office, { filter: 'past_due', search: '#8439', propertyId: BUILDING, page: 3, pageSize: 10 });

    const query = db.invoice.findMany.mock.calls[0][0];
    const [scope, filter, search] = query.where.AND;
    // A company's books as Xero has them once read, Jobber's copies until then (2026-11-12).
    expect(scope).toEqual({ organizationId: ORG, ...shownInvoices([]), propertywareBuildingId: BUILDING });
    expect(filter).toMatchObject({ status: 'AWAITING_PAYMENT', dueOn: { lt: expect.any(Date) } });
    // "#8439" finds number 8439: the # is how the office writes it.
    expect(search.OR).toContainEqual({ number: { startsWith: '8439' } });
    expect(query).toMatchObject({ skip: 20, take: 10 });
  });

  it('shows a read company’s invoices as Xero has them, linked into its books there (2026-11-12)', async () => {
    const HOMES = 'b1000000-0000-4000-8000-000000000001';
    const db = database();
    db.xeroSettings.findMany.mockResolvedValue([{ xeroTenantId: HOMES, booksLastRunAt: new Date('2026-11-12T22:05:00.000Z') }]);
    db.xeroOrganisation.findMany.mockResolvedValue([{ xeroTenantId: HOMES, name: 'Example Home Services', status: 'CONNECTED', organisation: { shortCode: '!abc12' } }]);
    db.invoice.findMany.mockResolvedValue([invoiceRow({ origin: 'XERO', xeroTenantId: HOMES, xeroInvoiceId: 'x-1', xeroStatus: 'DRAFT', jobberWebUrl: null })]);

    const list = await serviceOver(db).list(office, {});

    expect(list.xeroBooks).toEqual([{ tenantId: HOMES, name: 'Example Home Services', readAt: '2026-11-12T22:05:00.000Z' }]);
    expect(list.items[0]!.xero).toEqual({ status: 'DRAFT', url: expect.stringContaining('shortcode=!abc12'), kept: true });
    expect(db.invoice.findMany.mock.calls[0][0].where.AND[0]).toEqual({ organizationId: ORG, ...shownInvoices([HOMES]) });
  });

  it('never pages more than a hundred at once', async () => {
    const db = database();
    await serviceOver(db).list(office, { pageSize: 5000 });
    expect(db.invoice.findMany.mock.calls[0][0].take).toBe(100);
  });

  it("says where reading Jobber's invoices stands, for an empty list to explain itself", async () => {
    const db = database();
    db.jobberConnection.findUnique.mockResolvedValue({
      status: 'CONNECTED',
      invoiceReadProblem: 'NOT_PERMITTED',
      invoiceReadCheckedAt: new Date('2026-11-05T12:00:00.000Z'),
      invoiceReadCompletedAt: null,
    });

    const list = await serviceOver(db).list(office, {});

    expect(db.jobberConnection.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: ORG } }));
    expect(list.jobberRead).toEqual({ problem: 'NOT_PERMITTED', checkedAt: '2026-11-05T12:00:00.000Z', firstReadDone: false });
  });
});

describe("where reading Jobber's invoices stands", () => {
  const connected = { status: 'CONNECTED' as const, invoiceReadProblem: null, invoiceReadCheckedAt: null, invoiceReadCompletedAt: null };

  it('is "not connected" without a live connection, whatever was read before', () => {
    expect(jobberRead(null)).toEqual({ problem: 'NOT_CONNECTED', checkedAt: null, firstReadDone: false });
    expect(jobberRead({ ...connected, status: 'DISCONNECTED', invoiceReadCompletedAt: new Date() })).toMatchObject({
      problem: 'NOT_CONNECTED',
      firstReadDone: true,
    });
  });

  it('passes on only the problems the page can explain', () => {
    expect(jobberRead({ ...connected, invoiceReadProblem: 'FAILED' }).problem).toBe('FAILED');
    expect(jobberRead({ ...connected, invoiceReadProblem: 'SOMETHING_ELSE' }).problem).toBeNull();
    expect(jobberRead({ ...connected, invoiceReadCompletedAt: new Date() })).toMatchObject({ problem: null, firstReadDone: true });
  });
});

describe('an invoice', () => {
  it("shows its terms, lines, payments and what the client owes on every invoice", async () => {
    const db = database();
    db.invoice.findFirst.mockResolvedValue(
      invoiceRow({
        payments: [
          {
            id: 'payment-1',
            paidOn: date('2020-02-20'),
            amountCents: 1000,
            method: 'PROPERTYWARE_LEDGER',
            reference: 'Receipt 77',
            note: null,
            createdAt: new Date('2020-02-20T16:00:00.000Z'),
            recordedBy: { id: office.id, displayName: 'Office Coordinator' },
          },
        ],
      }),
    );
    db.invoice.aggregate.mockResolvedValue({ _sum: { balanceCents: 12000 } });

    const invoice = await serviceOver(db).one(office, INVOICE);

    expect(invoice).toMatchObject({
      paymentTerms: 'Net 30',
      lineItems: [{ name: 'Filter Change', totalCents: 3999 }],
      payments: [{ paidOn: '2020-02-20', amountCents: 1000, reference: 'Receipt 77', recordedAt: '2020-02-20T16:00:00.000Z' }],
      accountBalanceCents: 12000,
    });
    expect(db.invoice.findFirst.mock.calls[0][0].where).toEqual({ id: INVOICE, organizationId: ORG, ...shownInvoices([]) });
    expect(db.invoice.aggregate.mock.calls[0][0].where).toEqual({
      organizationId: ORG,
      ...shownInvoices([]),
      status: 'AWAITING_PAYMENT',
      jobberClientId: 'client-1',
    });
  });

  it("shows every other detail Jobber keeps: contacts, discount, tax, custom fields, notes and files", async () => {
    const db = database();
    db.invoice.findFirst.mockResolvedValue(
      invoiceRow({
        contractDisclaimer: 'Thank you for your business.',
        clientEmails: ['owner@example.com'],
        paidOn: date('2020-02-20'),
        viewedAt: new Date('2020-02-02T15:30:00.000Z'),
        discountCents: 400,
        discountRate: 10,
        discountKind: 'PERCENT',
        taxRateName: 'Texas',
        taxRatePercent: 8.25,
        // Anything in the column that is not a label and a value is not shown.
        customFields: [{ label: 'Gate code', value: '1234' }, { label: 7 }, 'junk'],
        lines: [
          { ...invoiceRow().lines[0], taxable: true, serviceOn: date('2020-02-01'), productName: 'Filter Change', category: 'SERVICE' },
        ],
        notes: [{ id: 'note-1', kind: 'JOB', message: 'Gate sticks', pinned: true, writtenAt: new Date('2020-02-01T12:00:00.000Z') }],
        files: [
          {
            id: 'file-1',
            fileName: 'receipt.pdf',
            contentType: 'application/pdf',
            sizeBytes: 2048,
            jobberUrl: 'https://files.example.com/receipt.pdf',
            uploadedAt: new Date('2020-02-01T12:00:00.000Z'),
          },
        ],
      }),
    );
    db.invoice.aggregate.mockResolvedValue({ _sum: { balanceCents: 0 } });

    const invoice = await serviceOver(db).one(office, INVOICE);

    expect(invoice.lineItems[0]).toMatchObject({ taxable: true, serviceOn: '2020-02-01', category: 'SERVICE' });
    expect(invoice.details).toMatchObject({
      contractDisclaimer: 'Thank you for your business.',
      clientEmails: ['owner@example.com'],
      paidOn: '2020-02-20',
      viewedAt: '2020-02-02T15:30:00.000Z',
      discountCents: 400,
      discountPercent: 10,
      taxRatePercent: 8.25,
      customFields: [{ label: 'Gate code', value: '1234' }],
      notes: [{ id: 'note-1', kind: 'JOB', message: 'Gate sticks', pinned: true, writtenAt: '2020-02-01T12:00:00.000Z' }],
      files: [{ id: 'file-1', fileName: 'receipt.pdf', sizeBytes: 2048, url: 'https://files.example.com/receipt.pdf' }],
    });
    // An amount off is no percent.
    db.invoice.findFirst.mockResolvedValue(invoiceRow({ discountCents: 500, discountRate: 5, discountKind: 'AMOUNT' }));
    expect((await serviceOver(db).one(office, INVOICE)).details).toMatchObject({ discountCents: 500, discountPercent: null, customFields: [] });
  });

  it('says an invoice made here is on its way to its company’s Xero, or why Xero refused it (2026-11-13)', async () => {
    const HOMES = 'b1000000-0000-4000-8000-000000000001';
    const db = database();
    const sync = { findUnique: jest.fn().mockResolvedValue({ status: 'PENDING', problem: null }) };
    const settings = { findUnique: jest.fn().mockResolvedValue({ sendingEnabled: true, sendFrom: date('2026-11-12') }) };
    Object.assign(db, { xeroInvoiceSync: sync, xeroSettings: { ...db.xeroSettings, ...settings } });
    db.invoice.aggregate.mockResolvedValue({ _sum: { balanceCents: 0 } });
    const made = { origin: 'CONSOLE', status: 'DRAFT', number: null, xeroTenantId: HOMES, xeroInvoiceId: null, createdAt: new Date('2026-11-13T20:26:13.000Z') };
    const toXero = async (over: Record<string, unknown> = {}) => {
      db.invoice.findFirst.mockResolvedValue(invoiceRow({ ...made, ...over }));
      return (await serviceOver(db).one(office, INVOICE)).toXero;
    };

    expect(await toXero()).toEqual({ problem: null });
    sync.findUnique.mockResolvedValue({ status: 'FAILED', problem: 'Xero has invoice 8733 for another client: renumber one of them.' });
    expect(await toXero()).toEqual({ problem: 'Xero has invoice 8733 for another client: renumber one of them.' });

    // In Xero already, Jobber's, voided, or made before the company's start date: nothing on its way.
    expect(await toXero({ xeroInvoiceId: 'xero-invoice-1', xeroStatus: 'DRAFT' })).toBeNull();
    expect(await toXero({ origin: 'JOBBER' })).toBeNull();
    expect(await toXero({ status: 'VOIDED' })).toBeNull();
    expect(await toXero({ createdAt: new Date('2026-11-11T20:00:00.000Z') })).toBeNull();
    // A company that does not send.
    settings.findUnique.mockResolvedValue({ sendingEnabled: false, sendFrom: date('2026-11-12') });
    expect(await toXero()).toBeNull();
  });

  it("is not found in another office's organization", async () => {
    await expect(serviceOver(database()).one(office, INVOICE)).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
  });
});

describe("a finished visit's draft", () => {
  it("has a line for each product the office's rules bill, at the list's price, in its own wording and terms (2026-11-12)", async () => {
    const db = database();
    const listed = (id: string, name: string, unitPriceCents: number) => ({
      id,
      name,
      nameKey: name.toLowerCase(),
      description: null,
      unitPriceCents,
      active: true,
      xeroTenantId: null,
      updatedAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    db.invoiceProduct.findMany.mockResolvedValue([listed('product-filter', 'Filter Change', 3999), listed('product-pest', 'Pest Control', 2500)]);
    db.invoiceBillingRule.findMany.mockResolvedValue([
      { id: 'rule-1', inspectionType: 'OCCUPIED', service: null, productId: 'product-filter' },
      { id: 'rule-2', inspectionType: null, service: 'pestControl', productId: 'product-pest' },
    ]);
    // What Jobber billed prices nothing.
    db.invoiceLine.groupBy.mockResolvedValue([{ name: 'Filter Change', unitPriceCents: 2999, _count: { _all: 900 } }]);
    db.invoice.findFirst
      .mockResolvedValueOnce({ subject: 'For Services Rendered', clientMessage: 'Thank you.', paymentTermsDays: 15 })
      .mockResolvedValueOnce(null);

    const draft = await serviceOver(db).draft(office, { inspectionId: VISIT });

    // Pest control was not done, so its rule bills nothing.
    // No company's books yet: one invoice, for none.
    expect(draft.invoices).toEqual([
      { xeroTenantId: null, lineItems: [{ name: 'Filter Change', description: null, quantity: 1, unitPriceCents: 3999 }] },
    ]);
    expect(draft).toMatchObject({
      clientName: '100 Example Way',
      subject: 'For Services Rendered',
      clientMessage: 'Thank you.',
      paymentTermsDays: 15,
      existing: [],
      property: { id: BUILDING },
      organisations: [],
    });
    expect(draft.products.map((product) => product.name)).toEqual(['Filter Change', 'Pest Control']);
  });

  it('has no lines when no rule covers the visit, for the office to add them (2026-11-12)', async () => {
    const db = database();
    db.invoiceLine.groupBy.mockResolvedValue([{ name: 'Filter Change', unitPriceCents: 3999, _count: { _all: 900 } }]);
    const draft = await serviceOver(db).draft(office, { inspectionId: VISIT });
    expect(draft.invoices).toEqual([{ xeroTenantId: null, lineItems: [] }]);
    // Nothing on the list: nothing billed in Jobber is offered in its place.
    expect(draft.products).toEqual([]);
  });

  it('says when the visit has an invoice already, so a second is not made by mistake', async () => {
    const db = database();
    db.invoice.findMany.mockResolvedValueOnce([{ id: INVOICE, number: '8439', status: 'AWAITING_PAYMENT', dueOn: date(PAST), xeroTenantId: null }]);

    const draft = await serviceOver(db).draft(office, { inspectionId: VISIT });

    expect(draft.existing).toEqual([{ id: INVOICE, number: '8439', status: 'PAST_DUE', xeroTenantId: null }]);
    expect(db.invoice.findMany.mock.calls[0][0].where).toEqual({ organizationId: ORG, ...shownInvoices([]), inspectionId: VISIT, status: { not: 'VOIDED' } });
    // No invoice yet in the copy: Jobber's own defaults.
    expect(draft).toMatchObject({ subject: 'For Services Rendered', paymentTermsDays: 30, clientMessage: '' });
  });

  it('is refused for a visit not finished, and for one with no property', async () => {
    const db = database();
    db.inspection.findFirst.mockResolvedValueOnce(finishedVisit({ status: 'SCHEDULED' }));
    await expect(serviceOver(db).draft(office, { inspectionId: VISIT })).rejects.toMatchObject({ code: 'INVOICE_VISIT_NOT_FINISHED' });

    db.inspection.findFirst.mockResolvedValueOnce(finishedVisit({ propertywareBuilding: null }));
    await expect(serviceOver(db).draft(office, { inspectionId: VISIT })).rejects.toMatchObject({ code: 'INVOICE_NO_PROPERTY' });
  });
});

describe("the office's prices", () => {
  it('takes the price billed most often, leaves out free lines, and lists the most billed first', () => {
    expect(
      priceList([
        { name: 'Pest Control', unitPriceCents: 2500, _count: { _all: 10 } },
        { name: 'Filter Change', unitPriceCents: 2999, _count: { _all: 5 } },
        { name: 'filter change', unitPriceCents: 3999, _count: { _all: 30 } },
        { name: 'Courtesy visit', unitPriceCents: 0, _count: { _all: 99 } },
      ]),
    ).toEqual([
      { name: 'Filter Change', unitPriceCents: 3999 },
      { name: 'Pest Control', unitPriceCents: 2500 },
    ]);
  });

  it('bills only the services reported done', () => {
    expect(servicesDone(null)).toEqual([]);
    expect(
      servicesDone({
        services: { fleaTreatment: { done: true, reason: null, reschedule: false }, filterChange: { done: true, reason: null, reschedule: false } },
        filtersInstalled: [],
        notes: null,
      }),
    ).toEqual(['filterChange', 'fleaTreatment']);
  });
});

describe('the payments list', () => {
  it("shows each payment with its invoice, newest first, and what came in over the past 30 days", async () => {
    const db = database();
    db.invoicePayment.findMany.mockResolvedValue([
      {
        id: 'payment-1',
        paidOn: date('2020-02-20'),
        amountCents: 3999,
        method: 'CHECK',
        reference: '1042',
        note: null,
        createdAt: new Date('2020-02-20T16:00:00.000Z'),
        recordedBy: null,
        invoice: { id: INVOICE, number: '8439', subject: 'For Services Rendered', clientName: '100 Example Way', propertywareBuilding: building },
      },
    ]);
    db.invoicePayment.count.mockResolvedValue(1);
    db.invoicePayment.aggregate
      .mockResolvedValueOnce({ _count: { _all: 2 }, _sum: { amountCents: 7998 } })
      .mockResolvedValueOnce({ _count: { _all: 0 }, _sum: { amountCents: null } });

    const list = await serviceOver(db).payments(office, { method: 'CHECK', search: '1042' });

    expect(list.items[0]).toMatchObject({ invoice: { number: '8439' }, property: { address: '100 Example Way' }, recordedBy: null });
    expect(list.received).toEqual({ last30: { count: 2, amountCents: 7998 }, previous30: { count: 0, amountCents: 0 } });
    expect(db.invoicePayment.findMany.mock.calls[0][0].where).toMatchObject({ organizationId: ORG, method: 'CHECK' });
  });
});

describe('a payment on its own page', () => {
  it('shows how it was paid, where it was recorded, and what its invoice still owes', async () => {
    const db = database();
    db.invoicePayment.findFirst.mockResolvedValue({
      id: 'payment-1',
      paidOn: date('2020-02-20'),
      amountCents: 3999,
      method: 'BANK_TRANSFER',
      reference: 'ACH-77',
      note: 'From the owner ledger',
      origin: 'JOBBER',
      createdAt: new Date('2020-02-20T16:00:00.000Z'),
      recordedBy: null,
      jobberPaymentType: 'ACH_BANK_PAYMENT',
      invoice: {
        id: INVOICE,
        number: '8439',
        subject: 'For Services Rendered',
        clientName: '100 Example Way',
        propertywareBuilding: building,
        totalCents: 3999,
        balanceCents: 0,
        status: 'PAID',
        dueOn: date('2020-03-01'),
        clientEmails: ['owner@example.com', 'not an address'],
        deliveries: [],
      },
      updatedAt: new Date('2020-02-20T16:00:00.000Z'),
      receipts: [
        {
          id: 'delivery-1',
          channel: 'EMAIL',
          kind: 'RECEIPT',
          followUpDay: null,
          recipients: ['owner@example.com'],
          status: 'SENT',
          failure: null,
          createdAt: new Date('2020-02-21T16:00:00.000Z'),
          sentAt: new Date('2020-02-21T16:00:01.000Z'),
          sentBy: { id: 'user-1', displayName: 'Ada Lane' },
        },
      ],
    });

    const shown = await serviceOver(db).onePayment(office, 'payment-1');

    expect(shown).toEqual({
      id: 'payment-1',
      paidOn: '2020-02-20',
      amountCents: 3999,
      method: 'BANK_TRANSFER',
      reference: 'ACH-77',
      note: 'From the owner ledger',
      recordedBy: null,
      recordedAt: '2020-02-20T16:00:00.000Z',
      origin: 'JOBBER',
      jobberPaymentType: 'ACH_BANK_PAYMENT',
      invoice: { id: INVOICE, number: '8439', subject: 'For Services Rendered', clientName: '100 Example Way' },
      property: { id: BUILDING, address: '100 Example Way', city: 'Sampletown' },
      invoiceTotalCents: 3999,
      invoiceBalanceCents: 0,
      invoiceStatus: 'PAID',
      updatedAt: '2020-02-20T16:00:00.000Z',
      // Off until the cutover; the receipt names the company as reports do.
      writesEnabled: false,
      brand: expect.objectContaining({ name: expect.any(String) }),
      // Its receipts, and who the next would go to: never sent, so the client's real addresses.
      receipts: [
        {
          id: 'delivery-1',
          channel: 'EMAIL',
          kind: 'RECEIPT',
          followUpDay: null,
          recipients: ['owner@example.com'],
          status: 'SENT',
          failure: null,
          sentBy: { id: 'user-1', displayName: 'Ada Lane' },
          createdAt: '2020-02-21T16:00:00.000Z',
          sentAt: '2020-02-21T16:00:01.000Z',
        },
      ],
      receiptTo: ['owner@example.com'],
      // Recorded in Jobber, on an invoice not kept in Xero (2026-11-12): changed here once the console owns payments.
      keptInXero: false,
    });
    expect(db.invoicePayment.findFirst.mock.calls[0][0].where).toEqual({ id: 'payment-1', organizationId: ORG, invoice: { is: shownInvoices([]) } });
  });

  it("is not found in another office's organization", async () => {
    await expect(serviceOver(database()).onePayment(office, 'payment-1')).rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND' });
  });
});

describe('correcting and removing a payment', () => {
  const READ_AT = '2026-01-10T16:00:00.000Z';
  /** A $40.00 payment on an invoice that still owes $20.00 after it. */
  const stored = (over: Record<string, unknown> = {}) => ({
    invoiceId: INVOICE,
    amountCents: 4000,
    paidOn: date('2026-01-10'),
    method: 'CHECK',
    reference: '1042',
    note: null,
    origin: 'CONSOLE',
    recordedById: office.id,
    updatedAt: new Date(READ_AT),
    invoice: { status: 'AWAITING_PAYMENT', balanceCents: 2000 },
    ...over,
  });
  const change = { amountCents: 5000, paidOn: '2026-01-11', method: 'BANK_TRANSFER' as const, reference: ' ACH-9 ', note: '  ', expectedUpdatedAt: READ_AT };

  /** The first read finds the payment to change; the second is the page answered with. */
  const databaseWith = (row: Record<string, unknown> | null) => {
    const db = database();
    db.invoicePayment.findFirst.mockResolvedValueOnce(row);
    return db;
  };
  const answered = (service: InvoicesService) =>
    jest.spyOn(service, 'onePayment').mockResolvedValue({ id: 'payment-1' } as never);

  it('is refused while Jobber holds the payments, and writes nothing', async () => {
    delete process.env.JOBBER_INVOICE_WRITES_ENABLED;
    const db = databaseWith(stored());

    await expect(serviceOver(db).changePayment(office, 'payment-1', change)).rejects.toMatchObject({ code: 'INVOICE_WRITES_OFF' });
    await expect(serviceOver(db).removePayment(office, 'payment-1', READ_AT)).rejects.toMatchObject({ code: 'INVOICE_WRITES_OFF' });

    expect(db.invoice.updateMany).not.toHaveBeenCalled();
    expect(db.invoicePayment.updateMany).not.toHaveBeenCalled();
    expect(db.invoicePayment.deleteMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  describe('once the console owns payments', () => {
    beforeEach(() => {
      process.env.JOBBER_INVOICE_WRITES_ENABLED = 'true';
    });
    afterEach(() => {
      delete process.env.JOBBER_INVOICE_WRITES_ENABLED;
    });

    it('takes the old amount back and the new one off, only from what was read, and keeps both on the record', async () => {
      const db = databaseWith(stored());
      const service = serviceOver(db);
      answered(service);

      await service.changePayment(office, 'payment-1', change);

      // $20.00 owed + $40.00 taken back - $50.00 = $10.00.
      expect(db.invoice.updateMany).toHaveBeenCalledWith({
        where: { id: INVOICE, organizationId: ORG, status: 'AWAITING_PAYMENT', balanceCents: 2000 },
        data: { balanceCents: 1000, status: 'AWAITING_PAYMENT', paidOn: null },
      });
      expect(db.invoicePayment.updateMany).toHaveBeenCalledWith({
        where: { id: 'payment-1', organizationId: ORG, updatedAt: new Date(READ_AT) },
        data: { amountCents: 5000, paidOn: date('2026-01-11'), method: 'BANK_TRANSFER', reference: 'ACH-9', note: null },
      });
      expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({
        action: 'INVOICE_PAYMENT_CHANGED',
        entityType: 'Invoice',
        entityId: INVOICE,
        actorUserId: office.id,
        metadata: {
          paymentId: 'payment-1',
          before: { amountCents: 4000, paidOn: '2026-01-10', method: 'CHECK', reference: '1042', origin: 'CONSOLE' },
          after: { amountCents: 5000, paidOn: '2026-01-11', method: 'BANK_TRANSFER', reference: 'ACH-9', note: null },
          balanceCents: 1000,
        },
      });
    });

    it('marks the invoice paid, on the day of its latest payment, when the correction pays it all', async () => {
      const db = databaseWith(stored());
      db.invoicePayment.aggregate.mockResolvedValue({ _max: { paidOn: date('2026-01-11') } });
      const service = serviceOver(db);
      answered(service);

      await service.changePayment(office, 'payment-1', { ...change, amountCents: 6000 });

      expect(db.invoice.updateMany.mock.calls[0][0].data).toEqual({ balanceCents: 0, status: 'PAID' });
      expect(db.invoice.update).toHaveBeenCalledWith({ where: { id: INVOICE }, data: { paidOn: date('2026-01-11') } });
    });

    it('owes again on a paid invoice when the correction is for less', async () => {
      const db = databaseWith(stored({ invoice: { status: 'PAID', balanceCents: 0 } }));
      const service = serviceOver(db);
      answered(service);

      await service.changePayment(office, 'payment-1', { ...change, amountCents: 3000 });

      expect(db.invoice.updateMany).toHaveBeenCalledWith({
        where: { id: INVOICE, organizationId: ORG, status: 'PAID', balanceCents: 0 },
        data: { balanceCents: 1000, status: 'AWAITING_PAYMENT', paidOn: null },
      });
    });

    it('refuses more than the invoice owed with this payment taken back, and a day to come', async () => {
      const service = serviceOver(databaseWith(stored()));
      await expect(service.changePayment(office, 'payment-1', { ...change, amountCents: 6001 })).rejects.toMatchObject({
        code: 'PAYMENT_INVALID',
        message: 'That is more than the $60.00 this invoice still owes.',
      });
      const ahead = serviceOver(databaseWith(stored()));
      await expect(ahead.changePayment(office, 'payment-1', { ...change, paidOn: AHEAD })).rejects.toMatchObject({ code: 'PAYMENT_INVALID' });
    });

    it('refuses a payment changed since it was read, rather than overwrite it', async () => {
      const db = databaseWith(stored({ updatedAt: new Date('2026-01-10T16:05:00.000Z') }));
      await expect(serviceOver(db).changePayment(office, 'payment-1', change)).rejects.toMatchObject({ code: 'PAYMENT_CHANGED' });
      expect(db.invoice.updateMany).not.toHaveBeenCalled();

      // And one changed between the read and the write.
      const raced = databaseWith(stored());
      raced.invoicePayment.updateMany.mockResolvedValue({ count: 0 });
      await expect(serviceOver(raced).changePayment(office, 'payment-1', change)).rejects.toMatchObject({ code: 'PAYMENT_CHANGED' });
      expect(raced.auditLog.create).not.toHaveBeenCalled();
    });

    it('refuses when the invoice changed under it, so two people cannot both take money off it', async () => {
      const db = databaseWith(stored());
      db.invoice.updateMany.mockResolvedValue({ count: 0 });
      await expect(serviceOver(db).changePayment(office, 'payment-1', change)).rejects.toMatchObject({ code: 'INVOICE_CHANGED' });
      expect(db.invoicePayment.updateMany).not.toHaveBeenCalled();
    });

    it('leaves refunds and the payments of a closed invoice alone', async () => {
      const refund = serviceOver(databaseWith(stored({ amountCents: -1000 })));
      await expect(refund.changePayment(office, 'payment-1', change)).rejects.toMatchObject({ code: 'PAYMENT_LOCKED' });
      const voided = serviceOver(databaseWith(stored({ invoice: { status: 'VOIDED', balanceCents: 0 } })));
      await expect(voided.removePayment(office, 'payment-1', READ_AT)).rejects.toMatchObject({
        code: 'PAYMENT_LOCKED',
        message: 'The invoice is voided, so its payments are not changed.',
      });
    });

    it('is not found in another office', async () => {
      await expect(serviceOver(databaseWith(null)).changePayment(office, 'payment-1', change)).rejects.toMatchObject({
        code: 'PAYMENT_NOT_FOUND',
      });
    });

    it('removes a payment: the invoice owes it again, and the record keeps what it was', async () => {
      const db = databaseWith(stored({ invoice: { status: 'PAID', balanceCents: 0 } }));

      await expect(serviceOver(db).removePayment(office, 'payment-1', READ_AT)).resolves.toEqual({ invoiceId: INVOICE });

      expect(db.invoice.updateMany).toHaveBeenCalledWith({
        where: { id: INVOICE, organizationId: ORG, status: 'PAID', balanceCents: 0 },
        data: { balanceCents: 4000, status: 'AWAITING_PAYMENT', paidOn: null },
      });
      expect(db.invoicePayment.deleteMany).toHaveBeenCalledWith({
        where: { id: 'payment-1', organizationId: ORG, updatedAt: new Date(READ_AT) },
      });
      expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({
        action: 'INVOICE_PAYMENT_REMOVED',
        entityId: INVOICE,
        metadata: {
          paymentId: 'payment-1',
          removed: { amountCents: 4000, paidOn: '2026-01-10', method: 'CHECK', reference: '1042', recordedById: office.id },
          balanceCents: 4000,
        },
      });
    });

    it('removes nothing when the payment changed since it was read', async () => {
      const db = databaseWith(stored());
      db.invoicePayment.deleteMany.mockResolvedValue({ count: 0 });
      await expect(serviceOver(db).removePayment(office, 'payment-1', READ_AT)).rejects.toMatchObject({ code: 'PAYMENT_CHANGED' });
      expect(db.auditLog.create).not.toHaveBeenCalled();
    });
  });
});

describe('making an invoice and recording a payment', () => {
  const create = {
    inspectionId: VISIT,
    subject: ' For Services Rendered ',
    issuedOn: '2026-01-05',
    paymentTermsDays: 30,
    lineItems: [
      { name: 'Filter Change', quantity: 2, unitPriceCents: 3999 },
      { name: 'Pest Control', description: '  ', quantity: 1, unitPriceCents: 2500 },
    ],
    clientRequestId: 'web-key-0001',
  };
  const pay = { amountCents: 1000, paidOn: '2026-01-10', method: 'PROPERTYWARE_LEDGER' as const, reference: ' R-77 ', clientRequestId: 'web-pay-0001' };

  describe('while the console does not send them to Jobber', () => {
    it('refuses both, and writes nothing', async () => {
      delete process.env.JOBBER_INVOICE_WRITES_ENABLED;
      const db = database();

      await expect(serviceOver(db).create(office, create)).rejects.toMatchObject({ code: 'INVOICE_WRITES_OFF' });
      await expect(serviceOver(db).recordPayment(office, INVOICE, pay)).rejects.toMatchObject({ code: 'INVOICE_WRITES_OFF' });

      expect(db.invoice.create).not.toHaveBeenCalled();
      expect(db.invoicePayment.create).not.toHaveBeenCalled();
      expect(db.auditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('once they are on', () => {
    beforeEach(() => {
      process.env.JOBBER_INVOICE_WRITES_ENABLED = 'true';
    });
    afterEach(() => {
      delete process.env.JOBBER_INVOICE_WRITES_ENABLED;
    });

    it('makes the invoice with totals worked out here, made out to the property, and puts it on the record', async () => {
      const db = database();
      // The visit has no invoice yet; the office's latest invoice, and the one made, read as this one.
      db.invoice.findFirst.mockImplementation(async ({ where }: { where?: { inspectionId?: string } } = {}) => (where?.inspectionId ? null : invoiceRow()));

      await serviceOver(db).create(office, create);

      const { data } = db.invoice.create.mock.calls[0][0];
      expect(data).toMatchObject({
        organizationId: ORG,
        origin: 'CONSOLE',
        subject: 'For Services Rendered',
        status: 'AWAITING_PAYMENT',
        clientName: '100 Example Way',
        inspectionId: VISIT,
        propertywareBuildingId: BUILDING,
        subtotalCents: 10498,
        totalCents: 10498,
        balanceCents: 10498,
        createdById: office.id,
        clientRequestId: 'web-key-0001',
      });
      expect(data.dueOn).toEqual(date('2026-02-04'));
      expect(data.lines.create).toEqual([
        expect.objectContaining({ position: 0, name: 'Filter Change', totalCents: 7998, organizationId: ORG }),
        expect.objectContaining({ position: 1, name: 'Pest Control', description: null, totalCents: 2500 }),
      ]);
      expect(db.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'INVOICE_CREATED',
          actorUserId: office.id,
          entityId: INVOICE,
          metadata: expect.objectContaining({ totalCents: 10498, lineCount: 2 }),
        }),
      });
    });

    it('answers a resend with the invoice already made, and makes no second', async () => {
      const db = database();
      db.invoice.findMany.mockResolvedValueOnce([{ id: INVOICE, inspectionId: VISIT, propertywareBuildingId: BUILDING, clientRequestId: 'web-key-0001' }]);
      db.invoice.findFirst.mockResolvedValue(invoiceRow());

      await expect(serviceOver(db).create(office, create)).resolves.toMatchObject({ id: INVOICE });
      expect(db.invoice.create).not.toHaveBeenCalled();
    });

    it('refuses the same key for another visit', async () => {
      const db = database();
      db.invoice.findMany.mockResolvedValueOnce([{ id: INVOICE, inspectionId: 'another-visit', propertywareBuildingId: BUILDING, clientRequestId: 'web-key-0001' }]);
      await expect(serviceOver(db).create(office, create)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    });

    it('answers with the invoice the other request made when both arrive at once', async () => {
      const db = database();
      db.invoice.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: INVOICE, inspectionId: VISIT, propertywareBuildingId: BUILDING, clientRequestId: 'web-key-0001' }]);
      db.invoice.findFirst.mockResolvedValue(invoiceRow());
      db.invoice.create.mockRejectedValue(uniqueViolation());

      await expect(serviceOver(db).create(office, create)).resolves.toMatchObject({ id: INVOICE });
    });

    it.each([
      ['no lines', { lineItems: [] }, 'Add at least one line.'],
      ['a day to come', { issuedOn: AHEAD }, 'An invoice cannot be issued on a day still to come.'],
      ['terms not on the list', { paymentTermsDays: 12 }, 'Pick the payment terms from the list.'],
      ['nothing to pay', { lineItems: [{ name: 'Filter Change', quantity: 1, unitPriceCents: 0 }] }, 'The invoice comes to nothing.'],
      ['no subject', { subject: '   ' }, 'Give the invoice a subject.'],
    ])('refuses an invoice with %s', async (_, change, message) => {
      const db = database();
      await expect(serviceOver(db).create(office, { ...create, ...change })).rejects.toMatchObject({
        code: 'INVOICE_INVALID',
        message,
      });
      expect(db.invoice.create).not.toHaveBeenCalled();
    });

    it("refuses a visit that is not finished", async () => {
      const db = database();
      db.inspection.findFirst.mockResolvedValue(finishedVisit({ status: 'IN_PROGRESS' }));
      await expect(serviceOver(db).create(office, create)).rejects.toMatchObject({ code: 'INVOICE_VISIT_NOT_FINISHED' });
    });

    it('records nothing against an invoice kept in Xero (2026-11-12): its payments are recorded there', async () => {
      const HOMES = 'b1000000-0000-4000-8000-000000000001';
      const db = database();
      db.xeroSettings.findMany.mockResolvedValue([{ xeroTenantId: HOMES }]);
      db.invoice.findFirst.mockResolvedValueOnce({
        status: 'AWAITING_PAYMENT',
        dueOn: date(PAST),
        balanceCents: 3999,
        origin: 'XERO',
        xeroTenantId: HOMES,
        xeroInvoiceId: 'x-1',
      });

      await expect(serviceOver(db).recordPayment(office, INVOICE, pay)).rejects.toMatchObject({ code: 'INVOICE_KEPT_IN_XERO', status: 409 });
      expect(db.invoicePayment.create).not.toHaveBeenCalled();
      expect(db.invoice.updateMany).not.toHaveBeenCalled();
    });

    it('records a payment, lowers the balance only from what was read, and puts it on the record', async () => {
      const db = database();
      db.invoice.findFirst
        .mockResolvedValueOnce({ status: 'AWAITING_PAYMENT', dueOn: date(PAST), balanceCents: 3999 })
        .mockResolvedValue(invoiceRow({ balanceCents: 2999 }));

      await serviceOver(db).recordPayment(office, INVOICE, pay);

      expect(db.invoice.updateMany).toHaveBeenCalledWith({
        where: { id: INVOICE, organizationId: ORG, status: 'AWAITING_PAYMENT', balanceCents: 3999 },
        data: { balanceCents: 2999 },
      });
      expect(db.invoicePayment.create.mock.calls[0][0].data).toMatchObject({
        organizationId: ORG,
        invoiceId: INVOICE,
        origin: 'CONSOLE',
        amountCents: 1000,
        method: 'PROPERTYWARE_LEDGER',
        reference: 'R-77',
        note: null,
        recordedById: office.id,
      });
      expect(db.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'INVOICE_PAYMENT_RECORDED',
          entityId: INVOICE,
          metadata: expect.objectContaining({ amountCents: 1000, balanceCents: 2999, paymentId: 'payment-1' }),
        }),
      });
    });

    it('marks an invoice paid in full as paid, on the day of the payment that paid it', async () => {
      const db = database();
      db.invoice.findFirst
        .mockResolvedValueOnce({ status: 'AWAITING_PAYMENT', dueOn: date(AHEAD), balanceCents: 1000 })
        .mockResolvedValue(invoiceRow());

      await serviceOver(db).recordPayment(office, INVOICE, pay);

      expect(db.invoice.updateMany.mock.calls[0][0].data).toEqual({ balanceCents: 0, status: 'PAID', paidOn: date('2026-01-10') });
    });

    it('refuses more than is owed, a day to come, and an invoice not waiting for payment', async () => {
      const db = database();
      db.invoice.findFirst.mockResolvedValueOnce({ status: 'AWAITING_PAYMENT', dueOn: null, balanceCents: 500 });
      await expect(serviceOver(db).recordPayment(office, INVOICE, pay)).rejects.toMatchObject({
        code: 'PAYMENT_INVALID',
        message: 'That is more than the $5.00 this invoice still owes.',
      });

      db.invoice.findFirst.mockResolvedValueOnce({ status: 'AWAITING_PAYMENT', dueOn: null, balanceCents: 5000 });
      await expect(serviceOver(db).recordPayment(office, INVOICE, { ...pay, paidOn: AHEAD })).rejects.toMatchObject({
        code: 'PAYMENT_INVALID',
      });

      db.invoice.findFirst.mockResolvedValueOnce({ status: 'PAID', dueOn: null, balanceCents: 0 });
      await expect(serviceOver(db).recordPayment(office, INVOICE, pay)).rejects.toMatchObject({ code: 'INVOICE_NOT_PAYABLE' });

      db.invoice.findFirst.mockResolvedValueOnce({ status: 'DRAFT', dueOn: null, balanceCents: 5000 });
      await expect(serviceOver(db).recordPayment(office, INVOICE, pay)).rejects.toMatchObject({ code: 'INVOICE_NOT_PAYABLE' });

      expect(db.invoicePayment.create).not.toHaveBeenCalled();
    });

    it('refuses when the invoice changed under it, so two people cannot take it below nothing', async () => {
      const db = database();
      db.invoice.findFirst.mockResolvedValueOnce({ status: 'AWAITING_PAYMENT', dueOn: null, balanceCents: 3999 });
      db.invoice.updateMany.mockResolvedValue({ count: 0 });

      await expect(serviceOver(db).recordPayment(office, INVOICE, pay)).rejects.toMatchObject({ code: 'INVOICE_CHANGED' });
      expect(db.invoicePayment.create).not.toHaveBeenCalled();
    });

    it('answers a resend with the invoice, and records no second payment', async () => {
      const db = database();
      db.invoicePayment.findFirst.mockResolvedValue({ invoiceId: INVOICE });
      db.invoice.findFirst.mockResolvedValue(invoiceRow());

      await expect(serviceOver(db).recordPayment(office, INVOICE, pay)).resolves.toMatchObject({ id: INVOICE });
      expect(db.$transaction).not.toHaveBeenCalled();

      await expect(serviceOver(db).recordPayment(office, 'another-invoice', pay)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    });
  });
});

describe('who may do what', () => {
  const permissionsOf = (controller: { prototype: object }, name: string) =>
    Reflect.getMetadata('permissions', (controller.prototype as Record<string, object>)[name]!) as string[];

  it('keeps reading, making an invoice and recording a payment as three grants', () => {
    expect(permissionsOf(InvoicesController, 'list')).toEqual(['invoices:read']);
    expect(permissionsOf(InvoicesController, 'one')).toEqual(['invoices:read']);
    expect(permissionsOf(InvoicesController, 'draft')).toEqual(['invoices:read', 'invoices:manage']);
    expect(permissionsOf(InvoicesController, 'create')).toEqual(['invoices:read', 'invoices:manage']);
    expect(permissionsOf(InvoicesController, 'recordPayment')).toEqual(['invoices:read', 'payments:record']);
    expect(permissionsOf(PaymentsController, 'list')).toEqual(['invoices:read']);
    expect(permissionsOf(PaymentsController, 'one')).toEqual(['invoices:read']);
    // Correcting or removing a payment is recording it again: the same grant.
    expect(permissionsOf(PaymentsController, 'change')).toEqual(['invoices:read', 'payments:record']);
    expect(permissionsOf(PaymentsController, 'remove')).toEqual(['invoices:read', 'payments:record']);
  });

  it('never lets an API key make an invoice or record a payment', () => {
    expect(MACHINE_FORBIDDEN_PERMISSIONS).toEqual(expect.arrayContaining(['invoices:manage', 'payments:record']));
  });
});
