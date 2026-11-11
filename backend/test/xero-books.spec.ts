import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import {
  BOOKS_OVERLAP_MS,
  invoiceFromXero,
  methodFromAccount,
  modifiedSinceHeader,
  nextCursor,
  statusFromXero,
  xeroDay,
  xeroInstant,
  type XeroBooksInvoice,
} from '../src/integrations/xero/xero-books';
import { CALLS_KEPT_FOR_SENDING, MANUAL_BOOKS_CALLS, XeroBooksService } from '../src/integrations/xero/xero-books.service';

/**
 * Each company's books read back from Xero (2026-11-12, PR 2 of the plan to
 * make invoices in the console with Xero as the record): Xero's invoices and
 * payments kept as Xero has them, put on the visit and property they are for,
 * out of sight of the pages, under a share of the day's calls. Everything
 * invented.
 */

const ORG = '90000000-0000-4000-8000-000000000001';
const TENANT = 'b1000000-0000-4000-8000-000000000001';
const OTHER_TENANT = 'b1000000-0000-4000-8000-000000000002';
const VISIT = 'c1000000-0000-4000-8000-000000000001';
const BUILDING = 'd1000000-0000-4000-8000-000000000001';
const BUILDING_2 = 'd1000000-0000-4000-8000-000000000002';
const office: AuthenticatedUser = {
  id: '90000000-0000-4000-8000-000000000030',
  authUserId: 'auth-office',
  organizationId: ORG,
  displayName: 'Ada Lane',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: ['integrations:read', 'integrations:manage'],
  mustChangePassword: false,
  principalType: 'USER',
};

const NOW = new Date('2026-11-20T15:00:00.000Z');
const msDate = (iso: string) => `/Date(${Date.parse(iso)}+0000)/`;

const theirs = (over: Partial<XeroBooksInvoice> = {}): XeroBooksInvoice => ({
  InvoiceID: 'x-1',
  Type: 'ACCREC',
  InvoiceNumber: '8440',
  Reference: 'For Services Rendered',
  Status: 'AUTHORISED',
  LineAmountTypes: 'Exclusive',
  Contact: { ContactID: 'contact-1', Name: '12 Example Lane' },
  Date: msDate('2026-11-02T00:00:00Z'),
  DateString: '2026-11-02T00:00:00',
  DueDateString: '2026-11-30T00:00:00',
  UpdatedDateUTC: msDate('2026-11-19T10:00:00Z'),
  SubTotal: 75,
  TotalTax: 0,
  Total: 75,
  AmountDue: 75,
  AmountPaid: 0,
  AmountCredited: 0,
  LineItems: [{ Description: 'Full walk-through', Quantity: 1, UnitAmount: 75, LineAmount: 75, TaxAmount: 0, ItemCode: 'MOI', Item: { Name: 'Move Out Inspection', Code: 'MOI' } }],
  Payments: [],
  ...over,
});

