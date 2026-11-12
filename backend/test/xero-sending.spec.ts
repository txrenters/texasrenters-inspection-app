import { createHash } from 'node:crypto';

import { UserRole, type XeroAccount, type XeroItem, type XeroSettingsValues, type XeroTrackingCategory } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { PERMISSIONS_METADATA_KEY } from '../src/common/auth';
import { XeroClient, xeroValidationMessages } from '../src/integrations/xero/xero.client';
import { XERO_SEND_SCOPES, getXeroConfig } from '../src/integrations/xero/xero.config';
import { XeroController } from '../src/integrations/xero/xero.controller';
import { XeroError } from '../src/integrations/xero/xero.errors';
import { clientKeyOf, invoiceFingerprint, xeroInvoiceFrom, type InvoiceForXero } from '../src/integrations/xero/xero-invoice';
import { paymentFingerprint, xeroPaymentFrom, type PaymentForXero } from '../src/integrations/xero/xero-payment';
import { MAX_INVOICES_PER_RUN, XeroSenderService, invoiceForXero } from '../src/integrations/xero/xero-sender.service';
import { xeroWriteOffFrom } from '../src/integrations/xero/xero-write-off';
import { remindersFrom } from '../src/integrations/xero/xero.service';
import { withProductChoices } from '../src/integrations/xero/xero-settings.service';

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
  // Where payments land (2026-11-10, phase 4).
  { accountId: 'a-090', code: '090', name: 'Operating checking', type: 'BANK', class: 'ASSET', status: 'ACTIVE', takesPayments: true },
  // Where bad debts are written off (2026-11-10).
  { accountId: 'a-480', code: '480', name: 'Bad debts', type: 'EXPENSE', class: 'EXPENSE', status: 'ACTIVE', takesPayments: false },
];
const SETTINGS: XeroSettingsValues = {
  sendFrom: '2026-12-01',
  salesAccountId: 'a-400',
  salesTaxType: 'NONE',
  salesAccounts: { 'filter change': 'a-410' },
  paymentAccounts: {},
};

