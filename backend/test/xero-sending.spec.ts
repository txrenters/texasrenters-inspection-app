import { UserRole, type XeroAccount, type XeroSettingsValues } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { PERMISSIONS_METADATA_KEY } from '../src/common/auth';
import { XeroClient, xeroValidationMessages } from '../src/integrations/xero/xero.client';
import { XERO_SEND_SCOPES, getXeroConfig } from '../src/integrations/xero/xero.config';
import { XeroController } from '../src/integrations/xero/xero.controller';
import { XeroError } from '../src/integrations/xero/xero.errors';
import { clientKeyOf, invoiceFingerprint, xeroInvoiceFrom, type InvoiceForXero } from '../src/integrations/xero/xero-invoice';
import { MAX_INVOICES_PER_RUN, XeroSenderService } from '../src/integrations/xero/xero-sender.service';
import { remindersFrom } from '../src/integrations/xero/xero.service';

/**
 * Sending invoices to Xero (2026-11-10, phase 3 of the Xero plan): approved,
 * under each client's contact, only what changed, only while it is on, under
 * the daily ceiling. Everything invented.
 */

const ORG = '90000000-0000-4000-8000-000000000001';
const TENANT = 'tenant-1';
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

const ACCOUNTS: XeroAccount[] = [
  { accountId: 'a-400', code: '400', name: 'Service revenue', type: 'REVENUE', class: 'REVENUE', status: 'ACTIVE', takesPayments: false },
  { accountId: 'a-410', code: '410', name: 'Repair revenue', type: 'REVENUE', class: 'REVENUE', status: 'ACTIVE', takesPayments: false },
  { accountId: 'a-460', code: '460', name: 'Old revenue', type: 'REVENUE', class: 'REVENUE', status: 'ARCHIVED', takesPayments: false },
];
const SETTINGS: XeroSettingsValues = {
  sendFrom: '2026-12-01',
  salesAccountId: 'a-400',
  salesTaxType: 'NONE',
  salesAccounts: { 'filter change': 'a-410' },
  paymentAccounts: {},
};