describe('Xero’s invoices in the console’s terms', () => {
  it('reads Xero’s dates, and its days as the days they are', () => {
    expect(xeroInstant('/Date(1763546400000+0000)/')?.toISOString()).toBe('2025-11-19T10:00:00.000Z');
    expect(xeroInstant('2026-11-19T10:00:00')?.toISOString()).toBe('2026-11-19T10:00:00.000Z');
    expect(xeroInstant('not a date')).toBeNull();
    expect(xeroDay('2026-11-02T00:00:00', null)).toBe('2026-11-02');
    expect(xeroDay(null, msDate('2026-11-02T00:00:00Z'))).toBe('2026-11-02');
    expect(xeroDay(null, null)).toBeNull();
  });

  it('maps every status, and calls one a bad debt only when the console wrote it off', () => {
    expect(statusFromXero('DRAFT', false)).toBe('DRAFT');
    expect(statusFromXero('SUBMITTED', false)).toBe('DRAFT');
    expect(statusFromXero('AUTHORISED', false)).toBe('AWAITING_PAYMENT');
    expect(statusFromXero('PAID', false)).toBe('PAID');
    expect(statusFromXero('PAID', true)).toBe('BAD_DEBT');
    expect(statusFromXero('VOIDED', false)).toBe('VOIDED');
    expect(statusFromXero('DELETED', false)).toBe('VOIDED');
    expect(statusFromXero('SOMETHING_NEW', false)).toBeNull();
  });

  it('keeps what Xero says is paid, credited and owed, with each payment', () => {
    const mapped = invoiceFromXero(
      theirs({
        AmountDue: 25,
        AmountPaid: 40,
        AmountCredited: 10,
        Payments: [{ PaymentID: 'p-1', Date: msDate('2026-11-10T00:00:00Z'), Amount: 40, Reference: 'Check 1042' }],
      }),
      false,
    )!;
    expect(mapped).toMatchObject({
      status: 'AWAITING_PAYMENT',
      totalCents: 7500,
      balanceCents: 2500,
      amountPaidCents: 4000,
      amountCreditedCents: 1000,
      issuedOn: '2026-11-02',
      dueOn: '2026-11-30',
      subject: 'For Services Rendered',
      taxInclusive: false,
    });
    expect(mapped.payments).toEqual([{ xeroPaymentId: 'p-1', paidOn: '2026-11-10', amountCents: 4000, reference: 'Check 1042' }]);
  });

  it('names a line by its item, else its code, else its first line', () => {
    const mapped = invoiceFromXero(
      theirs({
        LineItems: [
          { Description: 'Move Out Inspection', Quantity: 1, UnitAmount: 75, LineAmount: 75, Item: { Name: 'Move Out Inspection' } },
          { Description: 'Filter swapped', Quantity: 2, UnitAmount: 19.995, LineAmount: 39.99, ItemCode: 'FC' },
          { Description: 'Pest control\nInside and out', Quantity: null, UnitAmount: 39, LineAmount: 39, TaxAmount: 2.97 },
        ],
        LineAmountTypes: 'Inclusive',
      }),
      false,
    )!;
    expect(mapped.lines).toEqual([
      { position: 0, name: 'Move Out Inspection', description: null, quantity: 1, unitPriceCents: 7500, totalCents: 7500, productName: 'Move Out Inspection', taxable: null },
      { position: 1, name: 'FC', description: 'Filter swapped', quantity: 2, unitPriceCents: 2000, totalCents: 3999, productName: null, taxable: null },
      { position: 2, name: 'Pest control', description: 'Pest control\nInside and out', quantity: 1, unitPriceCents: 3900, totalCents: 3900, productName: null, taxable: true },
    ]);
    expect(mapped.taxInclusive).toBe(true);
  });

  it('owes nothing once voided or deleted, and says which was deleted', () => {
    expect(invoiceFromXero(theirs({ Status: 'VOIDED', AmountDue: 75 }), false)).toMatchObject({ status: 'VOIDED', balanceCents: 0, deleted: false });
    expect(invoiceFromXero(theirs({ Status: 'DELETED', AmountDue: 75 }), false)).toMatchObject({ status: 'VOIDED', balanceCents: 0, deleted: true });
    expect(invoiceFromXero(theirs({ Status: 'PAID', FullyPaidOnDate: msDate('2026-11-15T00:00:00Z') }), false)).toMatchObject({ paidOn: '2026-11-15' });
  });

  it('says how a payment came in only when one method goes to its account', () => {
    expect(methodFromAccount('a-090', { CHECK: 'a-090', ZELLE: 'a-091' })).toBe('CHECK');
    expect(methodFromAccount('a-090', { CHECK: 'a-090', CASH: 'a-090' })).toBe('OTHER');
    expect(methodFromAccount('a-999', { CHECK: 'a-090' })).toBe('OTHER');
    expect(methodFromAccount(null, { CHECK: 'a-090' })).toBe('OTHER');
  });

  it('carries on after each page, so it can never stand still', () => {
    const newest = new Date('2026-11-19T10:00:00.000Z');
    const moved = new Date(newest.getTime() - BOOKS_OVERLAP_MS);
    // A short page reached the end: next time, what changed since its newest, less the overlap.
    expect(nextCursor({ since: null, page: 1 }, { count: 12, newest })).toEqual({ cursor: { since: moved, page: 1 }, done: true });
    // Nothing changed: where it was.
    expect(nextCursor({ since: moved, page: 1 }, { count: 0, newest: null })).toEqual({ cursor: { since: moved, page: 1 }, done: true });
    // A full page moves on to its newest.
    expect(nextCursor({ since: null, page: 1 }, { count: 1000, newest })).toEqual({ cursor: { since: moved, page: 1 }, done: false });
    // A full page all within the overlap -- an import -- goes on to the next page.
    expect(nextCursor({ since: moved, page: 1 }, { count: 1000, newest })).toEqual({ cursor: { since: moved, page: 2 }, done: false });
    // Xero kept to its own 100 a page: still not the end.
    expect(nextCursor({ since: null, page: 1 }, { count: 100, newest }).done).toBe(false);
    expect(modifiedSinceHeader(new Date('2026-11-19T09:55:00.123Z'))).toBe('2026-11-19T09:55:00');
  });
});

type Row = Record<string, unknown>;