const UPDATED = new Date('2026-12-02T15:00:00.000Z');
/** The visit it bills, as the sender reads it (2026-11-11): its day, and its technician. */
type Visit = { scheduledAt: Date; assignments: { technician: { displayName: string } }[] };
type Fixture = InvoiceForXero & { updatedAt: Date; xeroSync: Record<string, unknown> | null; inspection?: Visit | null };
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
  visitDay: null,
  technicianName: null,
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
  const plan = (over: Partial<Fixture> = {}, settings = SETTINGS) => xeroInvoiceFrom(invoice(over), { settings, accounts: ACCOUNTS, contactId: 'contact-1' });

  it('goes approved, under its client, each line to its product’s account or the default, with the office’s tax type', () => {
    expect(plan()).toEqual({
      kind: 'send',
      body: {
        Type: 'ACCREC',
        Contact: { ContactID: 'contact-1' },
        InvoiceNumber: '8440',
        Reference: '12 Example Lane',
        Date: '2026-12-02',
        DueDate: '2026-12-31',
        LineAmountTypes: 'Exclusive',
        Status: 'AUTHORISED',
        LineItems: [
          { Description: 'Move-out inspection\nFull walk-through', Quantity: 1, UnitAmount: 150, LineAmount: 150, AccountCode: '400', TaxType: 'NONE' },
          { Description: 'Filter change', Quantity: 1, UnitAmount: 25, LineAmount: 25, AccountCode: '410', TaxType: 'NONE' },
        ],
      },
    });
  });

  it('is always a new invoice: it never names one Xero has, to change it (2026-11-12)', () => {
    const sent = plan();
    expect(sent.kind === 'send' && 'InvoiceID' in sent.body).toBe(false);
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
    expect(plan({}, { ...SETTINGS, salesAccounts: { 'filter change': 'a-460' } })).toEqual({
      kind: 'problem',
      problem: 'The account chosen for “Filter change” is not an active account in Xero. Choose again on the Xero page.',
    });
  });

  it('sends nothing for one voided before it reached Xero', () => {
    expect(plan({ status: 'VOIDED' })).toEqual({ kind: 'problem', problem: 'It was voided before it reached Xero, so it is not sent.' });
  });

  it('reads as changed here only when what it says changes: not when it is paid, nor when an account is chosen anew', () => {
    const before = invoiceFingerprint(invoice());
    expect(invoiceFingerprint(invoice({ status: 'PAID' }))).toBe(before);
    expect(invoiceFingerprint(invoice({ lines: [...invoice().lines].reverse() }))).toBe(before);
    expect(invoiceFingerprint(invoice({ totalCents: 18000 }))).not.toBe(before);
    expect(invoiceFingerprint(invoice({ status: 'VOIDED' }))).not.toBe(before);
    // What Xero is sent of it (2026-11-11): its visit's day and technician, not its subject or job number.
    expect(invoiceFingerprint(invoice({ subject: 'Quarterly service', jobNumber: '513' }))).toBe(before);
    expect(invoiceFingerprint(invoice({ visitDay: '2026-11-30' }))).not.toBe(before);
    expect(invoiceFingerprint(invoice({ technicianName: 'Ada Lane' }))).not.toBe(before);
  });

  describe('as the office finishes its invoices in Xero (2026-11-11)', () => {
    const CATEGORY: XeroTrackingCategory = {
      trackingCategoryId: 'tc-1',
      name: 'Income by Employee',
      status: 'ACTIVE',
      options: [
        { optionId: 'to-1', name: 'Air Filter Income: Ada', status: 'ACTIVE' },
        // Written without its colon in Xero: found all the same.
        { optionId: 'to-2', name: 'Move Out Inspection Income Ada', status: 'ACTIVE' },
        { optionId: 'to-3', name: 'Air Filter Income: Bea', status: 'ARCHIVED' },
      ],
    };
    const ITEMS: XeroItem[] = [{ itemId: 'it-1', code: 'Filter Change', name: 'Filter Change', isSold: true }];
    const TAGGED: XeroSettingsValues = {
      ...SETTINGS,
      trackingCategoryId: 'tc-1',
      trackingGroups: { 'filter change': 'Air Filter Income', 'move-out inspection': 'Move Out Inspection Income' },
      itemCodes: { 'filter change': 'Filter Change' },
    };
    const tagged = (over: Partial<Fixture> = {}, settings = TAGGED, catalog: { trackingCategories?: XeroTrackingCategory[]; items?: XeroItem[] } = {}) =>
      xeroInvoiceFrom(invoice(over), {
        settings,
        accounts: ACCOUNTS,
        trackingCategories: catalog.trackingCategories ?? [CATEGORY],
        items: catalog.items ?? ITEMS,
        contactId: 'contact-1',
      });

    it('dates it on the visit’s day, due on the last day of that month, with the property as its reference', () => {
      const sent = plan({ visitDay: '2026-11-28' });
      expect(sent.kind === 'send' && [sent.body.Date, sent.body.DueDate, sent.body.Reference]).toEqual(['2026-11-28', '2026-11-30', '12 Example Lane']);
      // No visit: the day it was issued, due at the end of that month.
      const alone = plan({ issuedOn: new Date('2026-02-10T00:00:00.000Z') });
      expect(alone.kind === 'send' && [alone.body.Date, alone.body.DueDate]).toEqual(['2026-02-10', '2026-02-28']);
    });

    it('puts each line under its Xero item, tagged for the visit’s technician by first name', () => {
      const sent = tagged({ technicianName: 'Ada Lane' });
      expect(sent.kind === 'send' && sent.body.LineItems).toEqual([
        {
          Description: 'Move-out inspection\nFull walk-through',
          Quantity: 1,
          UnitAmount: 150,
          LineAmount: 150,
          AccountCode: '400',
          TaxType: 'NONE',
          Tracking: [{ TrackingCategoryID: 'tc-1', Name: 'Income by Employee', Option: 'Move Out Inspection Income Ada' }],
        },
        {
          ItemCode: 'Filter Change',
          Description: 'Filter change',
          Quantity: 1,
          UnitAmount: 25,
          LineAmount: 25,
          AccountCode: '410',
          TaxType: 'NONE',
          Tracking: [{ TrackingCategoryID: 'tc-1', Name: 'Income by Employee', Option: 'Air Filter Income: Ada' }],
        },
      ]);
    });

    it('sends a line untagged when no technician is known, or its product is not tracked', () => {
      const unknown = tagged({ technicianName: null });
      expect(unknown.kind === 'send' && unknown.body.LineItems.map((line) => line.Tracking)).toEqual([undefined, undefined]);
      const untracked = tagged({ technicianName: 'Ada Lane' }, { ...TAGGED, trackingGroups: { 'filter change': 'Air Filter Income' } });
      expect(untracked.kind === 'send' && untracked.body.LineItems.map((line) => line.Tracking?.[0]?.Option)).toEqual([undefined, 'Air Filter Income: Ada']);
    });

    it('holds it back when Xero has no option for the technician -- an archived one is none', () => {
      expect(tagged({ technicianName: 'Bea Stone' })).toEqual({
        kind: 'problem',
        problem: 'Income by Employee has no option “Move Out Inspection Income: Bea” for Bea Stone. Add it in Xero, then read from Xero again.',
      });
    });

    it('holds it back when the category or an item is no longer in Xero', () => {
      expect(tagged({ technicianName: 'Ada Lane' }, TAGGED, { trackingCategories: [] })).toMatchObject({ kind: 'problem', problem: expect.stringContaining('tracking category') });
      expect(tagged({}, TAGGED, { items: [] })).toMatchObject({ kind: 'problem', problem: expect.stringContaining('The item “Filter Change”') });
    });

    it('reads the visit’s day and technician from the invoice’s visit', () => {
      const visit = { scheduledAt: new Date('2026-11-09T00:00:00.000Z'), assignments: [{ technician: { displayName: 'Ada Lane' } }] };
      expect(invoiceForXero({ ...invoice(), inspection: visit } as never)).toMatchObject({ visitDay: '2026-11-09', technicianName: 'Ada Lane' });
      expect(invoiceForXero({ ...invoice(), inspection: null } as never)).toMatchObject({ visitDay: null, technicianName: null });
    });
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
    // The Projects API's way (2026-11-11): the field's messages, else its one message.
    expect(xeroValidationMessages({ message: 'The request is invalid.', modelState: { rate: ['The Rate field is required.'] } })).toBe('The Rate field is required.');
    expect(xeroValidationMessages({ message: 'Project not found.' })).toBe('Project not found.');
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
    // And projects (2026-11-11): a project for each visit, its labour as time.
    expect(XERO_SEND_SCOPES).toBe('offline_access accounting.settings.read accounting.contacts accounting.invoices accounting.payments projects');
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
  /** The office's payments, and their rows in Xero (2026-11-10, phase 4). */
  payments?: PaymentFixture[];
  paymentRows?: Record<string, unknown>[];
  paymentCandidates?: string[];
  values?: XeroSettingsValues;
  /** Invoices closed as bad debt and in Xero, and their write-offs (2026-11-10). */
  badDebts?: Record<string, unknown>[];
  writeOffRows?: Record<string, unknown>[];
  /** What Xero has already under the numbers asked about (2026-11-11): made by Zapier, or by hand. */
  inXero?: { InvoiceID: string; InvoiceNumber: string; Type?: string; Status: string; Contact?: { Name: string } }[];
  /** The organisation's tracking categories and items, as last read (2026-11-11). */
  trackingCategories?: XeroTrackingCategory[];
  items?: XeroItem[];
  /** The console makes the invoices (2026-11-12): Jobber's are sent no more. */
  takenOver?: boolean;
  /** Xero's invoices of a contact on a day, as a lookup for a console draft finds them (2026-11-12). */
  drafts?: { InvoiceID: string; InvoiceNumber?: string; Url?: string; Status?: string }[];
} = {}) {
  const writeOffRows: Record<string, unknown>[] = (options.writeOffRows ?? []).map((row) => ({ ...row }));
  const invoices = options.invoices ?? [invoice()];
  const payments = options.payments ?? [];
  const paymentRows: Record<string, unknown>[] = (options.paymentRows ?? []).map((row) => ({ ...row }));
  // A where clause as the payment rows are asked for: equal, `in`, `not`; an OR is let through.
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'OR') return true;
      if (value && typeof value === 'object' && 'in' in value) return (value.in as unknown[]).includes(row[key]);
      if (value && typeof value === 'object' && 'not' in value) return row[key] !== value.not && row[key] !== undefined;
      return (row[key] ?? null) === value;
    });
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
        connection
          ? {
              name: 'Example Home Services',
              status: 'CONNECTED',
              invoiceRemindersOn: connection.invoiceRemindersOn,
              accounts: connection.accounts,
              trackingCategories: options.trackingCategories ?? [],
              items: options.items ?? [],
            }
          : null,
      ),
    },
    // When the console began making the invoices (2026-11-12): not yet, unless the test says.
    invoiceSettings: {
      findUnique: jest.fn(async () => (options.takenOver ? { invoicingTakenOverAt: new Date('2026-12-01T15:00:00.000Z') } : null)),
    },
    invoice: {
      // A console draft takes Xero's number and id (2026-11-12).
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Object.assign(invoices.find((item) => item.id === where.id) ?? {}, data),
      ),
      // The invoices to send; or, asked for bad debts, those (2026-11-10).
      findMany: jest.fn(async ({ where }: { where: { id?: { in: string[] }; status?: string } }) =>
        where.id ? invoices.filter((item) => where.id!.in.includes(item.id)) : where.status === 'BAD_DEBT' ? (options.badDebts ?? []) : [],
      ),
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
    invoicePayment: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        payments
          .filter((item) => where.id.in.includes(item.id))
          .map((item) => ({ ...item, xeroSync: paymentRows.find((row) => row.paymentId === item.id) ?? null })),
      ),
    },
    xeroPaymentSync: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => paymentRows.filter((row) => matches(row, where))),
      count: jest.fn(async ({ where }: { where: Record<string, unknown> }) => paymentRows.filter((row) => matches(row, where)).length),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(paymentRows.find((row) => row.id === where.id)!, data)),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => paymentRows.splice(paymentRows.findIndex((row) => row.id === where.id), 1)[0]),
      upsert: jest.fn(async ({ where, create, update }: { where: { paymentId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const row = paymentRows.find((item) => item.paymentId === where.paymentId);
        if (row) return Object.assign(row, update);
        const made = { id: `ps-${paymentRows.length + 1}`, ...create };
        paymentRows.push(made);
        return made;
      }),
      updateMany: jest.fn(async () => ({ count: 2 })),
    },
    xeroWriteOffSync: {
      // Asked with `invoice`: those of invoices reopened here.
      findMany: jest.fn(async ({ where }: { where: { invoice?: unknown; status?: string } }) =>
        writeOffRows.filter((row) => (where.invoice ? row.invoiceStatus !== 'BAD_DEBT' : true) && (where.status ? row.status === where.status : true)),
      ),
      count: jest.fn(async ({ where }: { where: { status: string } }) => writeOffRows.filter((row) => row.status === where.status).length),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(writeOffRows.find((row) => row.id === where.id)!, data)),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => writeOffRows.splice(writeOffRows.findIndex((row) => row.id === where.id), 1)[0]),
      upsert: jest.fn(async ({ where, create, update }: { where: { invoiceId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const row = writeOffRows.find((item) => item.invoiceId === where.invoiceId);
        if (row) return Object.assign(row, update);
        const made = { id: `wo-${writeOffRows.length + 1}`, ...create };
        writeOffRows.push(made);
        return made;
      }),
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
    // The invoices worth looking at, or -- asked of the payments -- the payments.
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) =>
      (strings.join('?').includes('"InvoicePayment"')
        ? (options.paymentCandidates ?? payments.map((item) => item.id))
        : (options.candidates ?? invoices.map((item) => item.id))
      ).map((id) => ({ id })),
    ),
    $transaction: jest.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
  };
  const client = {
    post: jest.fn(async (_org: string, _tenant: string, path: string, body: { Contacts?: { Name: string }[]; Invoices?: { InvoiceNumber?: string }[]; Payments?: unknown[] }): Promise<unknown> => {
      if (path.startsWith('/Contacts')) return { Contacts: body.Contacts!.map((contact, index) => ({ ContactID: `contact-${index}-${contact.Name}`, StatusAttributeString: 'OK' })) };
      // One deleted, or several made.
      if (path.startsWith('/Payments/')) return { Payments: [{ PaymentID: path.split('/')[2], StatusAttributeString: 'OK' }] };
      if (path.startsWith('/Payments')) return { Payments: body.Payments!.map((_payment, index) => ({ PaymentID: `xero-payment-${index + 1}`, StatusAttributeString: 'OK' })) };
      // A credit note made, or voided (2026-11-10).
      if (path.startsWith('/CreditNotes'))
        return { CreditNotes: (body as { CreditNotes: { CreditNoteID?: string }[] }).CreditNotes.map((note, index) => ({ CreditNoteID: note.CreditNoteID ?? `credit-${index + 1}`, StatusAttributeString: 'OK' })) };
      return { Invoices: body.Invoices!.map((item, index) => ({ InvoiceID: `xero-${item.InvoiceNumber ?? index}`, StatusAttributeString: 'OK' })) };
    }),
    get: jest.fn(async (_org: string, _tenant: string, path: string): Promise<unknown> => {
      if (path.startsWith('/Invoices?InvoiceNumbers=')) {
        const asked = decodeURIComponent(/InvoiceNumbers=([^&]*)/.exec(path)![1]!).split(',');
        return { Invoices: (options.inXero ?? []).filter((theirs) => asked.includes(theirs.InvoiceNumber)) };
      }
      // By Xero's ids, to void (2026-11-11): what each is there now.
      if (path.startsWith('/Invoices?IDs=')) {
        const asked = decodeURIComponent(/IDs=([^&]*)/.exec(path)![1]!).split(',');
        return { Invoices: (options.inXero ?? []).filter((theirs) => asked.includes(theirs.InvoiceID)) };
      }
      // A contact's invoices on a day (2026-11-12): what a console draft is looked for among.
      if (path.startsWith('/Invoices?ContactIDs=')) return { Invoices: options.drafts ?? [] };
      return path.startsWith('/CreditNotes/') ? { CreditNotes: [{ CreditNoteID: path.split('/')[2], Allocations: [{ AllocationID: 'allocation-found' }] }] } : {};
    }),
    // A credit note's allocation, made or taken off (2026-11-10); or the console's drafts, made in Xero (2026-11-12).
    put: jest.fn<Promise<unknown>, [string, string, string, unknown, unknown, string]>(async (_org, _tenant, path, body) =>
      path.startsWith('/Invoices')
        ? {
            Invoices: (body as { Invoices: unknown[] }).Invoices.map((_draft, index) => ({
              InvoiceID: `xero-draft-${index + 1}`,
              InvoiceNumber: `INV-010${index + 1}`,
              StatusAttributeString: 'OK',
            })),
          }
        : { Allocations: [{ AllocationID: 'allocation-1', StatusAttributeString: 'OK' }] },
    ),
    delete: jest.fn(async (): Promise<unknown> => ({ Allocations: [] })),
  };
  const auth = { requireReconnect: jest.fn() };
  const settings = { read: jest.fn(async () => ({ values: options.values ?? SETTINGS, ready: options.ready ?? true, checks: [] })) };
  // Visits' projects (2026-11-11): tested on their own in xero-projects.spec.ts.
  const projects = {
    run: jest.fn<Promise<unknown>, unknown[]>(async () => ({ made: 0, linked: 0, failed: 0, names: [] as string[] })),
    summary: jest.fn(async () => ({ done: 0, failed: 0, failures: [] })),
    retry: jest.fn(async () => 0),
  };
  const sender = new XeroSenderService(prisma as never, client as never, auth as never, settings as never, projects as never);
  return { sender, prisma, client, auth, projects, syncs, paymentRows, writeOffRows, settingsRow: () => settingsRow };
}

const calls = (client: { post: jest.Mock }, prefix: string) => client.post.mock.calls.filter(([, , path]) => (path as string).startsWith(prefix));

