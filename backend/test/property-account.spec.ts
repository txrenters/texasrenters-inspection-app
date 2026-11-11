import { UserRole, type StatementView } from '@texasrenters/shared';
import { Prisma } from '@prisma/client';

import { PropertyAccountService } from '../src/admin/property-account.service';
import { statementEmail } from '../src/admin/statement-email';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * A property's account and its statement (2026-11-10, phase 3 of the invoice
 * gap review), as Jobber's client page keeps them. Today is 2026-11-20 in
 * Texas. Names and addresses invented.
 */

const ORG = '70000000-0000-4000-8000-000000000001';
const PROPERTY = '70000000-0000-4000-8000-000000000010';
const ME = '70000000-0000-4000-8000-000000000030';
const office: AuthenticatedUser = {
  id: ME,
  authUserId: 'auth-office',
  organizationId: ORG,
  displayName: 'Ada Lane',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: ['invoices:read', 'invoices:manage'],
  mustChangePassword: false,
  principalType: 'USER',
};

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date('2026-11-20T18:00:00.000Z'),
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'nextTick', 'setImmediate', 'queueMicrotask'],
  });
});
afterEach(() => jest.useRealTimers());

const invoice = (over: Record<string, unknown>) => ({
  id: 'inv-1',
  number: '8439',
  status: 'PAID',
  clientName: '100 Example Way',
  clientEmails: ['owner@example.com'],
  issuedOn: day('2026-09-01'),
  dueOn: day('2026-10-01'),
  createdAt: new Date('2026-09-01T15:00:00.000Z'),
  updatedAt: new Date('2026-09-01T15:00:00.000Z'),
  totalCents: 7500,
  balanceCents: 0,
  payments: [],
  ...over,
});

/** A paid invoice, one paid in part with a refund, a deposit Jobber took, and a bad debt. */
const ACCOUNT = [
  invoice({ payments: [{ id: 'pay-1', paidOn: day('2026-09-30'), amountCents: 7500, method: 'PROPERTYWARE_LEDGER', reference: 'PW-1' }] }),
  invoice({
    id: 'inv-2',
    number: '8440',
    status: 'AWAITING_PAYMENT',
    issuedOn: day('2026-10-15'),
    dueOn: day('2026-11-14'),
    totalCents: 3999,
    balanceCents: 2999,
    payments: [
      // Paid the day it was issued: still after it.
      { id: 'pay-2', paidOn: day('2026-10-15'), amountCents: 2000, method: 'CHECK', reference: '1042' },
      { id: 'pay-3', paidOn: day('2026-10-20'), amountCents: -1000, method: 'CHECK', reference: null },
    ],
  }),
  // $10 of it was a deposit taken in Jobber, which is no payment here.
  invoice({ id: 'inv-3', number: '8441', status: 'AWAITING_PAYMENT', issuedOn: day('2026-11-02'), dueOn: day('2026-12-02'), totalCents: 2500, balanceCents: 1500 }),
  invoice({ id: 'inv-4', number: '8442', status: 'BAD_DEBT', issuedOn: day('2026-08-01'), totalCents: 4000, balanceCents: 4000, updatedAt: new Date('2026-11-05T17:00:00.000Z') }),
];

function database(invoices: unknown[] = ACCOUNT) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    invoiceDelivery: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'delivery-1' }),
    },
    invoiceSettings: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  return {
    tx,
    propertywareBuilding: {
      findFirst: jest.fn().mockResolvedValue({ id: PROPERTY, name: 'Example', addressLine1: '100 Example Way', city: 'Sampletown' }),
    },
    invoice: { findMany: jest.fn().mockResolvedValue(invoices) },
    invoiceSettings: {
      findUnique: jest.fn(async ({ select }: { select: Record<string, boolean> }) =>
        'invoicingTakenOverAt' in select ? { invoicingTakenOverAt: new Date('2026-11-10T15:00:00.000Z') } : null,
      ),
    },
    invoiceDelivery: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
  };
}
const mailer = () => ({ sendInvoice: jest.fn().mockResolvedValue({ status: 'SENT' }) });
const over = (db: ReturnType<typeof database>, mail = mailer()) => new PropertyAccountService(db as never, mail as never);