/** A where clause as the reader asks it: equal, `in`, `notIn`, `not`, `lt`, `OR`. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return (condition as Row[]).some((each) => matches(row, each));
    const value = row[key] ?? null;
    if (condition === null) return value === null;
    if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
    if (condition && typeof condition === 'object') {
      const test = condition as Row;
      if ('in' in test) return (test.in as unknown[]).includes(value);
      if ('notIn' in test) return !(test.notIn as unknown[]).includes(value);
      if ('not' in test) return test.not === null ? value !== null : value !== test.not;
      if ('lt' in test) return value instanceof Date && value < (test.lt as Date);
      return true;
    }
    return value === condition;
  });
}

function harness(options: {
  invoices?: Row[];
  syncs?: Row[];
  writeOffs?: { xeroInvoiceId: string }[];
  contactLinks?: Row[];
  propertyLinks?: Row[];
  buildings?: Row[];
  payments?: Row[];
  paymentSyncs?: Row[];
  settings?: Row | null;
  organisation?: Row;
  connection?: Row | null;
  /** Xero's answers, page by page; past the last, an empty page. `null` is a 304. */
  invoicePages?: (unknown[] | null)[];
  paymentPages?: (unknown[] | null)[];
} = {}) {
  let ids = 0;
  const invoices: Row[] = (options.invoices ?? []).map((row) => ({ organizationId: ORG, ...row }));
  const lines: Row[] = [];
  const payments: Row[] = (options.payments ?? []).map((row) => ({ organizationId: ORG, ...row }));
  const contactLinks: Row[] = (options.contactLinks ?? []).map((row) => ({ organizationId: ORG, xeroTenantId: TENANT, ...row }));
  let settings: Row | null =
    options.settings === undefined
      ? {
          booksInvoicesSince: null,
          booksInvoicesPage: 1,
          booksPaymentsSince: null,
          booksPaymentsPage: 1,
          booksReadAt: null,
          booksLastRunAt: null,
          paymentAccounts: {},
          sendingClaimedUntil: null,
        }
      : options.settings;
  const invoicePages = [...(options.invoicePages ?? [[]])];
  const paymentPages = [...(options.paymentPages ?? [[]])];
  const prisma: Record<string, unknown> = {
    xeroSettings: {
      findUnique: jest.fn(async () => settings),
      // The companies whose books are read in full (2026-11-12): this one, once it is.
      findMany: jest.fn(async () => (settings?.booksReadAt ? [{ xeroTenantId: TENANT, booksLastRunAt: settings.booksLastRunAt ?? null }] : [])),
      update: jest.fn(async ({ data }: { data: Row }) => (settings = { ...settings!, ...data })),
      updateMany: jest.fn(async ({ where }: { where: Row }) => {
        if (!settings || !matches(settings, { OR: where.OR as Row[] })) return { count: 0 };
        settings = { ...settings, sendingClaimedUntil: new Date(Date.now() + 15 * 60_000) };
        return { count: 1 };
      }),
    },
    xeroOrganisation: { findUnique: jest.fn(async () => ({ status: 'CONNECTED', callsDay: '2026-11-20', callsUsed: 0, ...options.organisation })) },
    xeroConnection: { findUnique: jest.fn(async () => (options.connection === undefined ? { status: 'CONNECTED' } : options.connection)) },
    invoice: {
      findMany: jest.fn(async ({ where }: { where: Row }) => invoices.filter((row) => matches(row, where))),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: `made-${++ids}`, ...data };
        invoices.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(invoices.find((row) => row.id === where.id)!, data)),
      count: jest.fn(async ({ where }: { where: Row }) => invoices.filter((row) => matches(row, where)).length),
      aggregate: jest.fn(async ({ where }: { where: Row }) => ({
        _sum: { balanceCents: invoices.filter((row) => matches(row, where)).reduce((sum, row) => sum + (row.balanceCents as number), 0) },
      })),
    },
    invoiceLine: {
      deleteMany: jest.fn(async ({ where }: { where: { invoiceId: string } }) => {
        for (let index = lines.length - 1; index >= 0; index--) if (lines[index]!.invoiceId === where.invoiceId) lines.splice(index, 1);
        return { count: 0 };
      }),
      createMany: jest.fn(async ({ data }: { data: Row[] }) => (lines.push(...data), { count: data.length })),
    },
    invoicePayment: {
      findMany: jest.fn(async ({ where }: { where: Row }) => payments.filter((row) => matches(row, where))),
      deleteMany: jest.fn(async ({ where }: { where: Row }) => {
        const gone = payments.filter((row) => matches(row, where));
        for (const row of gone) payments.splice(payments.indexOf(row), 1);
        return { count: gone.length };
      }),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => payments.splice(payments.findIndex((row) => row.id === where.id), 1)[0]),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: `paid-${++ids}`, ...data };
        payments.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(payments.find((row) => row.id === where.id)!, data)),
      count: jest.fn(async () => payments.filter((row) => row.origin === 'XERO').length),
    },
    xeroInvoiceSync: {
      findMany: jest.fn(async ({ where }: { where: Row }) =>
        (options.syncs ?? [])
          .filter((row) => matches({ organizationId: ORG, ...row }, where))
          .map((row) => ({ xeroInvoiceId: row.xeroInvoiceId, invoice: invoices.find((invoice) => invoice.id === row.invoiceId) })),
      ),
    },
    xeroWriteOffSync: {
      findMany: jest.fn(async ({ where }: { where: { invoice: { is: { xeroSync: { is: { xeroInvoiceId: { in: string[] } } } } } } }) =>
        (options.writeOffs ?? [])
          .filter((row) => where.invoice.is.xeroSync.is.xeroInvoiceId.in.includes(row.xeroInvoiceId))
          .map((row) => ({ invoice: { xeroSync: { xeroInvoiceId: row.xeroInvoiceId } } })),
      ),
    },
    xeroPaymentSync: { findMany: jest.fn(async ({ where }: { where: Row }) => (options.paymentSyncs ?? []).filter((row) => matches({ organizationId: ORG, ...row }, where))) },
    xeroContactLink: {
      findMany: jest.fn(async ({ where }: { where: Row }) => contactLinks.filter((row) => matches(row, where))),
      createMany: jest.fn(async ({ data }: { data: Row[] }) => (contactLinks.push(...data.map((row) => ({ id: `link-${++ids}`, ...row }))), { count: data.length })),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(contactLinks.find((row) => row.id === where.id)!, data)),
    },
    jobberPropertyLink: { findMany: jest.fn(async ({ where }: { where: Row }) => (options.propertyLinks ?? []).filter((row) => matches({ organizationId: ORG, ...row }, where))) },
    propertywareBuilding: { findMany: jest.fn(async () => options.buildings ?? []) },
    auditLog: { create: jest.fn() },
    $executeRaw: jest.fn(async () => 1),
    // The newest invoice of each property the run touched, with its contact.
    $queryRaw: jest.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const touched = values.find(Array.isArray) as string[];
      const newest = new Map<string, Row>();
      for (const row of invoices)
        if (row.xeroInvoiceId && row.xeroContactId && touched.includes(row.propertywareBuildingId as string) && row.status !== 'VOIDED') {
          const kept = newest.get(row.propertywareBuildingId as string);
          if (!kept || (row.issuedOn as Date) > (kept.issuedOn as Date)) newest.set(row.propertywareBuildingId as string, row);
        }
      return [...newest.values()].map((row) => ({ buildingId: row.propertywareBuildingId, contactId: row.xeroContactId, name: row.clientName }));
    }),
    $transaction: jest.fn(async (work: unknown): Promise<unknown> =>
      typeof work === 'function' ? (work as (tx: unknown) => unknown)(prisma) : Promise.all(work as Promise<unknown>[]),
    ),
  };
  const client = {
    getChanged: jest.fn<Promise<unknown>, [string, string, string, unknown, string | null]>(async (_org, _tenant, path) => {
      const page = path.startsWith('/Invoices') ? (invoicePages.length ? invoicePages.shift()! : []) : paymentPages.length ? paymentPages.shift()! : [];
      if (page === null) return null;
      return path.startsWith('/Invoices') ? { Invoices: page } : { Payments: page };
    }),
  };
  const auth = { requireReconnect: jest.fn() };
  const books = new XeroBooksService(prisma as never, client as never, auth as never);
  return { books, prisma: prisma as { [model: string]: { [method: string]: jest.Mock } }, client, auth, invoices, lines, payments, contactLinks, settings: () => settings! };
}