const UPDATED = new Date('2026-12-02T15:00:00.000Z');
type Fixture = InvoiceForXero & { updatedAt: Date; xeroSync: Record<string, unknown> | null };
const invoice = (over: Partial<Fixture> = {}): Fixture => ({
  id: 'inv-1',
  number: '8440',
  subject: 'For Services Rendered',
  status: 'AWAITING_PAYMENT',
  clientName: '12 Example Lane',
  jobberClientId: 'client-1',
  jobNumber: '512',
  issuedOn: new Date('2026-12-02T00:00:00.000Z'),
  dueOn: new Date('2027-01-01T00:00:00.000Z'),
  taxCents: 0,
  discountCents: 0,
  totalCents: 17500,
  lines: [
    { position: 0, name: 'Move-out inspection', description: 'Full walk-through', quantity: 1, unitPriceCents: 15000, totalCents: 15000 },
    { position: 1, name: 'Filter change', description: null, quantity: 1, unitPriceCents: 2500, totalCents: 2500 },
  ],
  updatedAt: UPDATED,
  xeroSync: null,
  ...over,
});

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date('2026-12-02T18:00:00.000Z'),
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'nextTick', 'setImmediate', 'queueMicrotask'],
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('a console invoice, as Xero is sent it', () => {
  const plan = (over: Partial<Fixture> = {}, xeroInvoiceId: string | null = null, settings = SETTINGS) =>
    xeroInvoiceFrom(invoice(over), { settings, accounts: ACCOUNTS, contactId: 'contact-1', xeroInvoiceId });

  it('goes approved, under its client, each line to its product’s account or the default, with the office’s tax type', () => {
    expect(plan()).toEqual({
      kind: 'send',
      body: {
        Type: 'ACCREC',
        Contact: { ContactID: 'contact-1' },
        InvoiceNumber: '8440',
        Reference: 'For Services Rendered · Job #512',
        Date: '2026-12-02',
        DueDate: '2027-01-01',
        LineAmountTypes: 'Exclusive',
        Status: 'AUTHORISED',
        LineItems: [
          { Description: 'Move-out inspection\nFull walk-through', Quantity: 1, UnitAmount: 150, LineAmount: 150, AccountCode: '400', TaxType: 'NONE' },
          { Description: 'Filter change', Quantity: 1, UnitAmount: 25, LineAmount: 25, AccountCode: '410', TaxType: 'NONE' },
        ],
      },
    });
  });

  it('updates the invoice Xero already has', () => {
    const sent = plan({}, 'xero-inv-1');
    expect(sent.kind === 'send' && sent.body.InvoiceID).toBe('xero-inv-1');
  });

  it('takes a discount as a line below zero, to the default account', () => {
    const sent = plan({ discountCents: 1750, totalCents: 15750 });
    expect(sent.kind === 'send' && sent.body.LineItems.at(-1)).toEqual({
      Description: 'Discount',
      Quantity: 1,
      UnitAmount: -17.5,
      LineAmount: -17.5,
      AccountCode: '400',
      TaxType: 'NONE',
    });
  });

  it('sends a line whose total is not its quantity times its price as one of its total', () => {
    const sent = plan({
      totalCents: 1000,
      lines: [{ position: 0, name: 'Trip charge', description: null, quantity: 3, unitPriceCents: 333, totalCents: 1000 }],
    });
    expect(sent.kind === 'send' && sent.body.LineItems[0]).toEqual({
      Description: 'Trip charge (3 × $3.33)',
      Quantity: 1,
      UnitAmount: 10,
      LineAmount: 10,
      AccountCode: '400',
      TaxType: 'NONE',
    });
  });

  it.each([
    [{ taxCents: 1444, totalCents: 18944 }, 'It carries $14.44 of sales tax, and the console sends Xero none. Enter it in Xero by hand.'],
    [{ number: null }, 'It has no invoice number yet.'],
    [{ totalCents: 18000 }, 'Its lines come to $175.00 and its total is $180.00, so it is not sent. Correct it here, or enter it in Xero by hand.'],
    [{ status: 'DRAFT' }, 'It is a draft.'],
    [{ issuedOn: null }, 'It has no issue date.'],
  ])('holds back %j, saying why', (over, problem) => {
    expect(plan(over as Partial<Fixture>)).toEqual({ kind: 'problem', problem });
  });

  it('holds back a line whose chosen account Xero has archived', () => {
    expect(plan({}, null, { ...SETTINGS, salesAccounts: { 'filter change': 'a-460' } })).toEqual({
      kind: 'problem',
      problem: 'The account chosen for “Filter change” is not an active account in Xero. Choose again on the Xero page.',
    });
  });

  it('voids in Xero what was sent, and sends nothing for what never was', () => {
    expect(plan({ status: 'VOIDED' }, 'xero-inv-1')).toEqual({ kind: 'void', body: { InvoiceID: 'xero-inv-1', Status: 'VOIDED' } });
    expect(plan({ status: 'VOIDED' })).toEqual({ kind: 'problem', problem: 'It was voided before it reached Xero, so it is not sent.' });
  });

  it('is sent again only when what it says changes: not when it is paid, nor when an account is chosen anew', () => {
    const before = invoiceFingerprint(invoice());
    expect(invoiceFingerprint(invoice({ status: 'PAID' }))).toBe(before);
    expect(invoiceFingerprint(invoice({ lines: [...invoice().lines].reverse() }))).toBe(before);
    expect(invoiceFingerprint(invoice({ totalCents: 18000 }))).not.toBe(before);
    expect(invoiceFingerprint(invoice({ status: 'VOIDED' }))).not.toBe(before);
  });

  it('goes under its client: by Jobber’s id, or by name when Jobber gave none', () => {
    expect(clientKeyOf({ jobberClientId: 'client-1', clientName: 'X' })).toBe('jobber:client-1');
    expect(clientKeyOf({ jobberClientId: null, clientName: ' 12 Example LANE ' })).toBe('name:12 example lane');
  });
});

