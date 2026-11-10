import { UserRole } from '@texasrenters/shared';

import { InvoiceReportsController } from '../src/admin/invoice-reports.controller';
import { InvoiceReportsService } from '../src/admin/invoice-reports.service';
import { InvoicesService } from '../src/admin/invoices.service';
import { PERMISSIONS_METADATA_KEY, type AuthenticatedUser } from '../src/common/auth';

/**
 * Where the money stands (2026-11-09, phase 2 of the invoice gap review), as
 * Jobber's financial reports show it. Reads of the console's own copy only.
 * Today is Friday 2026-11-20 in Texas. Names and addresses invented.
 */

const ORG = '60000000-0000-4000-8000-000000000001';
const TODAY = '2026-11-20';
const office: AuthenticatedUser = {
  id: '60000000-0000-4000-8000-000000000030',
  authUserId: 'auth-office',
  organizationId: ORG,
  displayName: 'Ada Lane',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: ['invoices:read'],
  mustChangePassword: false,
  principalType: 'USER',
};

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const iso = (value: Date) => value.toISOString().slice(0, 10);

beforeEach(() => {
  // 12:00 in Texas on the 20th.
  jest.useFakeTimers({
    now: new Date('2026-11-20T18:00:00.000Z'),
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'nextTick', 'setImmediate', 'queueMicrotask'],
  });
});
afterEach(() => jest.useRealTimers());

const row = (over: Record<string, unknown> = {}) => ({
  id: 'inv-1',
  number: '8439',
  clientName: '100 Example Way',
  subject: 'For Services Rendered',
  status: 'AWAITING_PAYMENT',
  createdAt: new Date('2026-10-21T15:00:00.000Z'),
  issuedOn: day('2026-10-21'),
  dueOn: day('2026-11-10'),
  totalCents: 3999,
  balanceCents: 3999,
  jobNumber: '20600',
  clientEmails: ['owner@example.com', 'manager@example.com'],
  clientPhones: ['555-0100'],
  ...over,
});

function database() {
  return {
    invoice: {
      aggregate: jest.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: {} }),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    invoicePayment: {
      aggregate: jest.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: {} }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    invoiceDelivery: { groupBy: jest.fn().mockResolvedValue([]) },
  };
}
const reportsOver = (db: ReturnType<typeof database>) => new InvoiceReportsService(db as never);

/** The where clause each aggregate was asked with, its due-day window as days. */
const windows = (db: ReturnType<typeof database>) =>
  db.invoice.aggregate.mock.calls.map(([args]) => {
    const due = (args.where.AND?.[1] ?? {}).dueOn ?? {};
    return {
      lt: due.lt ? iso(due.lt) : undefined,
      lte: due.lte ? iso(due.lte) : undefined,
      gt: due.gt ? iso(due.gt) : undefined,
      gte: due.gte ? iso(due.gte) : undefined,
    };
  });

describe('Projected income', () => {
  it("splits what is owed by Jobber's due windows, and lists it by due date", async () => {
    const db = database();
    db.invoice.aggregate.mockImplementation(async () => ({ _count: { _all: 2 }, _sum: { balanceCents: 7998 } }));
    db.invoice.findMany.mockResolvedValue([row()]);

    const report = await reportsOver(db).projectedIncome(office);

    expect(windows(db).slice(0, 4)).toEqual([
      { lt: '2026-11-20', lte: undefined, gt: undefined, gte: undefined }, // late
      { lt: undefined, lte: undefined, gt: undefined, gte: undefined }, // due today, an exact day
      { lt: '2026-11-27', lte: undefined, gt: '2026-11-20', gte: undefined }, // within 7 days
      { lt: undefined, lte: '2026-12-20', gt: undefined, gte: '2026-11-27' }, // 7 to 30 days
    ]);
    expect(db.invoice.aggregate.mock.calls[1][0].where.AND[1]).toEqual({ dueOn: day(TODAY) });
    expect(db.invoice.aggregate.mock.calls[0][0].where.AND[0]).toEqual({
      organizationId: ORG,
      status: 'AWAITING_PAYMENT',
      balanceCents: { gt: 0 },
    });
    expect(report.overview.outstanding).toEqual({ count: 2, amountCents: 7998 });
    // Past its due date, so past due; the client's first address and phone.
    expect(report.rows[0]).toMatchObject({ status: 'PAST_DUE', email: 'owner@example.com', phone: '555-0100', dueOn: '2026-11-10' });
    expect(report.truncated).toBe(false);
  });

  it('says when there were more rows than it lists', async () => {
    const db = database();
    db.invoice.findMany.mockResolvedValue(Array.from({ length: 5001 }, (_, index) => row({ id: `inv-${index}` })));
    const report = await reportsOver(db).projectedIncome(office);
    expect(report.rows).toHaveLength(5000);
    expect(report.truncated).toBe(true);
  });
});