const fromXero = (rows: Row[]) => rows.filter((row) => row.origin === 'XERO');
const pathsOf = (client: { getChanged: jest.Mock }) => client.getChanged.mock.calls.map(([, , path]) => (path as string).split('?')[0]);

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
});
afterEach(() => jest.useRealTimers());

describe('reading a company’s books', () => {
  it('reads its history from the start, keeps each invoice as Xero has it, then reads its payments', async () => {
    const paid = theirs({ AmountDue: 35, AmountPaid: 40, Payments: [{ PaymentID: 'p-1', Date: msDate('2026-11-10T00:00:00Z'), Amount: 40, Reference: 'Check 1042' }] });
    const { books, client, invoices, lines, payments, settings, prisma } = harness({ invoicePages: [[paid]] });

    const result = await books.run(ORG, TENANT);

    // Everything, the first time: no If-Modified-Since. Sales invoices only, oldest change first, a thousand a page.
    const [, , path, , since] = client.getChanged.mock.calls[0]!;
    expect(since).toBeNull();
    expect(decodeURIComponent(path as string)).toBe('/Invoices?where=Type=="ACCREC"&order=UpdatedDateUTC ASC&page=1&pageSize=1000');
    expect(pathsOf(client)).toEqual(['/Invoices', '/Payments']);
    expect(fromXero(invoices)).toEqual([
      expect.objectContaining({
        origin: 'XERO',
        xeroTenantId: TENANT,
        xeroInvoiceId: 'x-1',
        xeroContactId: 'contact-1',
        xeroStatus: 'AUTHORISED',
        number: '8440',
        status: 'AWAITING_PAYMENT',
        totalCents: 7500,
        balanceCents: 3500,
        amountPaidCents: 4000,
        issuedOn: new Date('2026-11-02T00:00:00.000Z'),
      }),
    ]);
    expect(lines).toEqual([expect.objectContaining({ name: 'Move Out Inspection', description: 'Full walk-through', totalCents: 7500 })]);
    expect(payments).toEqual([expect.objectContaining({ origin: 'XERO', xeroPaymentId: 'p-1', amountCents: 4000, method: 'OTHER', reference: 'Check 1042' })]);
    expect(result).toMatchObject({ caughtUp: true, calls: 2, problem: null, invoices: { made: 1, unplaced: 1 }, payments: { made: 1 } });
    // Read to the end: from now the console has its books. The claim is let go.
    expect(settings()).toMatchObject({ booksReadAt: NOW, sendingClaimedUntil: null, booksLastRunProblem: null });
    expect(settings().booksInvoicesSince).toEqual(new Date(Date.parse('2026-11-19T10:00:00Z') - BOOKS_OVERLAP_MS));
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'XERO_BOOKS_READ', actorUserId: null, metadata: expect.objectContaining({ tenantId: TENANT, firstReadInFull: true }) }),
    });
  });

  it('puts an invoice on the visit of the Jobber invoice the console sent as it', async () => {
    const { books, invoices } = harness({
      invoices: [{ id: 'jobber-1', origin: 'JOBBER', number: '8440', xeroTenantId: TENANT, inspectionId: VISIT, propertywareBuildingId: BUILDING }],
      syncs: [{ invoiceId: 'jobber-1', xeroTenantId: TENANT, xeroInvoiceId: 'x-1' }],
      invoicePages: [[theirs()]],
    });
    await books.run(ORG, TENANT);
    // And stands for it (2026-11-12): Jobber's copy is shown no longer once the company's books are read.
    expect(fromXero(invoices)[0]).toMatchObject({ inspectionId: VISIT, propertywareBuildingId: BUILDING, jobberCopyId: 'jobber-1' });
    // Nothing is written onto Jobber's copy.
    expect(invoices.find((row) => row.id === 'jobber-1')).not.toHaveProperty('xeroInvoiceId');
  });

  it('puts one Zapier made on the visit of the Jobber invoice under its number in the same company', async () => {
    const { books, invoices } = harness({
      invoices: [
        { id: 'jobber-1', origin: 'JOBBER', number: '8440', xeroTenantId: TENANT, clientName: '12 Example Lane', inspectionId: VISIT, propertywareBuildingId: BUILDING },
        // Another company's 8441: never this one's.
        { id: 'jobber-2', origin: 'JOBBER', number: '8441', xeroTenantId: OTHER_TENANT, clientName: '14 Example Lane', propertywareBuildingId: BUILDING_2 },
        // In no company: only for the same client.
        { id: 'jobber-3', origin: 'JOBBER', number: '8442', xeroTenantId: null, clientName: '16 Example Lane', propertywareBuildingId: BUILDING_2 },
        { id: 'jobber-4', origin: 'JOBBER', number: '8443', xeroTenantId: null, clientName: 'Someone else', propertywareBuildingId: BUILDING_2 },
      ],
      invoicePages: [
        [
          theirs(),
          theirs({ InvoiceID: 'x-2', InvoiceNumber: '8441', Contact: { ContactID: 'contact-2', Name: '14 Example Lane' } }),
          theirs({ InvoiceID: 'x-3', InvoiceNumber: '8442', Contact: { ContactID: 'contact-3', Name: '16 example lane' } }),
          theirs({ InvoiceID: 'x-4', InvoiceNumber: '8443', Contact: { ContactID: 'contact-4', Name: '18 Example Lane' } }),
        ],
      ],
    });
    const result = await books.run(ORG, TENANT);
    const placed = Object.fromEntries(fromXero(invoices).map((row) => [row.xeroInvoiceId, row.propertywareBuildingId ?? null]));
    expect(placed).toEqual({ 'x-1': BUILDING, 'x-2': null, 'x-3': BUILDING_2, 'x-4': null });
    expect(fromXero(invoices).find((row) => row.xeroInvoiceId === 'x-1')).toMatchObject({ inspectionId: VISIT });
    expect(result.invoices.unplaced).toBe(2);
    const copies = Object.fromEntries(fromXero(invoices).map((row) => [row.xeroInvoiceId, row.jobberCopyId ?? null]));
    expect(copies).toEqual({ 'x-1': 'jobber-1', 'x-2': null, 'x-3': 'jobber-3', 'x-4': null });
  });

  it('puts one on its contact’s one property, through the property or Jobber’s client, and none over several', async () => {
    const { books, invoices } = harness({
      contactLinks: [
        { clientKey: `property:${BUILDING}`, xeroContactId: 'contact-1' },
        { clientKey: 'jobber:client-2', xeroContactId: 'contact-2' },
        // A landlord's contact, over two properties.
        { clientKey: 'jobber:client-3', xeroContactId: 'contact-3' },
      ],
      propertyLinks: [
        { jobberClientId: 'client-2', status: 'LINKED', propertywareBuildingId: BUILDING_2 },
        { jobberClientId: 'client-3', status: 'LINKED', propertywareBuildingId: BUILDING },
        { jobberClientId: 'client-3', status: 'LINKED', propertywareBuildingId: BUILDING_2 },
      ],
      invoicePages: [
        [
          theirs({ InvoiceNumber: 'INV-1' }),
          theirs({ InvoiceID: 'x-2', InvoiceNumber: 'INV-2', Contact: { ContactID: 'contact-2', Name: 'Two' } }),
          theirs({ InvoiceID: 'x-3', InvoiceNumber: 'INV-3', Contact: { ContactID: 'contact-3', Name: 'Three' } }),
        ],
      ],
    });
    await books.run(ORG, TENANT);
    const placed = Object.fromEntries(fromXero(invoices).map((row) => [row.xeroInvoiceId, row.propertywareBuildingId ?? null]));
    expect(placed).toEqual({ 'x-1': BUILDING, 'x-2': BUILDING_2, 'x-3': null });
  });

  it('keeps the Jobber copy it stands for, and still finds its property through the contact when that copy has none', async () => {
    const { books, invoices } = harness({
      invoices: [{ id: 'jobber-1', origin: 'JOBBER', number: '8440', xeroTenantId: TENANT, clientName: '12 Example Lane', inspectionId: null, propertywareBuildingId: null }],
      contactLinks: [{ clientKey: `property:${BUILDING}`, xeroContactId: 'contact-1' }],
      invoicePages: [[theirs()]],
    });
    await books.run(ORG, TENANT);
    expect(fromXero(invoices)[0]).toMatchObject({ jobberCopyId: 'jobber-1', propertywareBuildingId: BUILDING, inspectionId: null });
  });

  it('puts one on the property its contact’s address is, exactly', async () => {
    const { books, invoices } = harness({
      buildings: [
        { id: BUILDING, addressLine1: '12 Example Lane', postalCode: '75964' },
        { id: BUILDING_2, addressLine1: '14 Example Lane', postalCode: '75964' },
      ],
      invoicePages: [
        [
          theirs({ InvoiceNumber: 'INV-1', Contact: { ContactID: 'contact-9', Name: 'Tenant', Addresses: [{ AddressType: 'POBOX', AddressLine1: '12 Example Ln.', PostalCode: '75964' }] } }),
          theirs({ InvoiceID: 'x-2', InvoiceNumber: 'INV-2', Contact: { ContactID: 'contact-8', Name: 'Tenant', Addresses: [{ AddressType: 'POBOX', AddressLine1: '99 Nowhere Rd', PostalCode: '75964' }] } }),
        ],
      ],
    });
    await books.run(ORG, TENANT);
    const placed = Object.fromEntries(fromXero(invoices).map((row) => [row.xeroInvoiceId, row.propertywareBuildingId ?? null]));
    expect(placed).toEqual({ 'x-1': BUILDING, 'x-2': null });
  });

  it('learns each property’s contact from its newest invoice', async () => {
    const { books, contactLinks } = harness({
      invoices: [{ id: 'jobber-1', origin: 'JOBBER', number: '8440', xeroTenantId: TENANT, inspectionId: VISIT, propertywareBuildingId: BUILDING }],
      invoicePages: [
        [
          theirs({ Contact: { ContactID: 'contact-old', Name: '12 Example Lane' } }),
          theirs({ InvoiceID: 'x-2', InvoiceNumber: '8440', DateString: '2026-11-09T00:00:00', Contact: { ContactID: 'contact-new', Name: '12 Example Lane' } }),
        ],
      ],
    });
    await books.run(ORG, TENANT);
    expect(contactLinks).toEqual([expect.objectContaining({ clientKey: `property:${BUILDING}`, xeroContactId: 'contact-new', name: '12 Example Lane' })]);
  });

  it('writes nothing for one read again unchanged, or for a draft deleted before it was ever read', async () => {
    const updated = xeroInstant(theirs().UpdatedDateUTC)!;
    const { books, prisma } = harness({
      invoices: [{ id: 'read-1', origin: 'XERO', xeroTenantId: TENANT, xeroInvoiceId: 'x-1', xeroUpdatedAt: updated, propertywareBuildingId: BUILDING }],
      invoicePages: [[theirs(), theirs({ InvoiceID: 'x-2', Status: 'DELETED' })]],
    });
    const result = await books.run(ORG, TENANT);
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(result.invoices).toMatchObject({ made: 0, updated: 0, unchanged: 2 });
  });

  it('keeps a voided invoice voided, owing nothing, and takes away a payment deleted in Xero -- only one read from it', async () => {
    const { books, invoices, payments } = harness({
      invoices: [{ id: 'read-1', origin: 'XERO', xeroTenantId: TENANT, xeroInvoiceId: 'x-1', xeroUpdatedAt: new Date('2026-11-01T00:00:00Z'), propertywareBuildingId: BUILDING }],
      payments: [{ id: 'paid-1', invoiceId: 'read-1', origin: 'XERO', xeroPaymentId: 'p-1', paidOn: new Date('2026-11-10T00:00:00Z'), amountCents: 4000, reference: null }],
      invoicePages: [[theirs({ Status: 'VOIDED', AmountDue: 75, Payments: [] })]],
    });
    await books.run(ORG, TENANT);
    expect(invoices[0]).toMatchObject({ id: 'read-1', status: 'VOIDED', xeroStatus: 'VOIDED', balanceCents: 0, propertywareBuildingId: BUILDING });
    expect(payments).toEqual([]);
  });

  it('calls one the console wrote off a bad debt, and any other paid one paid', async () => {
    const { books, invoices } = harness({
      writeOffs: [{ xeroInvoiceId: 'x-1' }],
      invoicePages: [[theirs({ Status: 'PAID', AmountDue: 0, AmountCredited: 75 }), theirs({ InvoiceID: 'x-2', Status: 'PAID', AmountDue: 0, AmountCredited: 75 })]],
    });
    await books.run(ORG, TENANT);
    expect(fromXero(invoices).map((row) => [row.xeroInvoiceId, row.status, row.amountCreditedCents])).toEqual([
      ['x-1', 'BAD_DEBT', 7500],
      ['x-2', 'PAID', 7500],
    ]);
  });

  it('keeps the console’s own invoice where it is, brought up to date from Xero, its payments not made twice', async () => {
    const { books, invoices, payments } = harness({
      invoices: [
        { id: 'console-1', origin: 'CONSOLE', number: null, subject: 'Move-out inspection', xeroTenantId: TENANT, inspectionId: VISIT, propertywareBuildingId: BUILDING, xeroInvoiceId: null },
      ],
      syncs: [{ invoiceId: 'console-1', xeroTenantId: TENANT, xeroInvoiceId: 'x-1' }],
      payments: [
        // Recorded here and sent to Xero as p-1.
        { id: 'paid-here', invoiceId: 'console-1', origin: 'CONSOLE', xeroPaymentId: null, amountCents: 4000 },
        // Recorded here, never in Xero: a read never takes it away.
        { id: 'kept-here', invoiceId: 'console-1', origin: 'CONSOLE', xeroPaymentId: null, amountCents: 100 },
      ],
      paymentSyncs: [{ paymentId: 'paid-here', invoiceId: 'console-1', xeroPaymentId: 'p-1' }],
      invoicePages: [
        [
          theirs({
            Status: 'AUTHORISED',
            AmountDue: 35,
            AmountPaid: 40,
            Payments: [
              { PaymentID: 'p-1', Date: msDate('2026-11-10T00:00:00Z'), Amount: 40 },
              { PaymentID: 'p-2', Date: msDate('2026-11-11T00:00:00Z'), Amount: 0.5 },
            ],
          }),
        ],
      ],
    });
    const result = await books.run(ORG, TENANT);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      id: 'console-1',
      origin: 'CONSOLE',
      xeroInvoiceId: 'x-1',
      number: '8440',
      balanceCents: 3500,
      subject: 'Move-out inspection',
      inspectionId: VISIT,
      propertywareBuildingId: BUILDING,
    });
    expect(payments.find((row) => row.id === 'paid-here')).toMatchObject({ xeroPaymentId: 'p-1', origin: 'CONSOLE' });
    expect(payments.find((row) => row.id === 'kept-here')).toBeDefined();
    expect(fromXero(payments)).toEqual([expect.objectContaining({ invoiceId: 'console-1', xeroPaymentId: 'p-2', amountCents: 50 })]);
    expect(result.invoices).toMatchObject({ made: 0, updated: 1 });
  });

  it('counts one Xero sends oddly, and reads the rest of the page', async () => {
    const { books, invoices } = harness({ invoicePages: [[{ InvoiceID: 42 }, theirs(), theirs({ InvoiceID: 'x-2', Status: 'NEVER_SEEN' })]] });
    const result = await books.run(ORG, TENANT);
    expect(fromXero(invoices)).toHaveLength(1);
    expect(result.invoices.unreadable).toBe(2);
  });

  it('reads only what changed since, a little before the newest seen; Xero’s 304 is nothing changed', async () => {
    const since = new Date('2026-11-19T09:55:00.000Z');
    const { books, client, settings, prisma } = harness({
      settings: { booksInvoicesSince: since, booksInvoicesPage: 1, booksPaymentsSince: since, booksPaymentsPage: 1, booksReadAt: new Date('2026-11-13T00:00:00Z'), paymentAccounts: {} },
      invoicePages: [null],
      paymentPages: [null],
    });
    const result = await books.run(ORG, TENANT);
    expect(client.getChanged.mock.calls.map(([, , , , header]) => header)).toEqual(['2026-11-19T09:55:00', '2026-11-19T09:55:00']);
    expect(result).toMatchObject({ caughtUp: true, calls: 2 });
    expect(settings()).toMatchObject({ booksInvoicesSince: since, booksPaymentsSince: since });
    // Nothing changed: nothing to record.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('reads the history a few pages a run, and its payments only once its invoices are all read', async () => {
    const full = Array.from({ length: 1000 }, (_, index) =>
      theirs({ InvoiceID: `x-${index}`, InvoiceNumber: `INV-${index}`, UpdatedDateUTC: msDate(new Date(Date.parse('2026-01-01T00:00:00Z') + index * 3_600_000).toISOString()) }),
    );
    const { books, client, settings } = harness({ invoicePages: [full, full, full, full, full, full] });
    const result = await books.run(ORG, TENANT);
    // Six calls at most a run; all on invoices, the history not done yet.
    expect(pathsOf(client)).toEqual(['/Invoices', '/Invoices', '/Invoices', '/Invoices', '/Invoices', '/Invoices']);
    expect(result).toMatchObject({ caughtUp: false, calls: 6 });
    expect(settings().booksReadAt).toBeNull();
    // Each page moves on to the newest it held.
    expect(client.getChanged.mock.calls[1]![4]).toBe(modifiedSinceHeader(new Date(Date.parse('2026-01-01T00:00:00Z') + 999 * 3_600_000 - BOOKS_OVERLAP_MS)));
  });

  it('“Read now” reads a page of each, at most once a minute', async () => {
    const { books, client, prisma } = harness({ invoicePages: [[theirs()]] });
    await books.readNow(office, TENANT);
    expect(client.getChanged).toHaveBeenCalledTimes(MANUAL_BOOKS_CALLS);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'XERO_BOOKS_READ', actorUserId: office.id }) });
    await expect(books.readNow(office, TENANT)).rejects.toMatchObject({ code: 'XERO_BOOKS_TOO_SOON', status: 429 });
  });

  it('“Read invoices from Xero now” on the invoices page reads each company shown as Xero has it, at most once a minute', async () => {
    const { books, client } = harness({
      settings: {
        booksInvoicesSince: null,
        booksInvoicesPage: 1,
        booksPaymentsSince: null,
        booksPaymentsPage: 1,
        booksReadAt: new Date('2026-11-13T00:00:00Z'),
        booksLastRunAt: new Date(NOW.getTime() - 5 * 60_000),
        paymentAccounts: {},
      },
    });
    await expect(books.readAllNow(office)).resolves.toEqual({ companies: 1, problems: [] });
    expect(pathsOf(client)).toEqual(['/Invoices', '/Payments']);
    await expect(books.readAllNow(office)).rejects.toMatchObject({ code: 'XERO_BOOKS_TOO_SOON', status: 429 });
    await expect(harness().books.readAllNow(office)).rejects.toMatchObject({ code: 'XERO_BOOKS_NOT_READY', status: 409 });
  });

  it('leaves the day’s last calls to sending, waits for a sending run, and asks nothing of a company not connected', async () => {
    const ceiling = 300;
    const near = harness({ organisation: { callsUsed: ceiling - CALLS_KEPT_FOR_SENDING } });
    await expect(near.books.run(ORG, TENANT)).resolves.toMatchObject({ calls: 0, problem: expect.stringContaining('carries on tomorrow') });
    expect(near.client.getChanged).not.toHaveBeenCalled();
    // Yesterday's count is not today's.
    const yesterday = harness({ organisation: { callsDay: '2026-11-19', callsUsed: 290 } });
    await expect(yesterday.books.run(ORG, TENANT)).resolves.toMatchObject({ problem: null });

    const busy = harness();
    busy.settings().sendingClaimedUntil = new Date(NOW.getTime() + 60_000);
    await expect(busy.books.run(ORG, TENANT)).resolves.toMatchObject({ problem: expect.stringContaining('busy with a sending run') });
    expect(busy.client.getChanged).not.toHaveBeenCalled();

    const gone = harness({ connection: { status: 'REAUTHORIZATION_REQUIRED' } });
    await expect(gone.books.run(ORG, TENANT)).resolves.toMatchObject({ problem: 'Xero is not connected.' });
    expect(gone.client.getChanged).not.toHaveBeenCalled();
  });

  it('asks for the sign-in again when Xero refuses it, and keeps where it got to', async () => {
    const { books, client, auth, settings } = harness();
    const { XeroError } = await import('../src/integrations/xero/xero.errors');
    client.getChanged.mockRejectedValueOnce(new XeroError('Xero refused the stored sign-in. Connect again.', 'XERO_REAUTHORIZATION_REQUIRED', 409, 401));
    const result = await books.run(ORG, TENANT);
    expect(result.problem).toBe('Xero refused the stored sign-in. Connect again.');
    expect(auth.requireReconnect).toHaveBeenCalledWith(ORG, 'Xero refused the stored sign-in. Connect again.');
    expect(settings()).toMatchObject({ sendingClaimedUntil: null, booksInvoicesSince: null, booksInvoicesPage: 1, booksReadAt: null });
  });
});