describe('the client’s writes', () => {
  it('says what Xero objected to, from the validation errors only', () => {
    expect(
      xeroValidationMessages({
        Elements: [{ ValidationErrors: [{ Message: 'Invoice # must be unique.' }] }, { ValidationErrors: [{ Message: 'Account code 999 is not valid.' }] }],
      }),
    ).toBe('Invoice # must be unique. Account code 999 is not valid.');
    expect(xeroValidationMessages({ Message: 'A validation exception occurred' })).toBeNull();
  });

  it('posts JSON with an idempotency key, counted, and turns a refusal into Xero’s words', async () => {
    process.env.XERO_API_URL = 'https://api.xero.com/api.xro/2.0';
    const prisma = {
      xeroOrganisation: {
        findUnique: jest.fn(async () => ({ status: 'CONNECTED' })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const client = new XeroClient(prisma as never, { accessToken: jest.fn(async () => 'token') } as never);
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ Invoices: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ Elements: [{ ValidationErrors: [{ Message: 'Invoice # must be unique.' }] }] }), { status: 400 }));
    const { z } = await import('zod');
    await client.post(ORG, TENANT, '/Invoices?summarizeErrors=false', { Invoices: [] }, z.object({ Invoices: z.array(z.unknown()) }), 'key-1');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.xero.com/api.xro/2.0/Invoices?summarizeErrors=false');
    expect(init).toMatchObject({ method: 'POST', body: '{"Invoices":[]}' });
    expect((init as RequestInit).headers).toMatchObject({ 'idempotency-key': 'key-1', 'xero-tenant-id': TENANT, 'content-type': 'application/json' });
    expect(prisma.xeroOrganisation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG, xeroTenantId: TENANT }) }));
    await expect(client.post(ORG, TENANT, '/Invoices', {}, z.object({}), 'key-2')).rejects.toMatchObject({
      code: 'XERO_VALIDATION',
      message: 'Xero refused it: Invoice # must be unique.',
    });
    delete process.env.XERO_API_URL;
  });

  it('asks Xero for writing contacts, invoices and payments when connecting', () => {
    expect(getXeroConfig({}).scopes).toBe(XERO_SEND_SCOPES);
    expect(XERO_SEND_SCOPES).toBe('offline_access accounting.settings.read accounting.contacts accounting.invoices accounting.payments');
  });

  it('reads whether Xero’s own reminders are on', () => {
    expect(remindersFrom({ InvoiceReminders: [{ Enabled: true }] })).toBe(true);
    expect(remindersFrom({ InvoiceReminders: [{ Enabled: false }] })).toBe(false);
    expect(remindersFrom({})).toBeNull();
  });
});