describe("a property's billing history", () => {
  it('lists every invoice and payment newest first, with the balance after each, ending where the invoices say', async () => {
    const db = database();
    const account = await over(db).account(office, PROPERTY);

    expect(account.entries.map((entry) => [entry.kind, entry.on, entry.amountCents, entry.balanceCents])).toEqual([
      ['WRITE_OFF', '2026-11-05', -4000, 4499],
      ['ADJUSTMENT', '2026-11-02', -1000, 8499],
      ['INVOICE', '2026-11-02', 2500, 9499],
      ['REFUND', '2026-10-20', 1000, 6999],
      ['PAYMENT', '2026-10-15', -2000, 5999],
      ['INVOICE', '2026-10-15', 3999, 7999],
      ['PAYMENT', '2026-09-30', -7500, 4000],
      ['INVOICE', '2026-09-01', 7500, 11500],
      ['INVOICE', '2026-08-01', 4000, 4000],
    ]);
    // The two still owed: $29.99 and $15.00. The bad debt is written off.
    expect(account.balanceCents).toBe(4499);
    expect(account).toMatchObject({ invoicedCents: 17999, paidCents: 8500, clientName: '100 Example Way', statementTo: ['owner@example.com'] });
    expect(account.entries.find((entry) => entry.key === 'invoice:inv-2')).toMatchObject({ status: 'PAST_DUE', invoiceNumber: '8440' });
    expect(db.invoice.findMany.mock.calls[0][0].where).toEqual({
      organizationId: ORG,
      // Not the books read back from Xero (2026-11-12): out of sight until the pages show them.
      origin: { not: 'XERO' },
      propertywareBuildingId: PROPERTY,
      status: { notIn: ['DRAFT', 'VOIDED'] },
    });
  });

  it("is only the office's own property", async () => {
    const db = database();
    db.propertywareBuilding.findFirst.mockResolvedValue(null);
    await expect(over(db).account(office, PROPERTY)).rejects.toMatchObject({ code: 'PROPERTY_NOT_FOUND' });
    expect(db.propertywareBuilding.findFirst.mock.calls[0][0].where).toEqual({ id: PROPERTY, organizationId: ORG });
  });
});

describe('a statement', () => {
  it('since the last zero balance starts after the last entry that left nothing owed', async () => {
    // September's invoice, paid in full; then November's.
    const statement = await over(database([ACCOUNT[0], ACCOUNT[2]])).statement(office, PROPERTY, { period: 'SINCE_ZERO' });
    expect(statement.entries.map((entry) => entry.key)).toEqual(['invoice:inv-3', 'adjustment:inv-3']);
    expect(statement).toMatchObject({ from: '2026-11-02', openingBalanceCents: 0, closingBalanceCents: 1500, newestFirst: true, disclaimer: null });
  });

  it('since the last zero balance is the whole account when it never stood at nothing', async () => {
    const statement = await over(database()).statement(office, PROPERTY, { period: 'SINCE_ZERO' });
    expect(statement.entries).toHaveLength(9);
    expect(statement).toMatchObject({ from: '2026-08-01', openingBalanceCents: 0, closingBalanceCents: 4499 });
  });

  it('from a day carries the balance forward', async () => {
    const statement = await over(database()).statement(office, PROPERTY, { period: 'FROM', from: '2026-10-16' });
    expect(statement.entries.map((entry) => entry.kind)).toEqual(['REFUND', 'INVOICE', 'ADJUSTMENT', 'WRITE_OFF']);
    expect(statement).toMatchObject({ from: '2026-10-16', openingBalanceCents: 5999, closingBalanceCents: 4499 });
  });

  it('needs its first day, and not a day still to come', async () => {
    await expect(over(database()).statement(office, PROPERTY, { period: 'FROM' })).rejects.toMatchObject({ code: 'STATEMENT_PERIOD_INVALID' });
    await expect(over(database()).statement(office, PROPERTY, { period: 'FROM', from: '2026-11-21' })).rejects.toMatchObject({
      code: 'STATEMENT_PERIOD_INVALID',
    });
  });

  it('is emailed on the press, one to each address, as a statement for the property', async () => {
    const db = database();
    const mail = mailer();
    await over(db, mail).sendStatement(office, PROPERTY, {
      period: 'LIFETIME',
      to: ['owner@example.com', 'manager@example.com'],
      clientRequestId: 'press-0001',
    });

    expect(db.tx.invoiceDelivery.create.mock.calls[0][0].data).toMatchObject({
      kind: 'STATEMENT',
      invoiceId: null,
      propertywareBuildingId: PROPERTY,
      recipients: ['owner@example.com', 'manager@example.com'],
      sentById: ME,
      clientRequestId: 'press-0001',
    });
    expect(mail.sendInvoice.mock.calls.map(([email]) => [email.to, email.subject])).toEqual([
      ['owner@example.com', 'Your statement from TexasRenters.com'],
      ['manager@example.com', 'Your statement from TexasRenters.com'],
    ]);
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'STATEMENT_SENT',
      entityType: 'PropertywareBuilding',
      entityId: PROPERTY,
      metadata: expect.objectContaining({ balanceCents: 4499, status: 'SENT' }),
    });
  });

  it('sends nothing twice for the same press', async () => {
    const db = database();
    db.tx.invoiceDelivery.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('taken', { code: 'P2002', clientVersion: 'test' }));
    const mail = mailer();
    await over(db, mail).sendStatement(office, PROPERTY, { period: 'LIFETIME', to: ['owner@example.com'], clientRequestId: 'press-0001' });
    expect(mail.sendInvoice).not.toHaveBeenCalled();
  });

  it('counts against the day’s invoice emails', async () => {
    const db = database();
    db.tx.invoiceDelivery.findMany.mockResolvedValue([{ recipients: Array.from({ length: 200 }, () => 'x@example.com') }]);
    const mail = mailer();
    await expect(
      over(db, mail).sendStatement(office, PROPERTY, { period: 'LIFETIME', to: ['owner@example.com'], clientRequestId: 'press-0002' }),
    ).rejects.toMatchObject({ code: 'INVOICE_EMAIL_CEILING' });
    expect(mail.sendInvoice).not.toHaveBeenCalled();
  });

  it('is not emailed before the console owns invoicing: Jobber sends them until then', async () => {
    const db = database();
    db.invoiceSettings.findUnique.mockResolvedValue(null);
    const previous = process.env.JOBBER_INVOICE_WRITES_ENABLED;
    delete process.env.JOBBER_INVOICE_WRITES_ENABLED;
    const mail = mailer();
    await expect(
      over(db, mail).sendStatement(office, PROPERTY, { period: 'LIFETIME', to: ['owner@example.com'], clientRequestId: 'press-0003' }),
    ).rejects.toMatchObject({ status: 409 });
    if (previous !== undefined) process.env.JOBBER_INVOICE_WRITES_ENABLED = previous;
    expect(mail.sendInvoice).not.toHaveBeenCalled();
  });
});

