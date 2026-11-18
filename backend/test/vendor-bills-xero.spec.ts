import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { MACHINE_FORBIDDEN_PERMISSIONS } from '@texasrenters/shared';

import { SaveXeroBillSettingsDto, VendorBillsXeroController } from '../src/admin/vendor-bills-xero.controller';
import { VendorBillsXeroService } from '../src/admin/vendor-bills-xero.service';
import { PERMISSIONS_METADATA_KEY, type AuthenticatedUser } from '../src/common/auth';
import { ApplicationError } from '../src/common/errors';
import { xeroBillFrom } from '../src/integrations/xero/xero-bill';

/**
 * Vendor bills to Xero, phase 7 (2026-11-19). Every id, name, account and
 * amount here is invented, and no test reaches Xero: the client below answers
 * as Xero would and keeps what it was asked. The database keeps the bill's
 * Xero row and the contact links the way the service reads and writes them.
 */

const ORG = 'a0000000-0000-4000-8000-000000000001';
const OTHER_ORG = 'a0000000-0000-4000-8000-000000000002';
const id = (n: number) => `a0000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`;
const TENANT = 'tenant-homes';
const ORDER = id(41);
const BILL = id(61);
const VENDOR = id(21);
const PURCHASES = 'acct-purchases';
const INVENTORY = 'acct-inventory';
const CHECKING = 'acct-checking';
const SALES = 'acct-sales';

const person = (n: number, displayName: string, permissions: string[], organizationId = ORG): AuthenticatedUser =>
  ({ id: id(800 + n), authUserId: `auth-${n}`, organizationId, displayName, roles: [UserRole.INSPECTION_SUPERVISOR], permissions, mustChangePassword: false, principalType: 'USER' }) as AuthenticatedUser;
const clerk = person(1, 'Sample Accounts', ['purchasing:request', 'purchasing:bills']);
const requester = person(2, 'Sample Requester', ['purchasing:request']);
const admin = person(3, 'Sample Admin', ['integrations:read', 'integrations:manage']);
const outsider = person(4, 'Other Office', ['purchasing:request', 'purchasing:bills', 'integrations:manage'], OTHER_ORG);

type Row = Record<string, unknown>;
const ACCOUNTS = [
  { accountId: PURCHASES, code: '500', name: 'Purchases', type: 'DIRECTCOSTS', class: 'EXPENSE', status: 'ACTIVE', takesPayments: false },
  { accountId: INVENTORY, code: '630', name: 'Inventory', type: 'INVENTORY', class: 'ASSET', status: 'ACTIVE', takesPayments: false },
  { accountId: CHECKING, code: null, name: 'Business Checking', type: 'BANK', class: 'ASSET', status: 'ACTIVE', takesPayments: true },
  { accountId: SALES, code: '200', name: 'Sales', type: 'REVENUE', class: 'REVENUE', status: 'ACTIVE', takesPayments: false },
  { accountId: 'acct-old', code: '501', name: 'Old purchases', type: 'EXPENSE', class: 'EXPENSE', status: 'ARCHIVED', takesPayments: false },
];