function harness(options: {
  invoices?: Fixture[];
  links?: { clientKey: string; xeroContactId: string }[];
  settingsRow?: Record<string, unknown> | null;
  connection?: Record<string, unknown> | null;
  ready?: boolean;
  candidates?: string[];
} = {}) {
  const invoices = options.invoices ?? [invoice()];
  let settingsRow =
    options.settingsRow === undefined
      ? { sendingEnabled: true, sendingChangedAt: null, lastRunAt: null, lastRunProblem: null, sendFrom: new Date('2026-12-01T00:00:00.000Z'), sendingClaimedUntil: null }
      : options.settingsRow;
  const connection =
    options.connection === undefined
      ? { status: 'CONNECTED', xeroTenantId: TENANT, scopes: XERO_SEND_SCOPES.split(' '), invoiceRemindersOn: false, accounts: ACCOUNTS }
      : options.connection;
  const syncs = new Map<string, Record<string, unknown>>();
  const prisma = {
    xeroSettings: {
      findUnique: jest.fn(async () => settingsRow),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        settingsRow = { ...settingsRow!, ...data };
        return settingsRow;
      }),
      updateMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (!settingsRow?.sendingEnabled) return { count: 0 };
        const claimed = settingsRow.sendingClaimedUntil as Date | null;
        if (claimed && claimed > new Date() && 'OR' in where) return { count: 0 };
        settingsRow = { ...settingsRow, sendingClaimedUntil: new Date(Date.now() + 15 * 60_000) };
        return { count: 1 };
      }),
    },
    xeroConnection: { findUnique: jest.fn(async () => (connection ? { status: connection.status, scopes: connection.scopes } : null)) },
    xeroOrganisation: {
      findUnique: jest.fn(async () =>
        connection ? { name: 'Example Home Services', status: 'CONNECTED', invoiceRemindersOn: connection.invoiceRemindersOn, accounts: connection.accounts } : null,
      ),
    },
    invoice: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => invoices.filter((item) => where.id.in.includes(item.id))),
      count: jest.fn(async () => 0),
    },
    xeroInvoiceSync: {
      upsert: jest.fn(async ({ where, create, update }: { where: { invoiceId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const row = syncs.has(where.invoiceId) ? { ...syncs.get(where.invoiceId), ...update } : create;
        syncs.set(where.invoiceId, row);
        return row;
      }),
      update: jest.fn(async () => ({})),
      delete: jest.fn(async () => ({})),
      count: jest.fn(async () => 0),
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async () => ({ count: 2 })),
    },
    xeroContactLink: {
      findMany: jest.fn(async ({ where }: { where: { clientKey: { in: string[] } } }) =>
        (options.links ?? []).filter((link) => where.clientKey.in.includes(link.clientKey)),
      ),
      createMany: jest.fn(async () => ({ count: 1 })),
    },
    auditLog: { create: jest.fn() },
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async () => (options.candidates ?? invoices.map((item) => item.id)).map((id) => ({ id }))),
    $transaction: jest.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
  };
  const client = {
    post: jest.fn(async (_org: string, _tenant: string, path: string, body: { Contacts?: { Name: string }[]; Invoices?: { InvoiceNumber?: string }[] }): Promise<unknown> => {
      if (path.startsWith('/Contacts')) return { Contacts: body.Contacts!.map((contact, index) => ({ ContactID: `contact-${index}-${contact.Name}`, StatusAttributeString: 'OK' })) };
      return { Invoices: body.Invoices!.map((item, index) => ({ InvoiceID: `xero-${item.InvoiceNumber ?? index}`, StatusAttributeString: 'OK' })) };
    }),
    get: jest.fn(),
  };
  const auth = { requireReconnect: jest.fn() };
  const settings = { read: jest.fn(async () => ({ values: SETTINGS, ready: options.ready ?? true, checks: [] })) };
  const sender = new XeroSenderService(prisma as never, client as never, auth as never, settings as never);
  return { sender, prisma, client, auth, syncs, settingsRow: () => settingsRow };
}

const calls = (client: { post: jest.Mock }, prefix: string) => client.post.mock.calls.filter(([, , path]) => (path as string).startsWith(prefix));