describe('Aged receivables', () => {
  it('counts the late ones under 30 days, 30 to 60, 60 to 90 and over 90, and says how late each is', async () => {
    const db = database();
    db.invoice.findMany.mockResolvedValue([row({ dueOn: day('2026-08-01') })]);

    const report = await reportsOver(db).agedReceivables(office);

    expect(windows(db)).toEqual([
      { lte: '2026-11-19', gte: '2026-10-22', lt: undefined, gt: undefined },
      { lte: '2026-10-21', gte: '2026-09-22', lt: undefined, gt: undefined },
      { lte: '2026-09-21', gte: '2026-08-23', lt: undefined, gt: undefined },
      { lte: '2026-08-22', gte: undefined, lt: undefined, gt: undefined },
      { lte: '2026-11-19', gte: undefined, lt: undefined, gt: undefined },
    ]);
    expect(report.rows[0]).toMatchObject({ daysLate: 111, status: 'PAST_DUE' });
  });
});

describe('the transaction list', () => {
  it('lists invoices issued and money in and out, newest first, a refund as money out', async () => {
    const db = database();
    db.invoice.aggregate.mockResolvedValue({ _count: { _all: 3 }, _sum: { totalCents: 15000 } });
    db.invoicePayment.aggregate
      .mockResolvedValueOnce({ _count: { _all: 2 }, _sum: { amountCents: 8000 } })
      .mockResolvedValueOnce({ _count: { _all: 1 }, _sum: { amountCents: -1000 } });
    db.invoice.findMany.mockResolvedValue([
      { id: 'inv-1', number: '8439', clientName: '100 Example Way', issuedOn: day('2026-11-02'), totalCents: 3999, jobNumber: '20600' },
    ]);
    db.invoicePayment.findMany.mockResolvedValue([
      { id: 'pay-1', paidOn: day('2026-11-10'), amountCents: 3999, method: 'CHECK', reference: '1042', invoice: { id: 'inv-1', number: '8439', clientName: '100 Example Way', jobNumber: '20600' } },
      { id: 'pay-2', paidOn: day('2026-11-05'), amountCents: -1000, method: 'OTHER', reference: null, invoice: { id: 'inv-2', number: '8440', clientName: '200 Sample Rd', jobNumber: null } },
    ]);

    const report = await reportsOver(db).transactions(office, { from: '2026-11-01', to: TODAY });

    expect(report.rows.map((entry) => [entry.kind, entry.on, entry.totalCents])).toEqual([
      ['PAYMENT', '2026-11-10', 3999],
      ['REFUND', '2026-11-05', -1000],
      ['INVOICE', '2026-11-02', 3999],
    ]);
    // Invoiced, less what came in, plus what went back out.
    expect(report.overview).toEqual({
      paid: { count: 2, amountCents: 8000 },
      refunded: { count: 1, amountCents: 1000 },
      invoiced: { count: 3, amountCents: 15000 },
      balance: { count: 3, amountCents: 8000 },
    });
    expect(db.invoice.findMany.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      status: { notIn: ['DRAFT', 'VOIDED'] },
      issuedOn: { gte: day('2026-11-01'), lte: day(TODAY) },
    });
  });

  it('refuses a span it will not read', async () => {
    await expect(reportsOver(database()).transactions(office, { from: '2025-01-01', to: TODAY })).rejects.toMatchObject({
      code: 'REPORT_RANGE_INVALID',
    });
    await expect(reportsOver(database()).transactions(office, { from: TODAY, to: '2026-11-01' })).rejects.toMatchObject({
      code: 'REPORT_RANGE_INVALID',
    });
  });
});