/** A payment against invoice #8440, as the sender reads it (2026-11-10, phase 4). */
type PaymentFixture = PaymentForXero & { updatedAt: Date; invoice: { id: string; number: string | null; xeroSync: { xeroInvoiceId: string | null } | null } };
const payment = (over: Partial<PaymentFixture> = {}): PaymentFixture => ({
  id: 'pay-1',
  paidOn: new Date('2026-12-03T00:00:00.000Z'),
  amountCents: 17500,
  method: 'CHECK',
  reference: '1042',
  updatedAt: UPDATED,
  invoice: { id: 'inv-1', number: '8440', xeroSync: { xeroInvoiceId: 'xero-8440' } },
  ...over,
});
/** Checks land in the operating account. */
const PAYING: XeroSettingsValues = { ...SETTINGS, paymentAccounts: { CHECK: 'a-090' } };
/** Invoice #8440 in Xero as it is now: nothing to send for it. */
const inXero = (over: Partial<Fixture> = {}) =>
  invoice({ xeroSync: { xeroTenantId: TENANT, status: 'SENT', sentFingerprint: invoiceFingerprint(invoice()), xeroInvoiceId: 'xero-8440', attempts: 0 }, ...over });
/** A payment row as sent. */
const sentRow = (over: Record<string, unknown> = {}) => ({
  id: 'ps-1',
  organizationId: ORG,
  paymentId: 'pay-1',
  invoiceId: 'inv-1',
  xeroTenantId: TENANT,
  xeroPaymentId: 'xero-payment-old',
  status: 'SENT',
  sentFingerprint: paymentFingerprint(payment()),
  seenUpdatedAt: new Date('2026-12-01T00:00:00.000Z'),
  attempts: 0,
  ...over,
});

describe('a payment, as Xero is sent it', () => {
  it('goes against its invoice in Xero, into the account chosen for how it was paid', () => {
    expect(xeroPaymentFrom(payment(), { settings: PAYING, accounts: ACCOUNTS, xeroInvoiceId: 'xero-8440' })).toEqual({
      kind: 'send',
      body: { Invoice: { InvoiceID: 'xero-8440' }, Account: { AccountID: 'a-090' }, Date: '2026-12-03', Amount: 175, Reference: '1042' },
    });
    // No reference: the method says what it was.
    expect(xeroPaymentFrom(payment({ reference: null }), { settings: PAYING, accounts: ACCOUNTS, xeroInvoiceId: 'xero-8440' })).toMatchObject({ body: { Reference: 'Check' } });
  });

  it('is held back with the reason when its method has no account, or the account no longer takes payments', () => {
    expect(xeroPaymentFrom(payment({ method: 'ZELLE' }), { settings: PAYING, accounts: ACCOUNTS, xeroInvoiceId: 'x' })).toEqual({
      kind: 'problem',
      problem: 'Choose the Xero account Zelle payments land in, under “Before anything is sent”.',
    });
    expect(xeroPaymentFrom(payment(), { settings: { ...PAYING, paymentAccounts: { CHECK: 'a-400' } }, accounts: ACCOUNTS, xeroInvoiceId: 'x' })).toMatchObject({
      problem: 'The account chosen for Check payments is no longer in Xero, or no longer takes payments: choose another.',
    });
  });

  it('changes its fingerprint when what it says changes, not when its account does', () => {
    expect(paymentFingerprint(payment({ amountCents: 1000 }))).not.toBe(paymentFingerprint(payment()));
    expect(paymentFingerprint(payment({ reference: ' 1042 ' }))).toBe(paymentFingerprint(payment()));
  });
});

/** Bad debts are written off to the bad-debts expense account (2026-11-10). */
const WRITING: XeroSettingsValues = { ...SETTINGS, badDebtAccountId: 'a-480' };
/** Invoice #8449, in Xero, closed as bad debt here on Dec 2 with $175.00 still owed. */
const badDebt = (over: Record<string, unknown> = {}) => ({
  id: 'inv-9',
  number: '8449',
  clientName: '12 Example Lane',
  jobberClientId: 'client-1',
  balanceCents: 17500,
  updatedAt: new Date('2026-12-02T15:00:00.000Z'),
  xeroSync: { xeroInvoiceId: 'xero-8449' },
  xeroWriteOff: null,
  ...over,
});
const LINKS = [{ clientKey: 'jobber:client-1', xeroContactId: 'contact-1' }];
const writtenOff = (over: Record<string, unknown> = {}) => ({
  id: 'wo-1',
  invoiceId: 'inv-9',
  xeroTenantId: TENANT,
  xeroCreditNoteId: 'credit-old',
  xeroAllocationId: 'allocation-old',
  amountCents: 17500,
  status: 'SENT',
  attempts: 0,
  // The invoice was reopened here.
  invoiceStatus: 'AWAITING_PAYMENT',
  ...over,
});

describe('a bad debt, as Xero is sent it (2026-11-10)', () => {
  const context = { settings: WRITING, accounts: ACCOUNTS, contactId: 'contact-1', xeroInvoiceId: 'xero-8449', day: '2026-12-02' };

  it('is a credit note for what was still owed, to the bad-debts account, and its allocation to the invoice', () => {
    expect(xeroWriteOffFrom({ number: '8449', balanceCents: 17500 }, context)).toEqual({
      kind: 'send',
      creditNote: {
        Type: 'ACCRECCREDIT',
        Contact: { ContactID: 'contact-1' },
        Date: '2026-12-02',
        Status: 'AUTHORISED',
        LineAmountTypes: 'Exclusive',
        Reference: 'Bad debt: invoice #8449',
        LineItems: [{ Description: 'Written off as bad debt: invoice #8449', Quantity: 1, UnitAmount: 175, LineAmount: 175, AccountCode: '480', TaxType: 'NONE' }],
      },
      allocation: { Invoice: { InvoiceID: 'xero-8449' }, Amount: 175, Date: '2026-12-02' },
    });
  });

  it('is held back with the reason with no account chosen, or one no longer an expense account', () => {
    expect(xeroWriteOffFrom({ number: '8449', balanceCents: 17500 }, { ...context, settings: SETTINGS })).toEqual({
      kind: 'problem',
      problem: 'Choose the account bad debts are written off to, under “Before anything is sent”.',
    });
    expect(xeroWriteOffFrom({ number: '8449', balanceCents: 17500 }, { ...context, settings: { ...WRITING, badDebtAccountId: 'a-400' } })).toMatchObject({
      problem: 'The account chosen for bad debts is no longer an active expense account in Xero: choose another.',
    });
  });
});

describe('bad debts, written off in the company’s books (2026-11-10)', () => {
  it('writes off what a bad debt still owed with a credit note, allocates it to the invoice, and keeps both', async () => {
    const { sender, client, writeOffRows } = harness({ invoices: [], candidates: [], badDebts: [badDebt()], links: LINKS, values: WRITING });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ writeOffs: { sent: 1, failed: 0, reversed: 0 }, problem: null });
    const [made] = calls(client, '/CreditNotes');
    expect(made![3]).toEqual({ CreditNotes: [expect.objectContaining({ Type: 'ACCRECCREDIT', Contact: { ContactID: 'contact-1' }, Date: '2026-12-02' })] });
    expect(made![5]).toMatch(/^[0-9a-f]{64}$/);
    expect(client.put).toHaveBeenCalledWith(
      ORG,
      TENANT,
      '/CreditNotes/credit-1/Allocations',
      { Allocations: [{ Invoice: { InvoiceID: 'xero-8449' }, Amount: 175, Date: '2026-12-02' }] },
      expect.anything(),
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
    expect(writeOffRows).toEqual([expect.objectContaining({ invoiceId: 'inv-9', xeroCreditNoteId: 'credit-1', xeroAllocationId: 'allocation-1', amountCents: 17500, status: 'SENT' })]);
  });

  it('holds one back, without calling Xero, until a bad-debts account is chosen', async () => {
    const { sender, client, writeOffRows } = harness({ invoices: [], candidates: [], badDebts: [badDebt()], links: LINKS, values: SETTINGS });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ writeOffs: { sent: 0, failed: 1, reversed: 0 } });
    expect(client.post).not.toHaveBeenCalled();
    expect(writeOffRows[0]).toMatchObject({ status: 'FAILED', nextAttemptAt: null, problem: expect.stringContaining('Choose the account bad debts are written off to') });
  });

  it('keeps the credit note when Xero refuses its allocation, and allocates that one next time, never a second', async () => {
    const first = harness({ invoices: [], candidates: [], badDebts: [badDebt()], links: LINKS, values: WRITING });
    first.client.put.mockResolvedValueOnce({ Allocations: [{ AllocationID: null, StatusAttributeString: 'ERROR', ValidationErrors: [{ Message: 'Amount exceeds the amount due' }] }] } as never);
    expect(await first.sender.run(ORG, TENANT)).toMatchObject({ writeOffs: { sent: 0, failed: 1 } });
    expect(first.writeOffRows[0]).toMatchObject({ status: 'FAILED', xeroCreditNoteId: 'credit-1', problem: 'Amount exceeds the amount due', nextAttemptAt: expect.any(Date) });

    const again = harness({
      invoices: [],
      candidates: [],
      badDebts: [badDebt({ xeroWriteOff: { xeroCreditNoteId: 'credit-1', attempts: 1 } })],
      writeOffRows: [{ id: 'wo-1', invoiceId: 'inv-9', xeroCreditNoteId: 'credit-1', status: 'FAILED', invoiceStatus: 'BAD_DEBT' }],
      links: LINKS,
      values: WRITING,
    });
    expect(await again.sender.run(ORG, TENANT)).toMatchObject({ writeOffs: { sent: 1 } });
    expect(calls(again.client, '/CreditNotes')).toHaveLength(0);
    expect(again.client.put.mock.calls[0]![2]).toBe('/CreditNotes/credit-1/Allocations');
  });

  it('takes a write-off back for an invoice reopened here, before anything else: allocation off, credit note voided', async () => {
    const edited = invoice({
      inspection: { scheduledAt: new Date('2026-12-01T00:00:00.000Z'), assignments: [] },
      xeroSync: { xeroTenantId: TENANT, status: 'SENT', sentFingerprint: invoiceFingerprint(invoice()), xeroInvoiceId: 'xero-8440', attempts: 0 },
    });
    const { sender, client, writeOffRows } = harness({ invoices: [edited], writeOffRows: [writtenOff()], values: WRITING });
    // The invoice itself is not sent again (2026-11-12): only its write-off comes off.
    expect(await sender.run(ORG, TENANT)).toMatchObject({ sent: 0, unchanged: 1, writeOffs: { sent: 0, failed: 0, reversed: 1 } });
    expect(client.delete).toHaveBeenCalledWith(ORG, TENANT, '/CreditNotes/credit-old/Allocations/allocation-old', expect.anything());
    const [voided] = calls(client, '/CreditNotes');
    expect(voided![3]).toEqual({ CreditNotes: [{ CreditNoteID: 'credit-old', Status: 'VOIDED' }] });
    expect(calls(client, '/Invoices')).toHaveLength(0);
    expect(writeOffRows).toEqual([]);
  });

  it('finds the allocation in Xero when Xero did not say its id', async () => {
    const { sender, client } = harness({ invoices: [], candidates: [], writeOffRows: [writtenOff({ xeroAllocationId: null })], values: WRITING });
    await sender.run(ORG, TENANT);
    expect(client.get).toHaveBeenCalledWith(ORG, TENANT, '/CreditNotes/credit-old', expect.anything());
    expect(client.delete).toHaveBeenCalledWith(ORG, TENANT, '/CreditNotes/credit-old/Allocations/allocation-found', expect.anything());
  });

  it('only forgets a write-off that never reached Xero', async () => {
    const { sender, client, writeOffRows } = harness({
      invoices: [],
      candidates: [],
      writeOffRows: [writtenOff({ xeroCreditNoteId: null, xeroAllocationId: null, status: 'FAILED', nextAttemptAt: null })],
      values: WRITING,
    });
    await sender.run(ORG, TENANT);
    expect(client.delete).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
    expect(writeOffRows).toEqual([]);
  });

  it('keeps one Xero would not take back, with why, and tries again later', async () => {
    const { sender, client, writeOffRows } = harness({ invoices: [], candidates: [], writeOffRows: [writtenOff()], values: WRITING });
    client.delete.mockRejectedValueOnce(new XeroError('Xero refused it: The credit note is reconciled', 'XERO_VALIDATION', 422, 400));
    expect(await sender.run(ORG, TENANT)).toMatchObject({ writeOffs: { failed: 1, reversed: 0 } });
    expect(writeOffRows[0]).toMatchObject({
      status: 'FAILED',
      problem: 'Reopened here, but Xero would not take the write-off back: Xero refused it: The credit note is reconciled',
      nextAttemptAt: expect.any(Date),
    });
  });

  it('counts the bad debts written off and refused, and lists the refused', async () => {
    const { sender } = harness({
      writeOffRows: [
        writtenOff({ id: 'wo-2', invoiceId: 'inv-8' }),
        writtenOff({ status: 'FAILED', problem: 'Amount exceeds the amount due', invoice: { number: '8449', clientName: '12 Example Lane', status: 'BAD_DEBT' } }),
      ],
    });
    const view = await sender.view(ORG, TENANT);
    expect(view.counts.writeOffs).toEqual({ sent: 1, failed: 1 });
    expect(view.writeOffFailures).toEqual([
      expect.objectContaining({ invoiceId: 'inv-9', number: '8449', amountCents: 17500, reversing: false, problem: 'Amount exceeds the amount due' }),
    ]);
  });
});