function harness(over: { bill?: Row; order?: Row; settings?: Row | null; connection?: Row; organisation?: Row } = {}) {
  const settings: { row: Row | null } = { row: over.settings === undefined ? { purchasesAccountId: PURCHASES, paymentAccounts: { CHECK: CHECKING } } : over.settings };
  const sync: { row: Row | null } = { row: null };
  const links: Row[] = [];
  const audits: Row[] = [];
  const bill: Row = {
    id: BILL,
    billNumber: 'INV-20931',
    billDate: new Date('2026-11-19T00:00:00.000Z'),
    totalCents: 20005,
    status: 'APPROVED',
    paidOn: null,
    paymentMethod: null,
    paymentReference: null,
    lines: [
      { quantity: 24, unitPriceCents: 185, orderLine: { position: 1, item: { code: 'PRT-0001', name: 'Battery, 9 V' } } },
      { quantity: 36, unitPriceCents: 390, orderLine: { position: 0, item: { code: 'FLT-0003', name: 'Filter 20x25x1' } } },
    ],
    ...over.bill,
  };
  const organisation = { name: 'Example Home Services LLC', status: 'CONNECTED', organisation: { shortCode: '!abc12' }, accounts: ACCOUNTS, ...over.organisation };
  const order = { id: ORDER, organizationId: ORG, number: 'PO-0009', xeroTenantId: TENANT, vendor: { id: VENDOR, name: 'Hill Country Supply' }, ...over.order };
  const whole = () => ({ ...order, xeroOrganisation: order.xeroTenantId ? { ...organisation, billSettings: settings.row } : null, bill: { ...bill, inXero: sync.row ? { ...sync.row } : null } });
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([field, value]) => {
      if (field === 'OR') return (value as Row[]).some((part) => matches(row, part));
      if (value !== null && typeof value === 'object' && !(value instanceof Date)) return 'lt' in value ? (row[field] as Date) < (value as { lt: Date }).lt : true;
      return (row[field] ?? null) === value;
    });

  const prisma = {
    purchaseOrder: { findFirst: jest.fn(async ({ where }: { where: Row }) => (where.id === ORDER && where.organizationId === ORG ? whole() : null)) },
    xeroConnection: { findUnique: jest.fn(async ({ where }: { where: Row }) => (where.organizationId === ORG ? { status: 'CONNECTED', scopes: ['accounting.contacts', 'accounting.invoices'], ...over.connection } : null)) },
    xeroOrganisation: {
      findUnique: jest.fn(async ({ where }: { where: { organizationId_xeroTenantId: Row } }) =>
        where.organizationId_xeroTenantId.organizationId === ORG && where.organizationId_xeroTenantId.xeroTenantId === TENANT ? { accounts: ACCOUNTS, billSettings: settings.row } : null,
      ),
    },
    xeroBillSettings: { upsert: jest.fn(({ create }: { create: Row }) => (settings.row = { purchasesAccountId: create.purchasesAccountId, paymentAccounts: create.paymentAccounts })) },
    vendorBillXero: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        if (sync.row) throw Object.assign(new Error('taken'), { code: 'P2002', name: 'PrismaClientKnownRequestError' });
        sync.row = { xeroInvoiceId: null, problem: null, sentById: null, sentByName: null, sentAt: null, attemptedAt: new Date(), paymentStatus: null, xeroPaymentId: null, paymentProblem: null, paymentSentByName: null, paymentSentAt: null, paymentAttemptedAt: null, ...data };
        return sync.row;
      }),
      update: jest.fn(({ data }: { data: Row }) => Object.assign(sync.row!, data)),
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        if (!sync.row || !matches(sync.row, where)) return { count: 0 };
        Object.assign(sync.row, data);
        return { count: 1 };
      }),
    },
    xeroContactLink: {
      findMany: jest.fn(async () => links),
      createMany: jest.fn(async ({ data }: { data: Row[] }) => links.push(...data)),
    },
    auditLog: { create: jest.fn(({ data }: { data: Row }) => audits.push(data)) },
    $transaction: jest.fn(async (work: unknown[]) => Promise.all(work)),
  };

  /** What Xero holds: the bills made, by id, and the payments on each. */
  const xero = { bills: [] as Row[], payments: [] as Row[], status: 'DRAFT' as string, refuse: null as string | null, drop: false };
  const client = {
    post: jest.fn(async (_org: string, _tenant: string, path: string, body: { Contacts: { Name: string }[] }) => {
      if (path.startsWith('/Contacts')) return { Contacts: body.Contacts.map((contact, index) => ({ ContactID: `contact-${index + 1}`, Name: contact.Name, StatusAttributeString: 'OK' })) };
      throw new Error(`unexpected POST ${path}`);
    }),
    put: jest.fn(async (_org: string, _tenant: string, path: string, body: { Invoices?: Row[]; Payments?: Row[] }) => {
      if (path.startsWith('/Invoices')) {
        if (xero.refuse) return { Invoices: [{ StatusAttributeString: 'ERROR', ValidationErrors: [{ Message: xero.refuse }] }] };
        const made = { ...body.Invoices![0]!, InvoiceID: `xero-bill-${xero.bills.length + 1}` };
        xero.bills.push(made);
        // The answer is lost on the way back: Xero has the bill, the console does not know.
        if (xero.drop) throw new ApplicationError(502, 'XERO_UNREACHABLE', 'Xero did not answer in time.');
        return { Invoices: [{ InvoiceID: made.InvoiceID, StatusAttributeString: 'OK' }] };
      }
      if (path.startsWith('/Payments')) {
        const made = { ...body.Payments![0]!, PaymentID: `xero-payment-${xero.payments.length + 1}` };
        xero.payments.push(made);
        if (xero.drop) throw new ApplicationError(502, 'XERO_UNREACHABLE', 'Xero did not answer in time.');
        return { Payments: [{ PaymentID: made.PaymentID, StatusAttributeString: 'OK' }] };
      }
      throw new Error(`unexpected PUT ${path}`);
    }),
    get: jest.fn(async (_org: string, _tenant: string, path: string) => {
      const paid = xero.payments.map((payment) => ({ PaymentID: payment.PaymentID, Amount: payment.Amount }));
      const due = 200.05 - xero.payments.reduce((sum, payment) => sum + (payment.Amount as number), 0);
      return { Invoices: xero.bills.filter((made) => !path.startsWith('/Invoices/') || path.endsWith(String(made.InvoiceID))).map((made) => ({ InvoiceID: made.InvoiceID, Type: 'ACCPAY', Url: made.Url, Status: xero.status, AmountDue: due, Payments: paid })) };
    }),
  };
  const service = new VendorBillsXeroService(prisma as never, client as never);
  return { service, prisma, client, xero, sync, bill, links, audits, settings };
}
const paid = { status: 'PAID', paidOn: new Date('2026-11-24T00:00:00.000Z'), paymentMethod: 'CHECK', paymentReference: 'Check 1042' };
const calls = (client: { put: jest.Mock; get: jest.Mock; post: jest.Mock }) => client.put.mock.calls.length + client.get.mock.calls.length + client.post.mock.calls.length;