describe('the statement settings', () => {
  it('save against the settings as they were read, and say what changed', async () => {
    const db = database();
    db.tx.invoiceSettings.findUnique.mockResolvedValue({ statementNewestFirst: true, statementDisclaimer: null, statementSettingsUpdatedAt: null });
    await over(db).saveSettings(office, { newestFirst: false, disclaimer: '  Payment is due on receipt.  ', expectedUpdatedAt: null });
    expect(db.tx.invoiceSettings.upsert.mock.calls[0][0].update).toMatchObject({
      statementNewestFirst: false,
      statementDisclaimer: 'Payment is due on receipt.',
    });
    expect(db.tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'STATEMENT_SETTINGS_CHANGED',
      metadata: { changes: ['Order: newest first → oldest first', 'Statement text changed'] },
    });
  });

  it('refuse a save over somebody else’s', async () => {
    const db = database();
    db.tx.invoiceSettings.findUnique.mockResolvedValue({
      statementNewestFirst: true,
      statementDisclaimer: null,
      statementSettingsUpdatedAt: new Date('2026-11-19T15:00:00.000Z'),
    });
    await expect(over(db).saveSettings(office, { newestFirst: false, disclaimer: null, expectedUpdatedAt: null })).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('the statement email', () => {
  const view: StatementView = {
    propertyId: PROPERTY,
    clientName: '100 Example Way',
    address: null,
    period: 'FROM',
    from: '2026-10-16',
    on: '2026-11-20',
    openingBalanceCents: 5999,
    closingBalanceCents: 4499,
    entries: [
      { key: 'payment:pay-3', kind: 'REFUND', on: '2026-10-20', invoiceId: 'inv-2', invoiceNumber: '8440', paymentId: 'pay-3', amountCents: 1000, balanceCents: 6999, status: null, method: 'CHECK', reference: null },
      { key: 'invoice:inv-3', kind: 'INVOICE', on: '2026-11-02', invoiceId: 'inv-3', invoiceNumber: '8441', paymentId: null, amountCents: 2500, balanceCents: 9499, status: 'AWAITING_PAYMENT', method: null, reference: null },
    ],
    newestFirst: true,
    disclaimer: 'Payment is due <on> receipt.',
    brand: { name: 'Example Homes', addressLine1: null, addressLine2: null, phone: null, email: 'office@example.com' },
  };

  it('lists the period newest first, the balance carried forward last, and the office’s text at the foot', () => {
    const email = statementEmail(view);
    expect(email.subject).toBe('Your statement from Example Homes');
    expect(email.html).toContain('Your balance is <strong>$44.99</strong>.');
    const order = ['Invoice #8441', 'Refund', 'Balance forward'].map((text) => email.html.indexOf(text));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(email.html).toContain('Payment is due &lt;on&gt; receipt.');
  });

  it('says so when the client is in credit', () => {
    expect(statementEmail({ ...view, closingBalanceCents: -500 }).html).toContain('You have a credit of <strong>$5.00</strong>.');
  });
});