describe('already in Xero, made by Zapier or by hand (2026-11-11)', () => {
  const theirs = (over: Record<string, unknown> = {}) => ({ InvoiceID: 'zap-1', InvoiceNumber: '8440', Type: 'ACCREC', Status: 'AUTHORISED', Contact: { Name: '12 Example Lane' }, ...over });

  it('links one Xero has approved under the same number, leaving it as it is, and makes no second', async () => {
    const { sender, client, syncs, prisma } = harness({ inXero: [theirs() as never] });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ sent: 0, linked: 1, failed: 0 });
    expect(calls(client, '/Invoices')).toHaveLength(0);
    expect(syncs.get('inv-1')).toMatchObject({ status: 'SENT', xeroInvoiceId: 'zap-1', sentFingerprint: invoiceFingerprint(invoice()) });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ metadata: expect.objectContaining({ linked: 1 }) }) });
  });

  it('links a draft Xero has as it is, sending nothing over it: the office may have put it on its project (2026-11-12)', async () => {
    const { sender, client, syncs } = harness({ inXero: [theirs({ Status: 'DRAFT' }) as never] });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ sent: 0, linked: 1 });
    expect(calls(client, '/Invoices')).toHaveLength(0);
    expect(syncs.get('inv-1')).toMatchObject({ status: 'SENT', xeroInvoiceId: 'zap-1' });
  });

  it('holds one back whose number Xero gave another client, or two invoices', async () => {
    const other = harness({ inXero: [theirs({ Contact: { Name: '14 Example Lane' } }) as never] });
    expect(await other.sender.run(ORG, TENANT)).toMatchObject({ sent: 0, failed: 1 });
    expect(other.syncs.get('inv-1')).toMatchObject({ status: 'FAILED', problem: 'Xero has invoice 8440 for “14 Example Lane”, not this client: renumber one of them.' });
    expect(calls(other.client, '/Invoices')).toHaveLength(0);

    const twice = harness({ inXero: [theirs() as never, theirs({ InvoiceID: 'zap-2' }) as never] });
    expect(await twice.sender.run(ORG, TENANT)).toMatchObject({ failed: 1 });
    expect(twice.syncs.get('inv-1')).toMatchObject({ problem: 'Xero has 2 invoices numbered 8440: void the extra one there.' });
  });

  it('does not ask about one Xero already has from the console', async () => {
    const { sender, client } = harness({ invoices: [inXero({ totalCents: 17500, inspection: { scheduledAt: new Date('2026-12-01T00:00:00.000Z'), assignments: [] } })] });
    await sender.run(ORG, TENANT);
    expect(client.get.mock.calls.filter(([, , path]) => (path as string).startsWith('/Invoices?InvoiceNumbers='))).toHaveLength(0);
  });
});

describe('payments, to the invoice’s company’s books (2026-11-10)', () => {
  it('sends none while the office records them in Xero itself (2026-11-11)', async () => {
    const { sender, client, paymentRows } = harness({ invoices: [inXero()], candidates: [], payments: [payment()], values: { ...PAYING, paymentsToXero: false } });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ payments: { sent: 0, failed: 0, removed: 0 }, problem: null });
    expect(calls(client, '/Payments')).toHaveLength(0);
    expect(paymentRows).toEqual([]);
  });

  it('sends a new payment against its invoice in Xero, with an idempotency key, and keeps what Xero answered', async () => {
    const { sender, client, prisma, paymentRows } = harness({ invoices: [inXero()], candidates: [], payments: [payment()], values: PAYING });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ sent: 0, payments: { sent: 1, failed: 0, removed: 0 }, problem: null });
    const [made] = calls(client, '/Payments');
    expect(made![2]).toBe('/Payments?summarizeErrors=false');
    expect(made![3]).toEqual({ Payments: [{ Invoice: { InvoiceID: 'xero-8440' }, Account: { AccountID: 'a-090' }, Date: '2026-12-03', Amount: 175, Reference: '1042' }] });
    expect(made![5]).toMatch(/^[0-9a-f]{64}$/);
    expect(paymentRows).toEqual([expect.objectContaining({ paymentId: 'pay-1', invoiceId: 'inv-1', xeroTenantId: TENANT, xeroPaymentId: 'xero-payment-1', status: 'SENT' })]);
    // Only this organisation's invoices, as they are in its books now.
    const sql = prisma.$queryRaw.mock.calls.map(([strings]) => strings.join('?')).find((text) => text.includes('"InvoicePayment"'))!;
    expect(sql).toContain('i."xeroTenantId" = ?');
    expect(sql).toContain(`s."status" = 'SENT'`);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'XERO_INVOICES_SENT', metadata: expect.objectContaining({ payments: { sent: 1, failed: 0, removed: 0 } }) }) });
  });

  it('calls Xero not at all for a payment that has not changed', async () => {
    const { sender, client, paymentRows } = harness({ invoices: [inXero()], candidates: [], payments: [payment()], paymentRows: [sentRow()], values: PAYING });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ payments: { sent: 0, failed: 0, removed: 0 } });
    expect(client.post).not.toHaveBeenCalled();
    expect(paymentRows[0]).toMatchObject({ seenUpdatedAt: UPDATED, xeroPaymentId: 'xero-payment-old' });
  });

  it('holds back a payment whose method has no account, without calling Xero, until it or the choices change', async () => {
    const { sender, client, paymentRows } = harness({ invoices: [inXero()], candidates: [], payments: [payment({ method: 'ZELLE' })], values: PAYING });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ payments: { sent: 0, failed: 1, removed: 0 } });
    expect(client.post).not.toHaveBeenCalled();
    expect(paymentRows[0]).toMatchObject({ status: 'FAILED', nextAttemptAt: null, problem: 'Choose the Xero account Zelle payments land in, under “Before anything is sent”.' });
  });

  it('deletes a changed payment in Xero, then sends it again as it is now: Xero never edits one', async () => {
    const changed = payment({ amountCents: 10000 });
    const { sender, client, paymentRows } = harness({ invoices: [inXero()], candidates: [], payments: [changed], paymentRows: [sentRow()], values: PAYING });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ payments: { sent: 1, failed: 0, removed: 0 } });
    expect(client.post.mock.calls.map(([, , path, body]) => [path, body])).toEqual([
      ['/Payments/xero-payment-old', { Status: 'DELETED' }],
      ['/Payments?summarizeErrors=false', { Payments: [expect.objectContaining({ Amount: 100 })] }],
    ]);
    expect(paymentRows[0]).toMatchObject({ status: 'SENT', xeroPaymentId: 'xero-payment-1', sentFingerprint: paymentFingerprint(changed) });
  });

  it('deletes in Xero a payment removed here, before anything else, and forgets it', async () => {
    const voided = invoice({
      status: 'VOIDED',
      xeroSync: { xeroTenantId: TENANT, status: 'SENT', sentFingerprint: invoiceFingerprint(invoice()), xeroInvoiceId: 'xero-8440', attempts: 0 },
    });
    // The payment was removed, then the invoice voided: the payment comes off in Xero; voiding the invoice there is the office's (2026-11-12).
    const { sender, client, paymentRows } = harness({ invoices: [voided], paymentRows: [sentRow({ paymentId: null })], values: PAYING });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ sent: 0, payments: { sent: 0, failed: 0, removed: 1 } });
    expect(client.post.mock.calls.map(([, , path]) => path)).toEqual(['/Payments/xero-payment-old']);
    expect(paymentRows).toEqual([]);
  });

  it('keeps one Xero would not delete, with why, and tries again later', async () => {
    const { sender, client, paymentRows } = harness({ invoices: [inXero()], candidates: [], paymentRows: [sentRow({ paymentId: null })], values: PAYING });
    client.post.mockResolvedValueOnce({ Payments: [{ PaymentID: 'xero-payment-old', StatusAttributeString: 'ERROR', ValidationErrors: [{ Message: 'Payment is reconciled' }] }] });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ payments: { sent: 0, failed: 1, removed: 0 } });
    expect(paymentRows[0]).toMatchObject({ status: 'FAILED', problem: 'Removed here, but Xero would not delete it: Payment is reconciled', nextAttemptAt: expect.any(Date) });
  });

  it('leaves alone the payments on an invoice changed here after it went: the invoice is not changed in Xero (2026-11-12)', async () => {
    const edited = invoice({
      inspection: { scheduledAt: new Date('2026-12-01T00:00:00.000Z'), assignments: [] },
      xeroSync: { xeroTenantId: TENANT, status: 'SENT', sentFingerprint: invoiceFingerprint(invoice()), xeroInvoiceId: 'xero-8440', attempts: 0 },
    });
    const { sender, client, paymentRows } = harness({ invoices: [edited], payments: [payment()], paymentRows: [sentRow()], values: PAYING });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ sent: 0, unchanged: 1, payments: { sent: 0, failed: 0, removed: 0 } });
    expect(client.post).not.toHaveBeenCalled();
    expect(paymentRows).toEqual([expect.objectContaining({ paymentId: 'pay-1', xeroPaymentId: 'xero-payment-old', status: 'SENT' })]);
  });

  it('counts this organisation’s payments in Xero and refused, and lists the refused', async () => {
    const refusedRow = sentRow({
      status: 'FAILED',
      problem: 'Payment exceeds the amount due',
      attempts: 2,
      payment: { amountCents: 17500, paidOn: new Date('2026-12-03T00:00:00.000Z') },
      invoice: { number: '8440', clientName: '12 Example Lane' },
    });
    const { sender } = harness({ paymentRows: [sentRow({ id: 'ps-2', paymentId: 'pay-2' }), refusedRow] });
    const view = await sender.view(ORG, TENANT);
    expect(view.counts.payments).toEqual({ sent: 1, failed: 1 });
    expect(view.paymentFailures).toEqual([
      expect.objectContaining({ paymentId: 'pay-1', number: '8440', clientName: '12 Example Lane', amountCents: 17500, paidOn: '2026-12-03', problem: 'Payment exceeds the amount due', attempts: 2 }),
    ]);
  });
});