describe('the invoices report, and bad debt', () => {
  it('reads by the Texas day an invoice was made, and adds up all but the voided', async () => {
    const db = database();
    db.invoice.groupBy.mockResolvedValue([
      { status: 'AWAITING_PAYMENT', _count: { _all: 2 }, _sum: { totalCents: 7998 } },
      { status: 'PAID', _count: { _all: 1 }, _sum: { totalCents: 3999 } },
      { status: 'VOIDED', _count: { _all: 1 }, _sum: { totalCents: 9999 } },
    ]);

    const report = await reportsOver(db).invoices(office, { from: '2026-11-01', to: '2026-11-07', dateField: 'created' });

    // Midnight in Texas (CDT then CST) on the first day, to midnight after the last.
    expect(db.invoice.findMany.mock.calls[0][0].where.AND[1]).toEqual({
      createdAt: { gte: new Date('2026-11-01T05:00:00.000Z'), lt: new Date('2026-11-08T06:00:00.000Z') },
    });
    expect(report.overview.total).toEqual({ count: 3, amountCents: 11997 });
    expect(report.overview.paid).toEqual({ count: 1, amountCents: 3999 });
  });

  it('is only bad debt when asked, by the day issued', async () => {
    const db = database();
    await reportsOver(db).invoices(office, { from: '2026-11-01', to: TODAY, dateField: 'issued', status: 'BAD_DEBT' });
    expect(db.invoice.findMany.mock.calls[0][0].where.AND).toEqual([
      { organizationId: ORG },
      { issuedOn: { gte: day('2026-11-01'), lte: day(TODAY) } },
      { status: 'BAD_DEBT' },
    ]);
  });
});

describe('taxation', () => {
  const taxed = { id: 'inv-1', taxRateName: 'Texas sales tax', taxRatePercent: 8.25, taxCents: 825, totalCents: 10825 };
  const untaxed = { id: 'inv-2', taxRateName: null, taxRatePercent: null, taxCents: 0, totalCents: 3999 };

  it('adds up what was invoiced by rate (accrual), and the tax still to collect', async () => {
    const db = database();
    db.invoice.findMany
      .mockResolvedValueOnce([taxed, untaxed, { ...taxed, id: 'inv-3' }])
      .mockResolvedValueOnce([{ balanceCents: 10825, taxCents: 825, totalCents: 10825 }]);

    const report = await reportsOver(db).taxes(office, { from: '2026-11-01', to: TODAY, basis: 'ACCRUAL' });

    expect(report.rows).toEqual([
      { rateName: 'Texas sales tax', ratePercent: 8.25, invoices: 2, taxableCents: 20000, taxCents: 1650, totalCents: 21650 },
      { rateName: 'No tax', ratePercent: null, invoices: 1, taxableCents: 3999, taxCents: 0, totalCents: 3999 },
    ]);
    expect(report.totals).toEqual({ invoices: 3, taxableCents: 23999, taxCents: 1650, totalCents: 25649 });
    expect(report.awaitingCollectionCents).toBe(825);
  });

  it("counts each payment's share of its invoice's tax (cash)", async () => {
    const db = database();
    db.invoicePayment.findMany.mockResolvedValue([{ amountCents: 5412, invoice: taxed }]);
    const report = await reportsOver(db).taxes(office, { from: '2026-11-01', to: TODAY, basis: 'CASH' });
    // Half the invoice paid, so half its tax: 5412 x 825 / 10825 = 412.46, which rounds to 412.
    expect(report.rows[0]).toMatchObject({ invoices: 1, totalCents: 5412, taxCents: 412, taxableCents: 5000 });
  });
});