describe('the bill as Xero is sent it', () => {
  it('is a draft bill under the vendor, each line to the purchases account, and adds up to the vendor\'s total', () => {
    const body = xeroBillFrom(
      { billNumber: 'INV-20931', billDate: new Date('2026-11-19T00:00:00.000Z'), totalCents: 20005, lines: [{ code: 'FLT-0003', name: 'Filter 20x25x1', quantity: 36, unitPriceCents: 390 }, { code: 'PRT-0001', name: 'Battery, 9 V', quantity: 24, unitPriceCents: 185 }] },
      { contactId: 'contact-1', accountCode: '500', url: 'https://console.example/purchasing/orders/1' },
    );
    expect(body).toEqual({
      Type: 'ACCPAY',
      Contact: { ContactID: 'contact-1' },
      Date: '2026-11-19',
      InvoiceNumber: 'INV-20931',
      Status: 'DRAFT',
      LineAmountTypes: 'NoTax',
      Url: 'https://console.example/purchasing/orders/1',
      LineItems: [
        { Description: 'FLT-0003 Filter 20x25x1', Quantity: 36, UnitAmount: 3.9, AccountCode: '500' },
        { Description: 'PRT-0001 Battery, 9 V', Quantity: 24, UnitAmount: 1.85, AccountCode: '500' },
        // $184.80 of goods on a bill of $200.05: the 8.25% sales tax.
        { Description: 'Sales tax and other charges', Quantity: 1, UnitAmount: 15.25, AccountCode: '500' },
      ],
    });
    // A new bill, never a change to one.
    expect(JSON.stringify(body)).not.toContain('InvoiceID');
    const cents = body.LineItems.reduce((sum, line) => sum + Math.round(line.Quantity * line.UnitAmount * 100), 0);
    expect(cents).toBe(20005);
  });

  it('has no extra line when the lines are the total, and a discount line when they come to more', () => {
    const lines = [{ code: 'FLT-0003', name: 'Filter', quantity: 10, unitPriceCents: 400 }];
    const context = { contactId: 'c', accountCode: '500', url: 'u' };
    expect(xeroBillFrom({ billNumber: 'A', billDate: new Date('2026-11-19T00:00:00.000Z'), totalCents: 4000, lines }, context).LineItems).toHaveLength(1);
    expect(xeroBillFrom({ billNumber: 'A', billDate: new Date('2026-11-19T00:00:00.000Z'), totalCents: 3800, lines }, context).LineItems[1]).toEqual({ Description: 'Discount', Quantity: 1, UnitAmount: -2, AccountCode: '500' });
  });
});