describe('a company whose visits get projects (2026-11-11)', () => {
  const PROJECTS: XeroSettingsValues = { ...SETTINGS, paymentsToXero: false, projectsEnabled: true, projectUserId: 'user-1', labourRateCents: 3500, labourMinutes: 6 };
  const plan = () => xeroInvoiceFrom(invoice(), { settings: PROJECTS, accounts: ACCOUNTS, contactId: 'contact-1', asDraft: true });

  it('sends a new invoice as a draft, for the office to put its line on the project and approve', () => {
    const sent = plan();
    expect(sent.kind === 'send' && sent.body.Status).toBe('DRAFT');
  });

  it('sends drafts, then makes the projects, with the company’s choices and currency -- and sends no payment', async () => {
    const { sender, client, projects, prisma } = harness({ values: { ...PROJECTS, paymentsToXero: true }, payments: [payment()], paymentRows: [] });
    // As the service does: filling the result it is given, as it goes.
    projects.run.mockImplementationOnce(async (...args: unknown[]) => Object.assign(args[5] as object, { made: 1, linked: 1, failed: 0, names: ['Ada: Move-out inspection - 12.02.2026'] }));
    const result = await sender.run(ORG, TENANT);
    expect(calls(client, '/Invoices')[0]![3]).toMatchObject({ Invoices: [{ InvoiceNumber: '8440', Status: 'DRAFT' }] });
    expect(projects.run).toHaveBeenCalledWith(ORG, TENANT, '2026-12-01', expect.objectContaining({ projectsEnabled: true }), 'USD', expect.any(Object));
    expect(result.projects).toEqual({ made: 1, linked: 1, failed: 0 });
    // Xero takes no payment on a draft.
    expect(calls(client, '/Payments')).toHaveLength(0);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'XERO_INVOICES_SENT',
        metadata: expect.objectContaining({ projects: { made: 1, linked: 1, failed: 0, names: ['Ada: Move-out inspection - 12.02.2026'] } }),
      }),
    });
  });

  it('counts the projects made before a run stopped', async () => {
    const { sender, projects } = harness({ values: PROJECTS });
    projects.run.mockImplementationOnce(async (...args: unknown[]) => {
      const into = args[5] as { made: number; names: string[] };
      into.made = 2;
      into.names.push('Ada: one', 'Ada: two');
      throw new XeroError('The console has used its 300 calls to this Xero organisation today. More can go tomorrow.', 'XERO_DAILY_CEILING', 429);
    });
    const result = await sender.run(ORG, TENANT);
    expect(result.projects.made).toBe(2);
    expect(result.problem).toMatch(/300 calls/);
  });

  it('makes no project while projects are off', async () => {
    const { sender, projects, client } = harness();
    await sender.run(ORG, TENANT);
    expect(projects.run).not.toHaveBeenCalled();
    expect(calls(client, '/Invoices')[0]![3]).toMatchObject({ Invoices: [{ Status: 'AUTHORISED' }] });
  });

  it('deletes or voids nothing in Xero, draft or approved: voided here after it went, it is marked for the office (2026-11-12)', async () => {
    const voided = (id: string, number: string) =>
      invoice({
        id,
        number,
        status: 'VOIDED',
        xeroSync: { xeroTenantId: TENANT, status: 'SENT', sentFingerprint: invoiceFingerprint(invoice({ id, number })), xeroInvoiceId: `xero-${number}`, attempts: 0 },
      });
    const { sender, client, prisma } = harness({
      values: PROJECTS,
      invoices: [voided('inv-1', '8440'), voided('inv-2', '8441')],
      inXero: [
        { InvoiceID: 'xero-8440', InvoiceNumber: '8440', Status: 'DRAFT' },
        { InvoiceID: 'xero-8441', InvoiceNumber: '8441', Status: 'AUTHORISED' },
      ],
    });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ sent: 0, failed: 0, unchanged: 2 });
    expect(client.post).not.toHaveBeenCalled();
    expect(client.get).not.toHaveBeenCalled();
    for (const invoiceId of ['inv-1', 'inv-2'])
      expect(prisma.xeroInvoiceSync.update).toHaveBeenCalledWith({ where: { invoiceId }, data: expect.objectContaining({ status: 'SENT', changedHereAt: expect.any(Date) }) });
  });

  it('waits for a connection that may make projects', async () => {
    const { sender, client, projects } = harness({
      values: PROJECTS,
      connection: { status: 'CONNECTED', xeroTenantId: TENANT, scopes: XERO_SEND_SCOPES.split(' ').filter((scope) => scope !== 'projects'), invoiceRemindersOn: false, accounts: ACCOUNTS },
    });
    const result = await sender.run(ORG, TENANT);
    expect(result.problem).toBe('Connect again, so Xero lets the console make projects.');
    expect(client.post).not.toHaveBeenCalled();
    expect(projects.run).not.toHaveBeenCalled();
  });

  it('says on the page that each visit gets a project, with the counts and refusals', async () => {
    const { sender, projects } = harness({ values: PROJECTS });
    projects.summary.mockResolvedValueOnce({
      done: 4,
      failed: 1,
      failures: [{ inspectionId: 'visit-1', name: 'Ada: Move Out Inspection - 12.02.2026', problem: 'Xero refused it.', attempts: 1, lastAttemptAt: null, nextAttemptAt: null }],
    } as never);
    const view = await sender.view(ORG, TENANT);
    expect(view.projectsEnabled).toBe(true);
    expect(view.counts.projects).toEqual({ done: 4, failed: 1 });
    expect(view.projectFailures).toHaveLength(1);
  });
});