describe('a run', () => {
  it('makes the contact, sends the invoice approved with an idempotency key, and keeps what Xero answered', async () => {
    const { sender, client, prisma, syncs, settingsRow } = harness();
    expect(await sender.run(ORG, TENANT)).toEqual({ sent: 1, failed: 0, unchanged: 0, problem: null });
    expect(calls(client, '/Contacts')).toHaveLength(1);
    expect(calls(client, '/Contacts')[0]![3]).toEqual({ Contacts: [{ Name: '12 Example Lane' }] });
    const [org, tenant, path, body, , key] = calls(client, '/Invoices')[0]!;
    expect([org, tenant, path]).toEqual([ORG, TENANT, '/Invoices?summarizeErrors=false']);
    expect((body as { Invoices: { Status: string; Contact: unknown }[] }).Invoices[0]).toMatchObject({ Status: 'AUTHORISED', Contact: { ContactID: 'contact-0-12 Example Lane' } });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(prisma.xeroContactLink.createMany).toHaveBeenCalledWith({
      data: [{ organizationId: ORG, xeroTenantId: TENANT, clientKey: 'jobber:client-1', xeroContactId: 'contact-0-12 Example Lane', name: '12 Example Lane' }],
      skipDuplicates: true,
    });
    expect(syncs.get('inv-1')).toMatchObject({ status: 'SENT', xeroInvoiceId: 'xero-8440', sentFingerprint: invoiceFingerprint(invoice()), problem: null });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'XERO_INVOICES_SENT', metadata: expect.objectContaining({ sent: 1, failed: 0, numbers: ['8440'] }) }),
    });
    // The claim is let go, and the run noted.
    expect(settingsRow()).toMatchObject({ sendingClaimedUntil: null, lastRunProblem: null });
  });

  it('calls Xero not at all when nothing changed', async () => {
    const quiet = harness({ candidates: [] });
    await quiet.sender.run(ORG, TENANT);
    expect(quiet.client.post).not.toHaveBeenCalled();
    // Looked at again (its row moved) but what it says is what Xero has: noted as seen, no call.
    const sent = invoice({
      xeroSync: { xeroTenantId: TENANT, status: 'SENT', sentFingerprint: invoiceFingerprint(invoice()), xeroInvoiceId: 'xero-8440', attempts: 0 },
    });
    const same = harness({ invoices: [sent] });
    expect(await same.sender.run(ORG, TENANT)).toMatchObject({ sent: 0, unchanged: 1 });
    expect(same.client.post).not.toHaveBeenCalled();
    expect(same.prisma.xeroInvoiceSync.update).toHaveBeenCalledWith({ where: { invoiceId: 'inv-1' }, data: { seenUpdatedAt: UPDATED } });
  });

  it('uses the contact it already has', async () => {
    const { sender, client } = harness({ links: [{ clientKey: 'jobber:client-1', xeroContactId: 'contact-known' }] });
    await sender.run(ORG, TENANT);
    expect(calls(client, '/Contacts')).toHaveLength(0);
    expect((calls(client, '/Invoices')[0]![3] as { Invoices: { Contact: unknown }[] }).Invoices[0]!.Contact).toEqual({ ContactID: 'contact-known' });
  });

  it('finds a contact the office made by hand when Xero says the name is taken', async () => {
    const { sender, client, prisma } = harness();
    client.post.mockImplementationOnce(async () => ({
      Contacts: [{ ContactID: null, StatusAttributeString: 'ERROR', ValidationErrors: [{ Message: 'The contact name 12 Example Lane is already assigned to another contact.' }] }],
    }));
    client.get.mockResolvedValueOnce({ Contacts: [{ ContactID: 'contact-by-hand', Name: '12 Example Lane' }] });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ sent: 1 });
    expect(client.get).toHaveBeenCalledWith(ORG, TENANT, `/Contacts?where=${encodeURIComponent('Name=="12 Example Lane"')}`, expect.anything());
    expect(prisma.xeroContactLink.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ xeroContactId: 'contact-by-hand' })], skipDuplicates: true });
  });

  it('keeps Xero’s reason for an invoice it refused, tries it again in an hour, and sends the rest', async () => {
    const { sender, client, syncs } = harness({ invoices: [invoice(), invoice({ id: 'inv-2', number: '8441', jobberClientId: 'client-2', clientName: '14 Example Lane' })] });
    client.post.mockImplementation(async (_org: string, _tenant: string, path: string, body: { Contacts?: { Name: string }[] }) =>
      path.startsWith('/Contacts')
        ? { Contacts: body.Contacts!.map((_, index) => ({ ContactID: `contact-${index}` })) }
        : {
            Invoices: [
              { InvoiceID: null, StatusAttributeString: 'ERROR', ValidationErrors: [{ Message: 'Invoice # must be unique.' }] },
              { InvoiceID: 'xero-8441', StatusAttributeString: 'OK' },
            ],
          },
    );
    expect(await sender.run(ORG, TENANT)).toMatchObject({ sent: 1, failed: 1 });
    expect(syncs.get('inv-1')).toMatchObject({
      status: 'FAILED',
      problem: 'Invoice # must be unique.',
      attempts: 1,
      nextAttemptAt: new Date('2026-12-02T19:00:00.000Z'),
    });
    expect(syncs.get('inv-2')).toMatchObject({ status: 'SENT', xeroInvoiceId: 'xero-8441' });
  });

  it('holds back an invoice that does not add up, without calling Xero for it, until it changes', async () => {
    const { sender, client, syncs } = harness({ invoices: [invoice({ totalCents: 18000 })] });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ sent: 0, failed: 1 });
    expect(calls(client, '/Invoices')).toHaveLength(0);
    expect(syncs.get('inv-1')).toMatchObject({ status: 'FAILED', nextAttemptAt: null, problem: expect.stringContaining('Its lines come to $175.00') });
  });

  it('stops at the daily ceiling, says so, and leaves the rest for the next run', async () => {
    const { sender, client, settingsRow, syncs } = harness();
    client.post.mockRejectedValue(new XeroError('The console has used its 300 calls to Xero today. More can go tomorrow.', 'XERO_DAILY_CEILING', 429));
    expect(await sender.run(ORG, TENANT)).toMatchObject({ sent: 0, problem: 'The console has used its 300 calls to Xero today. More can go tomorrow.' });
    // Nothing marked: it is still a candidate tomorrow.
    expect(syncs.size).toBe(0);
    expect(settingsRow()).toMatchObject({ sendingClaimedUntil: null, lastRunProblem: expect.stringContaining('300 calls') });
  });

  it('asks for the sign-in again when Xero refuses it', async () => {
    const { sender, client, auth } = harness();
    client.post.mockRejectedValue(new XeroError('Xero refused the stored sign-in. Connect again.', 'XERO_REAUTHORIZATION_REQUIRED', 409));
    await sender.run(ORG, TENANT);
    expect(auth.requireReconnect).toHaveBeenCalledWith(ORG, 'Xero refused the stored sign-in. Connect again.');
  });

  it('voids in Xero an invoice voided here after it was sent', async () => {
    const voided = invoice({
      status: 'VOIDED',
      xeroSync: { xeroTenantId: TENANT, status: 'SENT', sentFingerprint: invoiceFingerprint(invoice()), xeroInvoiceId: 'xero-8440', attempts: 0 },
    });
    const { sender, client } = harness({ invoices: [voided] });
    await sender.run(ORG, TENANT);
    expect(calls(client, '/Contacts')).toHaveLength(0);
    expect(calls(client, '/Invoices')[0]![3]).toEqual({ Invoices: [{ InvoiceID: 'xero-8440', Status: 'VOIDED' }] });
  });

  it('does nothing while off, blocked, or already running elsewhere', async () => {
    const off = harness({ settingsRow: { sendingEnabled: false } });
    expect(await off.sender.run(ORG, TENANT)).toMatchObject({ problem: 'Sending is off.' });
    const readOnly = harness({ connection: { status: 'CONNECTED', xeroTenantId: TENANT, scopes: ['offline_access', 'accounting.settings.read'], invoiceRemindersOn: false, accounts: ACCOUNTS } });
    expect(await readOnly.sender.run(ORG, TENANT)).toMatchObject({ problem: 'Connect again, so Xero lets the console write contacts and invoices.' });
    const reminders = harness({ connection: { status: 'CONNECTED', xeroTenantId: TENANT, scopes: XERO_SEND_SCOPES.split(' '), invoiceRemindersOn: true, accounts: ACCOUNTS } });
    expect((await reminders.sender.run(ORG, TENANT)).problem).toMatch(/invoice reminders/);
    const busy = harness({
      settingsRow: { sendingEnabled: true, sendFrom: new Date('2026-12-01T00:00:00.000Z'), sendingClaimedUntil: new Date('2026-12-02T18:10:00.000Z') },
    });
    expect(await busy.sender.run(ORG, TENANT)).toMatchObject({ problem: 'Another run is sending.' });
    for (const run of [off, readOnly, reminders, busy]) expect(run.client.post).not.toHaveBeenCalled();
  });

  it('looks only at the invoices that go to this organisation (2026-11-10): each company’s go to its own books', async () => {
    const { sender, prisma, client } = harness();
    expect(await sender.run(ORG, TENANT)).toMatchObject({ sent: 1, problem: null });
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0] as unknown as [string[], ...unknown[]];
    const sql = strings.join('?');
    expect(sql).toContain('i."xeroTenantId" = ?');
    expect(values[strings.findIndex((part) => part.endsWith('i."xeroTenantId" = '))]).toBe(TENANT);
    expect(calls(client, '/Invoices')).toHaveLength(1);
  });

  it('counts this organisation’s invoices not sent yet, and says how many belong to no company', async () => {
    const { sender, prisma } = harness();
    prisma.invoice.count.mockResolvedValueOnce(4).mockResolvedValueOnce(2);
    const view = await sender.view(ORG, TENANT);
    expect(view.counts).toMatchObject({ notYet: 4, noCompany: 2 });
    expect(view.blockers).toEqual([]);
    const [notYet, noCompany] = prisma.invoice.count.mock.calls.map((call) => (call as unknown as [{ where: Record<string, unknown> }])[0].where);
    expect(notYet).toMatchObject({ organizationId: ORG, xeroTenantId: TENANT });
    expect(noCompany).toMatchObject({ organizationId: ORG, xeroTenantId: null, status: { notIn: ['DRAFT', 'VOIDED'] } });
  });

  it('sends a busy day -- 200 changed invoices for 200 clients -- in eight calls, 50 a call', async () => {
    const many = Array.from({ length: MAX_INVOICES_PER_RUN }, (_, index) =>
      invoice({ id: `inv-${index}`, number: String(9000 + index), jobberClientId: `client-${index}`, clientName: `${index} Example Lane` }),
    );
    const { sender, client } = harness({ invoices: many });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ sent: 200, failed: 0 });
    expect(calls(client, '/Contacts')).toHaveLength(4);
    expect(calls(client, '/Invoices')).toHaveLength(4);
    for (const [, , , body] of client.post.mock.calls) expect(((body as { Contacts?: unknown[]; Invoices?: unknown[] }).Contacts ?? (body as { Invoices: unknown[] }).Invoices).length).toBeLessThanOrEqual(50);
  });
});