describe('reading its payments', () => {
  const read = { booksInvoicesSince: null, booksInvoicesPage: 1, booksPaymentsSince: null, booksPaymentsPage: 1, booksReadAt: new Date('2026-11-13T00:00:00Z') };
  const payment = (over: Row = {}) => ({
    PaymentID: 'p-1',
    Date: msDate('2026-11-10T00:00:00Z'),
    Amount: 40,
    Reference: 'Check 1042',
    Status: 'AUTHORISED',
    PaymentType: 'ACCRECPAYMENT',
    UpdatedDateUTC: msDate('2026-11-10T12:00:00Z'),
    Account: { AccountID: 'a-090' },
    Invoice: { InvoiceID: 'x-1', Type: 'ACCREC' },
    ...over,
  });

  it('says how each came in from its account, takes away only its own deleted ones, and counts those on no invoice read', async () => {
    const { books, payments } = harness({
      settings: { ...read, paymentAccounts: { CHECK: 'a-090' } },
      invoices: [{ id: 'read-1', origin: 'XERO', xeroTenantId: TENANT, xeroInvoiceId: 'x-1' }],
      payments: [
        { id: 'paid-1', invoiceId: 'read-1', origin: 'XERO', xeroPaymentId: 'p-1', method: 'OTHER', paidOn: new Date('2026-11-10T00:00:00Z'), amountCents: 4000, reference: 'Check 1042' },
        { id: 'paid-2', invoiceId: 'read-1', origin: 'XERO', xeroPaymentId: 'p-2', method: 'OTHER', paidOn: new Date('2026-11-10T00:00:00Z'), amountCents: 100, reference: null },
        { id: 'paid-here', invoiceId: 'console-1', origin: 'CONSOLE', xeroPaymentId: 'p-3', method: 'CASH', paidOn: new Date('2026-11-10T00:00:00Z'), amountCents: 100, reference: null },
      ],
      paymentPages: [
        [
          payment(),
          payment({ PaymentID: 'p-2', Status: 'DELETED' }),
          payment({ PaymentID: 'p-3', Status: 'DELETED' }),
          payment({ PaymentID: 'p-4', Invoice: { InvoiceID: 'x-1' }, Amount: 5 }),
          payment({ PaymentID: 'p-5', Invoice: { InvoiceID: 'x-unknown' } }),
          payment({ PaymentID: 'p-6', PaymentType: 'ACCPAYPAYMENT' }),
        ],
      ],
    });
    const result = await books.run(ORG, TENANT);
    expect(payments.find((row) => row.id === 'paid-1')).toMatchObject({ method: 'CHECK' });
    expect(payments.find((row) => row.id === 'paid-2')).toBeUndefined();
    // The office's own payment is never taken away by a read.
    expect(payments.find((row) => row.id === 'paid-here')).toBeDefined();
    expect(payments.find((row) => row.xeroPaymentId === 'p-4')).toMatchObject({ invoiceId: 'read-1', origin: 'XERO', amountCents: 500, method: 'CHECK' });
    expect(result.payments).toEqual({ made: 1, updated: 1, removed: 1, unplaced: 1 });
  });
});