describe('a run', () => {
  it('makes the contact, sends the invoice approved with an idempotency key, and keeps what Xero answered', async () => {
    const { sender, client, prisma, syncs, settingsRow } = harness();
    expect(await sender.run(ORG, TENANT)).toEqual({
      sent: 1,
      failed: 0,
      unchanged: 0,
      linked: 0,
      payments: { sent: 0, failed: 0, removed: 0 },
      writeOffs: { sent: 0, failed: 0, reversed: 0 },
      // No project for each visit while projects are off (2026-11-11).
      projects: { made: 0, linked: 0, failed: 0 },
      problem: null,
    });
    expect(calls(client, '/Contacts')).toHaveLength(1);
    expect(calls(client, '/Contacts')[0]![3]).toEqual({ Contacts: [{ Name: '12 Example Lane' }] });
    const [org, tenant, path, body, , key] = calls(client, '/Invoices')[0]!;
    expect([org, tenant, path]).toEqual([ORG, TENANT, '/Invoices?summarizeErrors=false']);
    expect((body as { Invoices: { Status: string; Contact: unknown }[] }).Invoices[0]).toMatchObject({ Status: 'AUTHORISED', Contact: { ContactID: 'contact-0-12 Example Lane' } });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // Asked first whether Xero has it already, by its number (2026-11-11): one call for up to 50.
    expect(client.get).toHaveBeenCalledWith(ORG, TENANT, '/Invoices?InvoiceNumbers=8440&Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID&summaryOnly=true', expect.anything());
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
    expect(same.prisma.xeroInvoiceSync.update).toHaveBeenCalledWith({
      where: { invoiceId: 'inv-1' },
      data: { status: 'SENT', seenUpdatedAt: UPDATED, attempts: 0, nextAttemptAt: null, problem: null, changedHereAt: null },
    });
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

  describe('each invoice goes once (2026-11-12)', () => {
    const SENT_ROW = { xeroTenantId: TENANT, status: 'SENT', sentFingerprint: invoiceFingerprint(invoice()), xeroInvoiceId: 'xero-8440', attempts: 0 };

    it('never sends again one in Xero changed here since: it is marked, for the office to make the change in Xero', async () => {
      const { sender, client, prisma } = harness({ invoices: [invoice({ clientName: '12 Example Lane, Unit B', xeroSync: SENT_ROW })] });
      expect(await sender.run(ORG, TENANT)).toMatchObject({ sent: 0, failed: 0, linked: 0, unchanged: 1 });
      expect(client.post).not.toHaveBeenCalled();
      expect(client.get).not.toHaveBeenCalled();
      expect(prisma.xeroInvoiceSync.update).toHaveBeenCalledWith({
        where: { invoiceId: 'inv-1' },
        data: { status: 'SENT', seenUpdatedAt: UPDATED, attempts: 0, nextAttemptAt: null, problem: null, changedHereAt: new Date('2026-12-02T18:00:00.000Z') },
      });
      // Nothing happened in Xero: no audit entry for the run.
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('keeps when it was first seen changed, and unmarks it once it says again what went', async () => {
      const since = new Date('2026-12-01T09:00:00.000Z');
      const still = harness({ invoices: [invoice({ clientName: '12 Example Lane, Unit B', xeroSync: { ...SENT_ROW, changedHereAt: since } })] });
      await still.sender.run(ORG, TENANT);
      expect(still.prisma.xeroInvoiceSync.update).toHaveBeenCalledWith({ where: { invoiceId: 'inv-1' }, data: expect.objectContaining({ changedHereAt: since }) });
      const back = harness({ invoices: [invoice({ xeroSync: { ...SENT_ROW, changedHereAt: since } })] });
      await back.sender.run(ORG, TENANT);
      expect(back.prisma.xeroInvoiceSync.update).toHaveBeenCalledWith({ where: { invoiceId: 'inv-1' }, data: expect.objectContaining({ changedHereAt: null }) });
    });

    it('voids nothing in Xero: one voided here after it went is marked, the office voids it there', async () => {
      const { sender, client, prisma } = harness({ invoices: [invoice({ status: 'VOIDED', xeroSync: SENT_ROW })] });
      await sender.run(ORG, TENANT);
      expect(client.post).not.toHaveBeenCalled();
      expect(prisma.xeroInvoiceSync.update).toHaveBeenCalledWith({ where: { invoiceId: 'inv-1' }, data: expect.objectContaining({ changedHereAt: expect.any(Date) }) });
    });

    it('lets go of a refusal from before, when changes went: the invoice is in Xero, nothing is tried again', async () => {
      const refused = { ...SENT_ROW, status: 'FAILED', attempts: 2, problem: 'Its payments could not be taken off in Xero to change it: Payment is reconciled', nextAttemptAt: new Date('2026-12-02T17:00:00.000Z') };
      const { sender, client, prisma } = harness({ invoices: [invoice({ clientName: '12 Example Lane, Unit B', xeroSync: refused })] });
      expect(await sender.run(ORG, TENANT)).toMatchObject({ sent: 0, failed: 0 });
      expect(client.post).not.toHaveBeenCalled();
      expect(prisma.xeroInvoiceSync.update).toHaveBeenCalledWith({
        where: { invoiceId: 'inv-1' },
        data: expect.objectContaining({ status: 'SENT', attempts: 0, nextAttemptAt: null, problem: null, changedHereAt: expect.any(Date) }),
      });
    });

    it('sends a new one with no id of Xero’s, and a fresh send is not marked', async () => {
      const { sender, client, syncs } = harness();
      await sender.run(ORG, TENANT);
      expect((calls(client, '/Invoices')[0]![3] as { Invoices: Record<string, unknown>[] }).Invoices[0]).not.toHaveProperty('InvoiceID');
      expect(syncs.get('inv-1')).toMatchObject({ status: 'SENT', changedHereAt: null });
    });

    it('counts and lists on the page the invoices changed here since they went, saying which were voided', async () => {
      const { sender, prisma } = harness();
      const rows = [{ invoiceId: 'inv-1', changedHereAt: new Date('2026-12-02T17:00:00.000Z'), invoice: { number: '8440', clientName: '12 Example Lane', status: 'VOIDED' } }];
      prisma.xeroInvoiceSync.count.mockImplementation((async ({ where }: { where: { changedHereAt?: unknown } }) => (where.changedHereAt ? 1 : 0)) as never);
      prisma.xeroInvoiceSync.findMany.mockImplementation((async ({ where }: { where: { changedHereAt?: unknown } }) => (where.changedHereAt ? rows : [])) as never);
      const view = await sender.view(ORG, TENANT);
      expect(view.counts.changedHere).toBe(1);
      expect(view.changedHere).toEqual([{ invoiceId: 'inv-1', number: '8440', clientName: '12 Example Lane', voided: true, changedAt: '2026-12-02T17:00:00.000Z' }]);
      expect(prisma.xeroInvoiceSync.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: ORG, xeroTenantId: TENANT, status: 'SENT', changedHereAt: { not: null } }, take: 50 }),
      );
    });
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
    expect(await busy.sender.run(ORG, TENANT)).toMatchObject({ problem: 'Another run is sending to Xero, or reading from it.' });
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

  it('turns off, once the console makes the invoices, only when the office says it means it (2026-11-13)', async () => {
    const on = { sendingEnabled: true, sendFrom: new Date('2026-12-01T00:00:00.000Z') };
    const asked = harness({ takenOver: true, settingsRow: on });
    await expect(asked.sender.setEnabled(office, TENANT, false)).rejects.toMatchObject({ code: 'XERO_SENDING_OFF_UNCONFIRMED' });
    expect(asked.prisma.xeroSettings.update).not.toHaveBeenCalled();
    expect(await asked.sender.view(ORG, TENANT)).toMatchObject({ madeInConsole: true });

    const meant = harness({ takenOver: true, settingsRow: on });
    await meant.sender.setEnabled(office, TENANT, false, true);
    expect(meant.prisma.xeroSettings.update).toHaveBeenCalledWith(expect.objectContaining({ data: { sendingEnabled: false, sendingChangedAt: expect.any(Date) } }));
    expect(meant.prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'XERO_SENDING_TURNED_OFF', actorUserId: office.id }) });

    // Before the switch, off needs no more than the dialog.
    const before = harness({ settingsRow: on });
    await before.sender.setEnabled(office, TENANT, false);
    expect(before.prisma.xeroSettings.update).toHaveBeenCalled();
    expect(await before.sender.view(ORG, TENANT)).toMatchObject({ madeInConsole: false });
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
    // And every refused payment (2026-11-10, phase 4).
    expect(prisma.xeroPaymentSync.updateMany).toHaveBeenCalledWith({ where: { organizationId: ORG, xeroTenantId: TENANT, status: 'FAILED' }, data: { nextAttemptAt: expect.any(Date), seenUpdatedAt: null } });
    expect(prisma.xeroWriteOffSync.updateMany).toHaveBeenCalledWith({ where: { organizationId: ORG, xeroTenantId: TENANT, status: 'FAILED' }, data: { nextAttemptAt: expect.any(Date) } });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'XERO_SENDING_RETRIED', metadata: { tenantId: TENANT, invoices: 2, payments: 2, writeOffs: 2, projects: 0 } }),
    });
  });

  it('is seen with integrations:read and run with integrations:manage', () => {
    const permissions = (method: keyof XeroController) => Reflect.getMetadata(PERMISSIONS_METADATA_KEY, XeroController.prototype[method]);
    expect(permissions('sending')).toEqual(['integrations:read']);
    for (const method of ['setSending', 'runSending', 'retrySending'] as const) expect(permissions(method)).toEqual(['integrations:manage']);
  });
});

describe('what came back from Xero stays there (2026-11-12)', () => {
  it('never sends an invoice read from the company’s books, a console one read back from there, or a payment Xero has', async () => {
    const { sender, prisma } = harness({ candidates: [], paymentCandidates: [] });
    await sender.run(ORG, TENANT);
    const sql = prisma.$queryRaw.mock.calls.map(([strings]) => (strings as TemplateStringsArray).join('?'));
    const invoices = sql.find((text) => !text.includes('"InvoicePayment"'))!;
    expect(invoices).toContain(`i."origin" <> 'XERO'`);
    expect(invoices).toContain(`i."xeroInvoiceId" IS NULL`);
    const payments = sql.find((text) => text.includes('"InvoicePayment"'))!;
    expect(payments).toContain(`p."origin" <> 'XERO'`);
    expect(payments).toContain(`p."xeroPaymentId" IS NULL`);
  });

  it('counts none of them among those still to send', async () => {
    const { sender, prisma } = harness();
    await sender.view(ORG, TENANT);
    const counted = prisma.invoice.count.mock.calls as unknown as [{ where: Record<string, unknown> }][];
    expect(counted.length).toBeGreaterThan(0);
    for (const [args] of counted) expect(args.where).toMatchObject({ origin: { not: 'XERO' } });
  });
});

describe('a company whose books are read from Xero (2026-11-12)', () => {
  const read = { sendingEnabled: true, sendFrom: new Date('2026-12-01T00:00:00.000Z'), sendingClaimedUntil: null, booksReadAt: new Date('2026-11-12T22:05:00.000Z') };

  it('sends no payment from here: they are recorded in Xero, and read back', async () => {
    const { sender, client, paymentRows } = harness({ invoices: [inXero()], candidates: [], payments: [payment()], values: PAYING, settingsRow: read });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ payments: { sent: 0, failed: 0, removed: 0 }, problem: null });
    expect(calls(client, '/Payments')).toHaveLength(0);
    expect(paymentRows).toEqual([]);
  });

  it('writes off no bad debt from here: the office does that in Xero, and the console reads it back', async () => {
    const { sender, client, writeOffRows } = harness({ invoices: [], candidates: [], badDebts: [badDebt()], links: LINKS, values: WRITING, settingsRow: read });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ writeOffs: { sent: 0, failed: 0, reversed: 0 }, problem: null });
    expect(calls(client, '/CreditNotes')).toHaveLength(0);
    expect(writeOffRows).toEqual([]);
  });

  it('lets Xero’s own reminders be on: the console sends that company no follow-ups', async () => {
    const reminders = harness({
      settingsRow: read,
      connection: { status: 'CONNECTED', xeroTenantId: TENANT, scopes: XERO_SEND_SCOPES.split(' '), invoiceRemindersOn: true, accounts: ACCOUNTS },
    });
    expect((await reminders.sender.view(ORG, TENANT)).blockers).toEqual([]);
    expect((await reminders.sender.run(ORG, TENANT)).problem).toBeNull();
  });
});