describe('turning it on, and the office’s buttons', () => {
  it('turns on only when nothing blocks it, and says who turned it on or off', async () => {
    const blocked = harness({ ready: false, settingsRow: { sendingEnabled: false, sendFrom: new Date('2026-12-01T00:00:00.000Z') } });
    await expect(blocked.sender.setEnabled(office, TENANT, true)).rejects.toMatchObject({ code: 'XERO_SENDING_BLOCKED', message: 'Finish “Before anything is sent”.' });
    const ready = harness({ settingsRow: { sendingEnabled: false, sendFrom: new Date('2026-12-01T00:00:00.000Z') } });
    await ready.sender.setEnabled(office, TENANT, true);
    expect(ready.prisma.xeroSettings.update).toHaveBeenCalledWith({
      where: { organizationId_xeroTenantId: { organizationId: ORG, xeroTenantId: TENANT } },
      data: { sendingEnabled: true, sendingChangedAt: expect.any(Date) },
    });
    expect(ready.prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'XERO_SENDING_TURNED_ON', actorUserId: office.id }) });
    await ready.sender.setEnabled(office, TENANT, false);
    expect(ready.prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'XERO_SENDING_TURNED_OFF' }) });
  });

  it('sends now at most once a minute', async () => {
    const { sender } = harness({
      settingsRow: { sendingEnabled: true, lastRunAt: new Date('2026-12-02T17:59:30.000Z'), sendFrom: new Date('2026-12-01T00:00:00.000Z') },
    });
    await expect(sender.runNow(office, TENANT)).rejects.toMatchObject({ code: 'XERO_RUN_TOO_SOON' });
  });

  it('tries every refused invoice again on the next run', async () => {
    const { sender, prisma } = harness();
    await sender.retryFailed(office, TENANT);
    expect(prisma.xeroInvoiceSync.updateMany).toHaveBeenCalledWith({ where: { organizationId: ORG, xeroTenantId: TENANT, status: 'FAILED' }, data: { nextAttemptAt: expect.any(Date), seenUpdatedAt: null } });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'XERO_SENDING_RETRIED', metadata: { tenantId: TENANT, invoices: 2 } }) });
  });

  it('is seen with integrations:read and run with integrations:manage', () => {
    const permissions = (method: keyof XeroController) => Reflect.getMetadata(PERMISSIONS_METADATA_KEY, XeroController.prototype[method]);
    expect(permissions('sending')).toEqual(['integrations:read']);
    for (const method of ['setSending', 'runSending', 'retrySending'] as const) expect(permissions(method)).toEqual(['integrations:manage']);
  });
});