describe('the client balance summary', () => {
  it("adds up each property's invoices: invoiced, paid, owed, late, and how long it takes to pay", async () => {
    const db = database();
    const invoice = (over: Record<string, unknown>) => ({
      id: 'x',
      jobberClientId: 'client-1',
      propertywareBuildingId: 'b-1',
      clientName: '100 Example Way',
      clientEmails: ['owner@example.com'],
      clientPhones: [],
      status: 'PAID',
      totalCents: 3999,
      balanceCents: 0,
      issuedOn: day('2026-10-01'),
      dueOn: day('2026-10-31'),
      paidOn: day('2026-10-11'),
      ...over,
    });
    db.invoice.findMany.mockResolvedValue([
      invoice({ id: 'a' }),
      invoice({ id: 'b', status: 'AWAITING_PAYMENT', balanceCents: 3999, paidOn: null, dueOn: day('2026-11-01') }),
      invoice({ id: 'c', status: 'AWAITING_PAYMENT', balanceCents: 2500, totalCents: 2500, paidOn: null, dueOn: day('2026-12-01') }),
      // Written off: invoiced, never paid, and not owed.
      invoice({ id: 'd', status: 'BAD_DEBT', balanceCents: 3999, paidOn: null }),
      invoice({ id: 'e', jobberClientId: 'client-2', clientName: '200 Sample Rd', balanceCents: -500, totalCents: 3999, paidOn: day('2026-10-31') }),
    ]);
    db.invoiceDelivery.groupBy.mockResolvedValue([{ invoiceId: 'b', _max: { sentAt: new Date('2026-11-02T15:00:00.000Z') } }]);

    const report = await reportsOver(db).clientBalances(office);

    expect(report.rows[0]).toMatchObject({
      key: 'client-1',
      invoicedCents: 3999 * 3 + 2500,
      paidCents: 3999,
      balanceCents: 6499,
      lateBalanceCents: 3999,
      paymentDays: 10,
      lastEmailedAt: '2026-11-02T15:00:00.000Z',
      email: 'owner@example.com',
    });
    // Paid more than invoiced: a credit.
    expect(report.rows[1]).toMatchObject({ key: 'client-2', balanceCents: -500, paymentDays: 30 });
    expect(report.overview).toEqual({
      outstanding: { count: 1, amountCents: 6499 },
      credit: { count: 1, amountCents: -500 },
      total: { count: 2, amountCents: 5999 },
    });
  });
});

describe("the payments page's cards", () => {
  it('averages the days from issued to paid over the past 30 days, and counts those paid on time over 60', async () => {
    const db = database();
    db.invoice.findMany
      .mockResolvedValueOnce([
        { issuedOn: day('2026-10-21'), dueOn: day('2026-11-20'), paidOn: day('2026-11-02') },
        { issuedOn: day('2026-10-01'), dueOn: day('2026-10-31'), paidOn: day('2026-11-05') },
      ])
      .mockResolvedValueOnce([
        { issuedOn: day('2026-10-21'), dueOn: day('2026-11-20'), paidOn: day('2026-11-02') },
        { issuedOn: day('2026-10-01'), dueOn: day('2026-10-31'), paidOn: day('2026-11-05') },
        { issuedOn: day('2026-09-01'), dueOn: null, paidOn: day('2026-09-25') },
      ]);

    const insights = await reportsOver(db).paymentInsights(office);

    // 12 and 35 days.
    expect(insights).toEqual({ paymentDays: { days: 24, invoices: 2 }, paidOnTime: { onTime: 2, invoices: 3 } });
    expect(db.invoice.findMany.mock.calls[0][0].where.paidOn).toEqual({ gte: day('2026-10-22'), lte: day(TODAY) });
  });
});