describe('the console’s own invoices, made once in Xero as drafts (2026-11-12)', () => {
  const draft = (over: Partial<Fixture> & Record<string, unknown> = {}) =>
    invoice({ id: 'console-1', origin: 'CONSOLE', number: null, status: 'DRAFT', jobberClientId: null, propertywareBuildingId: 'building-1', ...over } as Partial<Fixture>);
  const LINKED = [{ clientKey: 'property:building-1', xeroContactId: 'contact-9' }];

  it('makes each by PUT, as a draft Xero numbers, linked back to its page, written down before the call', async () => {
    const { sender, client, prisma, syncs } = harness({ invoices: [draft()], links: LINKED });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ sent: 1, failed: 0, problem: null });
    expect(calls(client, '/Invoices')).toHaveLength(0);
    const [, , path, body] = client.put.mock.calls[0]!;
    expect(path).toBe('/Invoices?summarizeErrors=false');
    const made = (body as { Invoices: Record<string, unknown>[] }).Invoices[0]!;
    expect(made).toMatchObject({ Contact: { ContactID: 'contact-9' }, Status: 'DRAFT', Url: 'http://localhost:5454/invoices/console-1', Date: '2026-12-02' });
    expect(made).not.toHaveProperty('InvoiceNumber');
    // PENDING before the call; then Xero's number and id, with the record of the send.
    expect(prisma.xeroInvoiceSync.upsert.mock.calls[0]![0].create).toMatchObject({ status: 'PENDING', xeroInvoiceId: null, attempts: 1 });
    expect(prisma.invoice.update).toHaveBeenCalledWith({ where: { id: 'console-1' }, data: { xeroInvoiceId: 'xero-draft-1', xeroStatus: 'DRAFT', number: 'INV-0101' } });
    expect(syncs.get('console-1')).toMatchObject({ status: 'SENT', xeroInvoiceId: 'xero-draft-1' });
  });

  it('looks for one tried before among its contact’s invoices that day, and links the one linked back to it: never made twice', async () => {
    const pending = { invoiceId: 'console-1', xeroTenantId: TENANT, xeroInvoiceId: null, status: 'PENDING', attempts: 1, seenUpdatedAt: UPDATED };
    const { sender, client, syncs } = harness({
      invoices: [draft({ xeroSync: pending })],
      links: LINKED,
      drafts: [
        { InvoiceID: 'xero-other', InvoiceNumber: 'INV-0098', Url: 'http://localhost:5454/invoices/console-2', Status: 'DRAFT' },
        { InvoiceID: 'xero-made', InvoiceNumber: 'INV-0099', Url: 'http://localhost:5454/invoices/console-1', Status: 'DRAFT' },
      ],
    });
    expect(await sender.run(ORG, TENANT)).toMatchObject({ sent: 0, linked: 1, problem: null });
    expect(client.put).not.toHaveBeenCalled();
    const [, , path] = client.get.mock.calls.find(([, , asked]) => (asked as string).startsWith('/Invoices?ContactIDs='))!;
    expect(decodeURIComponent(path as string)).toContain('ContactIDs=contact-9&where=Date==DateTime(2026,12,2)');
    expect(syncs.get('console-1')).toMatchObject({ status: 'SENT', xeroInvoiceId: 'xero-made' });
  });

  it('makes one tried before that Xero has not got, and leaves one whose answer was lost PENDING, to look for next time', async () => {
    const failed = { invoiceId: 'console-1', xeroTenantId: TENANT, xeroInvoiceId: null, status: 'FAILED', attempts: 1, seenUpdatedAt: null };
    const again = harness({ invoices: [draft({ xeroSync: failed })], links: LINKED, drafts: [] });
    expect(await again.sender.run(ORG, TENANT)).toMatchObject({ sent: 1 });
    expect(again.syncs.get('console-1')).toMatchObject({ status: 'SENT', xeroInvoiceId: 'xero-draft-1' });

    const lost = harness({ invoices: [draft()], links: LINKED });
    lost.client.put.mockRejectedValueOnce(new XeroError('Xero could not be reached. Try again in a moment.', 'XERO_UNREACHABLE', 502));
    expect((await lost.sender.run(ORG, TENANT)).problem).toBe('Xero could not be reached. Try again in a moment.');
    expect(lost.syncs.get('console-1')).toMatchObject({ status: 'PENDING', xeroInvoiceId: null });
  });

  it('goes under its property’s contact, made by name when Xero has none yet; Jobber’s under their clients, as before', async () => {
    expect(clientKeyOf({ jobberClientId: null, clientName: '12 Example Lane', origin: 'CONSOLE', propertywareBuildingId: 'building-1' })).toBe('property:building-1');
    expect(clientKeyOf({ jobberClientId: 'client-1', clientName: '12 Example Lane', origin: 'JOBBER', propertywareBuildingId: 'building-1' })).toBe('jobber:client-1');
    expect(clientKeyOf({ jobberClientId: null, clientName: '12 Example Lane', origin: 'JOBBER', propertywareBuildingId: 'building-1' })).toMatch(/^name:/);
    const { sender, client } = harness({ invoices: [draft()] });
    await sender.run(ORG, TENANT);
    expect(calls(client, '/Contacts')[0]![3]).toEqual({ Contacts: [{ Name: '12 Example Lane' }] });
  });

  it('sends Jobber’s invoices no more once the console makes them', async () => {
    const { sender, prisma } = harness({ takenOver: true, candidates: [] });
    await sender.run(ORG, TENANT);
    const [strings, ...values] = prisma.$queryRaw.mock.calls.find(([asked]) => !(asked as TemplateStringsArray).join('?').includes('"InvoicePayment"'))!;
    expect((strings as TemplateStringsArray).join('?')).toContain(`i."origin" = 'JOBBER' AND ? AND`);
    expect(values).toContain(false);
  });
});

describe('prices that include the tax (2026-11-12)', () => {
  const pestLine = { position: 0, name: 'Pest Control', description: null, quantity: 1, unitPriceCents: 3900, totalCents: 3900 };
  const inclusive = { settings: { ...SETTINGS, salesTaxType: 'TAX001', pricesIncludeTax: true }, accounts: ACCOUNTS, contactId: 'contact-1' };
  const onTop = { ...inclusive, settings: { ...inclusive.settings, pricesIncludeTax: false } };

  it('sends the lines tax-inclusive, so Xero’s total is the invoice’s; tax goes on top otherwise', () => {
    const pest = invoice({ totalCents: 3900, lines: [pestLine] });
    expect(xeroInvoiceFrom(pest, inclusive)).toMatchObject({
      kind: 'send',
      body: { LineAmountTypes: 'Inclusive', LineItems: [expect.objectContaining({ LineAmount: 39, UnitAmount: 39, TaxType: 'TAX001' })] },
    });
    expect(xeroInvoiceFrom(pest, onTop)).toMatchObject({ kind: 'send', body: { LineAmountTypes: 'Exclusive' } });
  });

  it('never puts a tax type’s rate on top of prices that leave it out (2026-11-13): Xero’s total would be more than the console’s', () => {
    const taxRates = [
      { name: 'Texas 8.25%', taxType: 'TAX001', status: 'ACTIVE', effectiveRate: 8.25, appliesToRevenue: true },
      { name: 'Tax Exempt', taxType: 'NONE', status: 'ACTIVE', effectiveRate: 0, appliesToRevenue: true },
    ];
    const filter = invoice({ totalCents: 3999, lines: [{ ...pestLine, name: 'Filter Change', unitPriceCents: 3999, totalCents: 3999 }] });
    expect(xeroInvoiceFrom(filter, { ...onTop, taxRates })).toMatchObject({
      kind: 'problem',
      problem: expect.stringContaining('Its tax type adds 8.25% on top of prices that do not include it'),
    });
    // No tax in the tax type: sent as it is. Prices that include the rate: sent with it inside.
    expect(xeroInvoiceFrom(filter, { ...onTop, settings: { ...onTop.settings, salesTaxType: 'NONE' }, taxRates })).toMatchObject({ kind: 'send' });
    expect(xeroInvoiceFrom(filter, { ...inclusive, taxRates })).toMatchObject({ kind: 'send', body: { LineAmountTypes: 'Inclusive' } });
  });

  it('takes one whose tax is in its total, and still refuses one whose lines do not come to its total', () => {
    const inside = invoice({ taxCents: 297, totalCents: 3900, lines: [pestLine] });
    expect(xeroInvoiceFrom(inside, inclusive)).toMatchObject({ kind: 'send' });
    expect(xeroInvoiceFrom(inside, onTop)).toMatchObject({ kind: 'problem', problem: expect.stringContaining('of sales tax') });
    const added = invoice({ taxCents: 322, totalCents: 4222, lines: [pestLine] });
    expect(xeroInvoiceFrom(added, inclusive)).toMatchObject({ kind: 'problem', problem: expect.stringContaining('Its lines come to $39.00 and its total is $42.22') });
  });

  it('writes a bad debt off the same way: what it still owes, tax and all', () => {
    const context = { settings: { ...WRITING, salesTaxType: 'TAX001', pricesIncludeTax: true }, accounts: ACCOUNTS, contactId: 'contact-1', xeroInvoiceId: 'xero-1', day: '2026-12-02' };
    expect(xeroWriteOffFrom({ number: 'INV-2963', balanceCents: 3900 }, context)).toMatchObject({
      kind: 'send',
      creditNote: { LineAmountTypes: 'Inclusive', LineItems: [expect.objectContaining({ LineAmount: 39, TaxType: 'TAX001' })] },
    });
  });
});