describe('sending a bill', () => {
  it('makes the vendor a contact, then the bill as a draft, in two calls, and keeps Xero\'s id with who sent it', async () => {
    const { service, client, xero, sync, links, audits } = harness();
    const before = await service.standing(clerk, ORDER);
    expect(before).toMatchObject({ company: { tenantId: TENANT, name: 'Example Home Services LLC' }, status: 'NOT_SENT', waitsOn: null, can: { send: true, sendPayment: false } });
    expect(calls(client)).toBe(0);

    const after = await service.send(clerk, ORDER);
    expect(calls(client)).toBe(2);
    expect(links).toEqual([expect.objectContaining({ clientKey: `vendor:${VENDOR}`, xeroContactId: 'contact-1', name: 'Hill Country Supply', xeroTenantId: TENANT })]);
    expect(client.put).toHaveBeenCalledWith(ORG, TENANT, '/Invoices?summarizeErrors=false', expect.anything(), expect.anything(), expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(xero.bills).toHaveLength(1);
    // In the order's own order, whatever order the database gave them in.
    expect(xero.bills[0]).toMatchObject({ Type: 'ACCPAY', Status: 'DRAFT', Contact: { ContactID: 'contact-1' }, InvoiceNumber: 'INV-20931', LineItems: [expect.objectContaining({ Description: 'FLT-0003 Filter 20x25x1' }), expect.objectContaining({ Description: 'PRT-0001 Battery, 9 V' }), expect.anything()] });
    expect(String(xero.bills[0]!.Url)).toMatch(new RegExp(`/purchasing/orders/${ORDER}$`));
    expect(sync.row).toMatchObject({ status: 'SENT', xeroInvoiceId: 'xero-bill-1', sentByName: 'Sample Accounts', problem: null });
    expect(after).toMatchObject({ status: 'SENT', sentBy: 'Sample Accounts', problem: null, can: { send: false } });
    expect(after.url).toContain('AccountsPayable');
    expect(after.url).toContain(encodeURIComponent('!abc12'));
    expect(audits).toEqual([expect.objectContaining({ action: 'VENDOR_BILL_SENT_TO_XERO', actorUserId: clerk.id, entityType: 'PurchaseOrder', entityId: ORDER, metadata: expect.objectContaining({ number: 'PO-0009', xeroInvoiceId: 'xero-bill-1', totalCents: 20005, account: '500' }) })]);
  });

  it('goes once: pressed again it calls nothing and answers with where it stands', async () => {
    const { service, client, xero } = harness();
    await service.send(clerk, ORDER);
    const spent = calls(client);
    await expect(service.send(clerk, ORDER)).resolves.toMatchObject({ status: 'SENT' });
    expect(calls(client)).toBe(spent);
    expect(xero.bills).toHaveLength(1);
  });

  it('is one call for a vendor that is a contact already', async () => {
    const { service, client, links } = harness();
    links.push({ clientKey: `vendor:${VENDOR}`, xeroContactId: 'contact-9' });
    await service.send(clerk, ORDER);
    expect(calls(client)).toBe(1);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('says what it waits on, and calls nothing: not approved, no company, not connected, read-only, no account', async () => {
    const waits = async (over: Parameters<typeof harness>[0], words: RegExp) => {
      const { service, client } = harness(over);
      expect((await service.standing(clerk, ORDER)).waitsOn).toMatch(words);
      expect((await service.standing(clerk, ORDER)).can.send).toBe(false);
      await expect(service.send(clerk, ORDER)).rejects.toMatchObject({ status: 409, code: 'XERO_BILL_NOT_READY' });
      expect(calls(client)).toBe(0);
    };
    await waits({ bill: { status: 'MATCHED' } }, /Approve the bill first/);
    await waits({ bill: { status: 'HELD' } }, /Approve the bill first/);
    await waits({ order: { xeroTenantId: null } }, /names no company/);
    await waits({ organisation: { status: 'DISCONNECTED' } }, /is not connected to Xero/);
    await waits({ connection: { status: 'REAUTHORIZATION_REQUIRED' } }, /is not connected to Xero/);
    await waits({ connection: { scopes: ['accounting.settings.read'] } }, /may only read/);
    await waits({ settings: null }, /Choose the account Example Home Services LLC's bills are booked to/);
    // An account that has since been archived in Xero, or one a bill cannot be booked to.
    await waits({ settings: { purchasesAccountId: 'acct-old', paymentAccounts: {} } }, /Choose the account/);
    await waits({ settings: { purchasesAccountId: SALES, paymentAccounts: {} } }, /Choose the account/);
    await waits({ bill: { totalCents: 0 } }, /A bill of nothing/);
  });

  it('keeps what Xero objected to, and goes when pressed again once it is put right', async () => {
    const { service, xero, sync, audits } = harness();
    xero.refuse = 'Account code 500 is not a valid code for this document.';
    await expect(service.send(clerk, ORDER)).rejects.toMatchObject({ status: 422, message: 'Xero refused it: Account code 500 is not a valid code for this document.' });
    expect(sync.row).toMatchObject({ status: 'FAILED', xeroInvoiceId: null, problem: 'Xero refused it: Account code 500 is not a valid code for this document.' });
    expect(await service.standing(clerk, ORDER)).toMatchObject({ status: 'FAILED', problem: expect.stringContaining('Account code 500'), can: { send: true } });
    expect(audits).toEqual([]);

    xero.refuse = null;
    await expect(service.send(clerk, ORDER)).resolves.toMatchObject({ status: 'SENT', problem: null });
    expect(xero.bills).toHaveLength(1);
  });

  it('never makes it twice: after a lost answer the next press finds the bill in Xero by its link and keeps it', async () => {
    const { service, client, xero, sync } = harness();
    xero.drop = true;
    await expect(service.send(clerk, ORDER)).rejects.toMatchObject({ code: 'XERO_UNREACHABLE' });
    expect(xero.bills).toHaveLength(1);
    expect(sync.row).toMatchObject({ status: 'FAILED', xeroInvoiceId: null });

    xero.drop = false;
    client.put.mockClear();
    await expect(service.send(clerk, ORDER)).resolves.toMatchObject({ status: 'SENT' });
    expect(client.put).not.toHaveBeenCalled();
    expect(client.get).toHaveBeenCalledWith(ORG, TENANT, expect.stringMatching(/^\/Invoices\?ContactIDs=contact-1&where=Date%3D%3DDateTime\(2026%2C11%2C19\)/), expect.anything());
    expect(xero.bills).toHaveLength(1);
    expect(sync.row).toMatchObject({ status: 'SENT', xeroInvoiceId: 'xero-bill-1' });
  });

  it('lets one press at a time have it', async () => {
    const { service, sync, client } = harness();
    // Somebody's press is under way: a row a moment old, still pending.
    sync.row = { billId: BILL, organizationId: ORG, xeroTenantId: TENANT, status: 'PENDING', xeroInvoiceId: null, problem: null, attemptedAt: new Date(), paymentStatus: null };
    await expect(service.send(clerk, ORDER)).rejects.toMatchObject({ status: 409, code: 'XERO_BILL_BEING_SENT' });
    expect(calls(client)).toBe(0);
    // Gone quiet for longer than a press takes: the next one may have it.
    sync.row.attemptedAt = new Date(Date.now() - 5 * 60_000);
    await expect(service.send(clerk, ORDER)).resolves.toMatchObject({ status: 'SENT' });
  });

  it('is pressed only by somebody who keeps the bills, of this office', async () => {
    const { service, client } = harness();
    expect((await service.standing(requester, ORDER)).can).toEqual({ send: false, sendPayment: false });
    await expect(service.standing(outsider, ORDER)).rejects.toMatchObject({ status: 404 });
    await expect(service.send(outsider, ORDER)).rejects.toMatchObject({ status: 404 });
    await expect(service.send({ ...clerk, principalType: 'API_KEY' } as AuthenticatedUser, ORDER)).rejects.toMatchObject({ status: 403 });
    expect(calls(client)).toBe(0);
  });
});

describe('sending the payment', () => {
  const sent = async (over: Parameters<typeof harness>[0] = { bill: paid }) => {
    const made = harness(over);
    await made.service.send(clerk, ORDER);
    made.client.get.mockClear();
    made.client.put.mockClear();
    made.audits.length = 0;
    return made;
  };

  it('waits for the bill to be approved in Xero: nothing is paid against a draft', async () => {
    const { service, xero, sync, client } = await sent();
    expect(await service.standing(clerk, ORDER)).toMatchObject({ paymentWaitsOn: null, can: { sendPayment: true } });
    await expect(service.sendPayment(clerk, ORDER)).rejects.toMatchObject({ status: 409, code: 'XERO_BILL_STILL_A_DRAFT' });
    expect(client.put).not.toHaveBeenCalled();
    expect(xero.payments).toEqual([]);
    expect(sync.row).toMatchObject({ paymentStatus: 'FAILED', paymentProblem: expect.stringContaining('still a draft') });
  });

  it('reads the bill, then records the payment against it, from the account for how it was paid: two calls', async () => {
    const { service, xero, sync, client, audits } = await sent();
    xero.status = 'AUTHORISED';
    const after = await service.sendPayment(clerk, ORDER);

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.put).toHaveBeenCalledTimes(1);
    expect(xero.payments).toEqual([{ Invoice: { InvoiceID: 'xero-bill-1' }, Account: { AccountID: CHECKING }, Date: '2026-11-24', Amount: 200.05, Reference: 'Check 1042', PaymentID: 'xero-payment-1' }]);
    expect(sync.row).toMatchObject({ paymentStatus: 'SENT', xeroPaymentId: 'xero-payment-1', paymentSentByName: 'Sample Accounts' });
    expect(after).toMatchObject({ payment: { status: 'SENT', sentBy: 'Sample Accounts', problem: null }, can: { sendPayment: false } });
    expect(audits).toEqual([expect.objectContaining({ action: 'VENDOR_BILL_PAYMENT_SENT_TO_XERO', metadata: expect.objectContaining({ xeroPaymentId: 'xero-payment-1', amountCents: 20005, method: 'CHECK' }) })]);

    // Once: pressed again it calls nothing.
    const spent = calls(client);
    await service.sendPayment(clerk, ORDER);
    expect(calls(client)).toBe(spent);
  });

  it('never pays twice: after a lost answer the next press finds the payment on the bill and keeps it', async () => {
    const { service, xero, sync, client } = await sent();
    xero.status = 'AUTHORISED';
    xero.drop = true;
    await expect(service.sendPayment(clerk, ORDER)).rejects.toMatchObject({ code: 'XERO_UNREACHABLE' });
    expect(xero.payments).toHaveLength(1);

    xero.drop = false;
    xero.status = 'PAID';
    client.put.mockClear();
    await expect(service.sendPayment(clerk, ORDER)).resolves.toMatchObject({ payment: { status: 'SENT' } });
    expect(client.put).not.toHaveBeenCalled();
    expect(xero.payments).toHaveLength(1);
    expect(sync.row).toMatchObject({ xeroPaymentId: 'xero-payment-1' });
  });

  it('sends nothing for a bill Xero has as paid, voided, or with less left to pay than was recorded here', async () => {
    for (const [status, code] of [['PAID', 'XERO_BILL_ALREADY_PAID'], ['VOIDED', 'XERO_BILL_GONE'], ['DELETED', 'XERO_BILL_GONE']] as const) {
      const { service, xero } = await sent();
      xero.status = status;
      await expect(service.sendPayment(clerk, ORDER)).rejects.toMatchObject({ status: 409, code });
      expect(xero.payments).toEqual([]);
    }
    const { service, xero } = await sent();
    xero.status = 'AUTHORISED';
    // The office in Xero already paid $50 of it by hand.
    xero.payments.push({ PaymentID: 'by-hand', Amount: 50 });
    await expect(service.sendPayment(clerk, ORDER)).rejects.toMatchObject({ code: 'XERO_BILL_AMOUNT_DIFFERS', message: 'Xero has $150.05 still to pay on this bill, less than the $200.05 recorded here. Nothing was sent.' });
    expect(xero.payments).toHaveLength(1);
  });

  it('says what it waits on, and calls nothing: the bill not sent, not paid here, or no account for how it was paid', async () => {
    const unsent = harness({ bill: paid });
    expect((await unsent.service.standing(clerk, ORDER)).can.sendPayment).toBe(false);
    await expect(unsent.service.sendPayment(clerk, ORDER)).rejects.toMatchObject({ code: 'XERO_BILL_PAYMENT_NOT_READY', message: 'Send the bill to Xero first.' });

    const unpaid = await sent({});
    expect(await unpaid.service.standing(clerk, ORDER)).toMatchObject({ paymentWaitsOn: 'Record the payment here first.', can: { sendPayment: false } });
    await expect(unpaid.service.sendPayment(clerk, ORDER)).rejects.toMatchObject({ code: 'XERO_BILL_PAYMENT_NOT_READY' });

    const card = await sent({ bill: { ...paid, paymentMethod: 'CARD' } });
    expect((await card.service.standing(clerk, ORDER)).paymentWaitsOn).toBe('Choose the account card payments come out of, on the Xero page.');
    await expect(card.service.sendPayment(clerk, ORDER)).rejects.toMatchObject({ code: 'XERO_BILL_PAYMENT_NOT_READY' });
    for (const made of [unsent, unpaid, card]) expect(made.client.put.mock.calls.filter((call) => String(call[2]).startsWith('/Payments'))).toEqual([]);
  });
});

describe('a company\'s choices', () => {
  it('offers the accounts a bill can be booked to and paid from, as the console last read Xero', async () => {
    const { service, client } = harness({ settings: null });
    const view = await service.settings(admin, TENANT);
    expect(view.settings).toEqual({ purchasesAccountId: null, paymentAccounts: {} });
    expect(view.purchaseAccounts.map((account) => account.name)).toEqual(['Purchases', 'Inventory']);
    expect(view.bankAccounts).toEqual([{ accountId: CHECKING, code: null, name: 'Business Checking' }]);
    expect(calls(client)).toBe(0);
  });

  it('keeps them, with who changed what', async () => {
    const { service, audits } = harness({ settings: null });
    const saved = await service.saveSettings(admin, TENANT, { purchasesAccountId: INVENTORY, paymentAccounts: { CHECK: CHECKING, ACH: CHECKING } });
    expect(saved.settings).toEqual({ purchasesAccountId: INVENTORY, paymentAccounts: { CHECK: CHECKING, ACH: CHECKING } });
    expect(audits).toEqual([expect.objectContaining({ action: 'XERO_BILL_SETTINGS_CHANGED', actorUserId: admin.id, metadata: expect.objectContaining({ tenantId: TENANT, after: { purchasesAccountId: INVENTORY, paymentAccounts: { CHECK: CHECKING, ACH: CHECKING } } }) })]);
  });

  it('refuses an account a bill cannot be booked to, one that takes no payments, and another office\'s company', async () => {
    const { service } = harness();
    await expect(service.saveSettings(admin, TENANT, { purchasesAccountId: SALES, paymentAccounts: {} })).rejects.toMatchObject({ status: 422 });
    await expect(service.saveSettings(admin, TENANT, { purchasesAccountId: CHECKING, paymentAccounts: {} })).rejects.toMatchObject({ status: 422 });
    await expect(service.saveSettings(admin, TENANT, { purchasesAccountId: PURCHASES, paymentAccounts: { CASH: PURCHASES } })).rejects.toMatchObject({ status: 422 });
    await expect(service.saveSettings(outsider, TENANT, { purchasesAccountId: PURCHASES, paymentAccounts: {} })).rejects.toMatchObject({ status: 404 });
    await expect(service.settings(outsider, TENANT)).rejects.toMatchObject({ status: 404 });
  });
});

describe('what the API accepts', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (value: unknown) => pipe.transform(value, { type: 'body', metatype: SaveXeroBillSettingsDto });

  it('takes the choices the page sends, and refuses a way of paying or a field it does not know', async () => {
    await expect(check({ purchasesAccountId: PURCHASES, paymentAccounts: { CHECK: CHECKING } })).resolves.toMatchObject({ purchasesAccountId: PURCHASES });
    await expect(check({ purchasesAccountId: null, paymentAccounts: {} })).resolves.toBeDefined();
    await expect(check({ purchasesAccountId: PURCHASES, paymentAccounts: { BARTER: CHECKING } })).rejects.toBeDefined();
    await expect(check({ purchasesAccountId: PURCHASES, paymentAccounts: {}, sendingEnabled: true })).rejects.toBeDefined();
  });

  it('keeps sending behind the bills permission, which no API key may hold, and the choices behind the Xero page\'s', () => {
    const needs = (method: keyof VendorBillsXeroController) => Reflect.getMetadata(PERMISSIONS_METADATA_KEY, VendorBillsXeroController.prototype[method]) as string[];
    expect(needs('standing')).toEqual(['purchasing:request']);
    expect(needs('send')).toEqual(['purchasing:request', 'purchasing:bills']);
    expect(needs('sendPayment')).toEqual(['purchasing:request', 'purchasing:bills']);
    expect(needs('settings')).toEqual(['integrations:read']);
    expect(needs('saveSettings')).toEqual(['integrations:manage']);
    expect(MACHINE_FORBIDDEN_PERMISSIONS).toContain('purchasing:bills');
  });
});