describe('one company’s books (2026-11-10)', () => {
  const PEST = 'a2000000-0000-4000-8000-000000000002';

  it('reads what is owed and what is late for one company, or for none', async () => {
    const db = database();
    await reportsOver(db).projectedIncome(office, PEST);
    expect(db.invoice.findMany.mock.calls[0][0].where).toMatchObject({ organizationId: ORG, xeroTenantId: PEST });
    expect(db.invoice.aggregate.mock.calls[0][0].where.AND[0]).toMatchObject({ xeroTenantId: PEST });

    await reportsOver(db).agedReceivables(office, 'none');
    expect(db.invoice.findMany.mock.calls[1][0].where).toMatchObject({ organizationId: ORG, xeroTenantId: null });
  });

  it('counts a company’s invoices and the payments against them, and no one else’s', async () => {
    const db = database();
    await reportsOver(db).transactions(office, { from: '2026-11-01', to: TODAY }, PEST);
    expect(db.invoice.aggregate.mock.calls[0][0].where).toMatchObject({ xeroTenantId: PEST });
    for (const [args] of db.invoicePayment.aggregate.mock.calls) expect(args.where.invoice).toEqual({ xeroTenantId: PEST });
    expect(db.invoicePayment.findMany.mock.calls[0][0].where.invoice).toEqual({ xeroTenantId: PEST });
  });

  it('lists a company’s invoices, its taxes, and its clients’ balances', async () => {
    const db = database();
    await reportsOver(db).invoices(office, { from: '2026-11-01', to: TODAY, dateField: 'issued' }, PEST);
    expect(db.invoice.findMany.mock.calls[0][0].where.AND).toContainEqual({ xeroTenantId: PEST });

    await reportsOver(db).taxes(office, { from: '2026-11-01', to: TODAY, basis: 'CASH' }, PEST);
    expect(db.invoicePayment.findMany.mock.calls[0][0].where.invoice).toEqual({ xeroTenantId: PEST });

    await reportsOver(db).clientBalances(office, PEST);
    expect(db.invoice.findMany.mock.calls.at(-1)![0].where).toMatchObject({ organizationId: ORG, xeroTenantId: PEST });
  });

  it('reads every company’s when none is chosen', async () => {
    const db = database();
    await reportsOver(db).transactions(office, { from: '2026-11-01', to: TODAY });
    expect(db.invoice.aggregate.mock.calls[0][0].where).not.toHaveProperty('xeroTenantId');
    expect(db.invoicePayment.aggregate.mock.calls[0][0].where).not.toHaveProperty('invoice');
  });
});

describe('who may read them', () => {
  it('is anybody who reads invoices, and nothing more', () => {
    expect(Reflect.getMetadata(PERMISSIONS_METADATA_KEY, InvoiceReportsController)).toEqual(['invoices:read']);
  });
});

describe("the lists' date filters", () => {
  const listDb = () => ({
    invoice: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: {}, _max: { syncedAt: null } }),
    },
    invoicePayment: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: {} }),
    },
    invoiceSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    jobberConnection: { findUnique: jest.fn().mockResolvedValue(null) },
    // The companies' books to filter by (2026-11-10): none here.
    xeroOrganisation: { findMany: jest.fn().mockResolvedValue([]) },
  });

  it('lists the invoices issued within the days chosen', async () => {
    const db = listDb();
    await new InvoicesService(db as never).list(office, { issuedFrom: '2026-11-01', issuedTo: TODAY });
    expect(db.invoice.findMany.mock.calls[0][0].where.AND).toContainEqual({ issuedOn: { gte: day('2026-11-01'), lte: day(TODAY) } });
    // The Overview still counts the whole office.
    expect(db.invoice.groupBy.mock.calls[0][0].where).toEqual({ organizationId: ORG });
  });

  it('lists the payments made within the days chosen, either end alone too', async () => {
    const db = listDb();
    await new InvoicesService(db as never).payments(office, { paidFrom: '2026-11-01' });
    expect(db.invoicePayment.findMany.mock.calls[0][0].where).toMatchObject({ paidOn: { gte: day('2026-11-01') } });
  });
});