describe('each product keeps its own Xero choices (2026-11-13, PR 4 of the invoicing audit)', () => {
  const sent = (settings: XeroSettingsValues, over: Partial<Fixture> = {}) => xeroInvoiceFrom(invoice(over), { settings, accounts: ACCOUNTS, contactId: 'contact-1' });
  const product = (nameKey: string, xeroAccountId: string | null) => ({ nameKey, xeroAccountId, xeroItemCode: null, xeroTrackingGroup: null });

  it('sends Xero the very same invoice whether a product’s account was kept by its name or on the product', () => {
    // As the settings kept it, by name; and as the migration copies it onto the product.
    const byName = { ...SETTINGS, salesAccounts: { 'filter change': 'a-410', 'move-out inspection': 'a-400' } };
    const onProduct = withProductChoices({ ...SETTINGS, salesAccounts: {} }, [product('filter change', 'a-410'), product('move-out inspection', 'a-400')]);
    expect(onProduct.salesAccounts).toEqual(byName.salesAccounts);
    expect(sent(onProduct)).toEqual(sent(byName));
  });

  it('keeps a renamed product’s account: by name alone it went to the default account', () => {
    // "Filter change" renamed "Air filter": the settings' map still says the old name.
    const line = { position: 0, name: 'Air filter', description: null, quantity: 1, unitPriceCents: 2500, totalCents: 2500 };
    const renamed = { lines: [line], totalCents: 2500 };
    const accountOf = (plan: ReturnType<typeof sent>) => (plan.kind === 'send' ? plan.body.LineItems[0]?.AccountCode : null);
    expect(accountOf(sent(SETTINGS, renamed))).toBe('400');
    expect(accountOf(sent(withProductChoices(SETTINGS, [product('air filter', 'a-410')]), renamed))).toBe('410');
  });
});

describe('the Xero-style New invoice (2026-11-13, PR B): Xero is sent what the form shows', () => {
  const CATEGORIES: XeroTrackingCategory[] = [
    {
      trackingCategoryId: 'cat-1',
      name: 'Income by Employee',
      status: 'ACTIVE',
      options: [
        { optionId: 'o-1', name: 'Air Filter Income: Moses', status: 'ACTIVE' },
        { optionId: 'o-2', name: 'HVAC Inspection Income: Moses', status: 'ACTIVE' },
      ],
    },
    { trackingCategoryId: 'cat-2', name: 'Expenses', status: 'ACTIVE', options: [{ optionId: 'e-1', name: 'Truck', status: 'ACTIVE' }] },
  ];
  const ITEMS: XeroItem[] = [{ itemId: 'i-1', code: 'HVAC', name: 'HVAC', isSold: true }];
  const TAX_RATES = [
    { name: 'Tax Exempt', taxType: 'NONE', status: 'ACTIVE', effectiveRate: 0, appliesToRevenue: true },
    { name: 'Texas 8.25%', taxType: 'TAX001', status: 'ACTIVE', effectiveRate: 8.25, appliesToRevenue: true },
  ];
  const settings: XeroSettingsValues = { ...SETTINGS, trackingCategoryId: 'cat-1', trackingGroups: { 'filter change': 'Air Filter Income' } };
  const context = { settings, accounts: ACCOUNTS, trackingCategories: CATEGORIES, items: ITEMS, taxRates: TAX_RATES, contactId: 'contact-1' };
  const filter = { position: 1, name: 'Filter change', description: null, quantity: 1, unitPriceCents: 2500, totalCents: 2500 };
  const visitInvoice = (over: Partial<Fixture> = {}) => invoice({ technicianName: 'Moses Example', visitDay: '2026-11-30', ...over });
  const lineOf = (plan: ReturnType<typeof xeroInvoiceFrom>, index = 1) => (plan.kind === 'send' ? plan.body.LineItems[index] : plan.problem);

  it('sends each line as the form chose: its account, item, tax rate, tracking in two categories, and discount', () => {
    const chosen = {
      ...filter,
      totalCents: 2250,
      discountRate: 10,
      xeroAccountId: 'a-400',
      xeroItemCode: 'HVAC',
      xeroTaxType: 'NONE',
      xeroTracking: [
        { trackingCategoryId: 'cat-1', option: 'HVAC Inspection Income: Moses' },
        { trackingCategoryId: 'cat-2', option: 'Truck' },
      ],
    };
    const plan = xeroInvoiceFrom(visitInvoice({ totalCents: 17250, lines: [invoice().lines[0]!, chosen] }), context);
    expect(lineOf(plan)).toEqual({
      ItemCode: 'HVAC',
      Description: 'Filter change',
      Quantity: 1,
      UnitAmount: 25,
      DiscountRate: 10,
      LineAmount: 22.5,
      AccountCode: '400',
      TaxType: 'NONE',
      Tracking: [
        { TrackingCategoryID: 'cat-1', Name: 'Income by Employee', Option: 'HVAC Inspection Income: Moses' },
        { TrackingCategoryID: 'cat-2', Name: 'Expenses', Option: 'Truck' },
      ],
    });
  });

  it('sends a line it chose nothing for as before: its product’s account and the technician’s option -- and none when it chose no tracking', () => {
    expect(lineOf(xeroInvoiceFrom(visitInvoice(), context))).toEqual({
      Description: 'Filter change',
      Quantity: 1,
      UnitAmount: 25,
      LineAmount: 25,
      AccountCode: '410',
      TaxType: 'NONE',
      Tracking: [{ TrackingCategoryID: 'cat-1', Name: 'Income by Employee', Option: 'Air Filter Income: Moses' }],
    });
    const untracked = visitInvoice({ lines: [invoice().lines[0]!, { ...filter, xeroTracking: [] }] });
    expect(lineOf(xeroInvoiceFrom(untracked, context))).not.toHaveProperty('Tracking');
  });

  it('sends no item for a line the form showed with none, though its product has one', () => {
    const itemed: XeroSettingsValues = { ...settings, itemCodes: { 'filter change': 'HVAC' } };
    expect(lineOf(xeroInvoiceFrom(visitInvoice(), { ...context, settings: itemed }))).toMatchObject({ ItemCode: 'HVAC' });
    const none = visitInvoice({ lines: [invoice().lines[0]!, { ...filter, xeroAccountId: 'a-410', xeroTaxType: 'NONE', xeroItemCode: null }] });
    expect(lineOf(xeroInvoiceFrom(none, { ...context, settings: itemed }))).not.toHaveProperty('ItemCode');
  });

  it('dates it, makes it due and refers to it as the form chose; otherwise on the visit’s day, due at its month’s end, the property', () => {
    const asBefore = xeroInvoiceFrom(visitInvoice(), context);
    expect(asBefore).toMatchObject({ kind: 'send', body: { Date: '2026-11-30', DueDate: '2026-11-30', Reference: '12 Example Lane' } });
    const chosen = xeroInvoiceFrom(
      visitInvoice({ xeroDatesChosen: true, issuedOn: new Date('2026-11-29T00:00:00.000Z'), dueOn: new Date('2026-12-15T00:00:00.000Z'), xeroReference: ' Unit B ' }),
      context,
    );
    expect(chosen).toMatchObject({ kind: 'send', body: { Date: '2026-11-29', DueDate: '2026-12-15', Reference: 'Unit B' } });
  });

  it('goes with no tax when the form says so: no line names a tax type', () => {
    const plan = xeroInvoiceFrom(visitInvoice({ xeroTaxMode: 'NO_TAX' }), context);
    expect(plan).toMatchObject({ kind: 'send', body: { LineAmountTypes: 'NoTax' } });
    expect(plan.kind === 'send' && plan.body.LineItems.every((line) => !('TaxType' in line))).toBe(true);
    // Tax inclusive, chosen on the form for a company whose prices leave it out: the rate goes inside each line.
    const inside = visitInvoice({ xeroTaxMode: 'INCLUSIVE', lines: [invoice().lines[0]!, { ...filter, xeroTaxType: 'TAX001' }] });
    expect(xeroInvoiceFrom(inside, context)).toMatchObject({ kind: 'send', body: { LineAmountTypes: 'Inclusive' } });
    expect(lineOf(xeroInvoiceFrom(inside, context))).toMatchObject({ TaxType: 'TAX001' });
  });

  it.each([
    [{ xeroAccountId: 'a-460' }, 'The account chosen on the invoice for “Filter change” is not an active account in Xero'],
    [{ xeroAccountId: 'a-410', xeroItemCode: 'GONE' }, 'The item “GONE” chosen for “Filter change” is not one Xero sells'],
    [{ xeroTaxType: 'TAX001' }, 'adds 8.25% on top'],
    [{ xeroTaxType: 'OLD' }, 'The tax rate chosen for “Filter change” is not an active one in Xero'],
    [{ xeroTracking: [{ trackingCategoryId: 'cat-1', option: 'Air Filter Income: Nobody' }] }, '“Air Filter Income: Nobody”, chosen for “Filter change”, is not an active tracking option'],
  ])('refuses what Xero does not have, or tax on top, saying which line (%#)', (chosen, problem) => {
    const plan = xeroInvoiceFrom(visitInvoice({ lines: [invoice().lines[0]!, { ...filter, ...chosen }] }), context);
    expect(plan).toMatchObject({ kind: 'problem', problem: expect.stringContaining(problem) });
  });

  it('hashes an invoice from before exactly as it did, so none is taken for changed here -- and one the form made with what it chose', () => {
    const before = invoice();
    const asItWas = createHash('sha256')
      .update(
        JSON.stringify({
          number: '8440',
          voided: false,
          client: 'jobber:client-1',
          clientName: '12 Example Lane',
          day: '2026-12-02',
          technician: null,
          taxCents: 0,
          discountCents: 0,
          totalCents: 17500,
          lines: before.lines.map((line) => [line.name, line.description, line.quantity, line.unitPriceCents, line.totalCents]),
        }),
      )
      .digest('hex');
    expect(invoiceFingerprint(before)).toBe(asItWas);
    expect(invoiceFingerprint({ ...before, xeroReference: null, xeroTaxMode: null, xeroDatesChosen: false })).toBe(asItWas);
    expect(invoiceFingerprint({ ...before, lines: before.lines.map((line) => ({ ...line, discountRate: null, xeroAccountId: null, xeroTracking: null })) })).toBe(asItWas);
    expect(invoiceFingerprint({ ...before, xeroReference: 'Unit B' })).not.toBe(asItWas);
    expect(invoiceFingerprint({ ...before, lines: [before.lines[0]!, { ...before.lines[1]!, xeroAccountId: 'a-400' }] })).not.toBe(asItWas);
  });
});