describe('what has been read, on the Xero page', () => {
  it('counts what was read, where it went, and what is still owed, from the console’s own rows', async () => {
    const { books, client } = harness({
      settings: { booksReadAt: new Date('2026-11-13T00:00:00Z'), booksLastRunAt: NOW, booksLastRunProblem: null },
      invoices: [
        { id: 'r-1', origin: 'XERO', xeroTenantId: TENANT, status: 'AWAITING_PAYMENT', balanceCents: 7500, propertywareBuildingId: BUILDING },
        { id: 'r-2', origin: 'XERO', xeroTenantId: TENANT, status: 'AWAITING_PAYMENT', balanceCents: 2500, propertywareBuildingId: null, number: 'INV-2', clientName: 'Tenant', issuedOn: new Date('2026-11-02T00:00:00Z'), totalCents: 2500, xeroStatus: 'AUTHORISED' },
        { id: 'j-1', origin: 'JOBBER', xeroTenantId: TENANT, status: 'AWAITING_PAYMENT', balanceCents: 9900, propertywareBuildingId: null },
      ],
    });
    const view = await books.view(ORG, TENANT);
    expect(view).toMatchObject({
      tenantId: TENANT,
      readAt: '2026-11-13T00:00:00.000Z',
      counts: { invoices: 2, placed: 1, unplaced: 1, owedCents: 10000 },
      unplaced: [{ number: 'INV-2', clientName: 'Tenant', issuedOn: '2026-11-02', totalCents: 2500, xeroStatus: 'AUTHORISED' }],
    });
    expect(client.getChanged).not.toHaveBeenCalled();
  });
});
