import { UserRole, type SaveXeroSettingsInput, type XeroAccount, type XeroTaxRate } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { PERMISSIONS_METADATA_KEY } from '../src/common/auth';
import { XeroController } from '../src/integrations/xero/xero.controller';
import { XeroSettingsService, settingsChanges, valuesFrom, valuesFromInput } from '../src/integrations/xero/xero-settings.service';

/**
 * The office's choices for sending to Xero (2026-11-10, phase 2 of the Xero
 * plan): from which day, to which accounts, with which tax type. Checked
 * against the console's last read of Xero; nothing calls Xero. Everything
 * invented.
 */

const ORG = '90000000-0000-4000-8000-000000000001';
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

const account = (over: Partial<XeroAccount>): XeroAccount => ({
  accountId: 'a-400',
  code: '400',
  name: 'Service revenue',
  type: 'REVENUE',
  class: 'REVENUE',
  status: 'ACTIVE',
  takesPayments: false,
  ...over,
});
const ACCOUNTS: XeroAccount[] = [
  account({}),
  account({ accountId: 'a-410', code: '410', name: 'Repair revenue' }),
  account({ accountId: 'a-460', code: '460', name: 'Old revenue', status: 'ARCHIVED' }),
  account({ accountId: 'a-bank', code: null, name: 'Operating checking', type: 'BANK', class: 'ASSET', takesPayments: true }),
  account({ accountId: 'a-815', code: '815', name: 'Owner funds clearing', type: 'CURRLIAB', class: 'LIABILITY', takesPayments: true }),
];
const TAX_RATES: XeroTaxRate[] = [
  { name: 'Tax Exempt', taxType: 'NONE', status: 'ACTIVE', effectiveRate: 0, appliesToRevenue: true },
  { name: 'Old rate', taxType: 'OLD', status: 'DELETED', effectiveRate: 8, appliesToRevenue: true },
];

const UPDATED = new Date('2026-11-19T15:00:00.000Z');

function database(options: { settings?: Record<string, unknown> | null; connection?: Record<string, unknown> | null } = {}) {
  let settings = options.settings === undefined ? null : options.settings;
  const connection =
    options.connection === undefined
      ? { status: 'CONNECTED', accounts: ACCOUNTS, taxRates: TAX_RATES, catalogReadAt: new Date('2026-11-20T15:00:00.000Z') }
      : options.connection;
  const db = {
    xeroSettings: {
      findUnique: jest.fn(async () => settings),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        settings = { ...data, updatedAt: UPDATED };
        return settings;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { updatedAt: Date }; data: Record<string, unknown> }) => {
        if (!settings || (settings.updatedAt as Date).getTime() !== where.updatedAt.getTime()) return { count: 0 };
        settings = { ...settings, ...data, updatedAt: new Date('2026-11-20T18:00:00.000Z') };
        return { count: 1 };
      }),
    },
    xeroConnection: { findUnique: jest.fn(async () => connection) },
    invoiceProduct: {
      findMany: jest.fn(async () => [
        { id: 'p1', name: 'Move-out inspection', nameKey: 'move-out inspection', description: null, unitPriceCents: 15000, active: true, updatedAt: UPDATED },
        { id: 'p2', name: 'Retired service', nameKey: 'retired service', description: null, unitPriceCents: 5000, active: false, updatedAt: UPDATED },
      ]),
    },
    invoiceLine: {
      groupBy: jest.fn(async () => [
        { name: 'Move-out inspection', unitPriceCents: 15000, _count: { _all: 9 } },
        { name: 'Filter change', unitPriceCents: 2500, _count: { _all: 4 } },
      ]),
    },
    invoice: { count: jest.fn(async () => 12) },
    invoicePayment: {
      groupBy: jest.fn(async () => [
        { method: 'PROPERTYWARE_LEDGER', _count: { _all: 10 } },
        { method: 'CHECK', _count: { _all: 2 } },
      ]),
    },
    auditLog: { create: jest.fn() },
    xeroInvoiceSync: { updateMany: jest.fn(async () => ({ count: 0 })) },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(db)),
    settings: () => settings,
  };
  return db;
}

const service = (db: ReturnType<typeof database>) => new XeroSettingsService(db as never);

const input = (over: Partial<SaveXeroSettingsInput> = {}): SaveXeroSettingsInput => ({
  sendFrom: '2026-12-01',
  salesAccountId: 'a-400',
  salesTaxType: 'NONE',
  salesAccounts: { 'filter change': 'a-410' },
  paymentAccounts: { PROPERTYWARE_LEDGER: 'a-815', CHECK: 'a-bank' },
  expectedUpdatedAt: null,
  ...over,
});

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date('2026-11-20T18:00:00.000Z'),
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'nextTick', 'setImmediate', 'queueMicrotask'],
  });
});
afterEach(() => jest.useRealTimers());

describe('reading the choices', () => {
  it('lists every name a line can carry -- the products list, then what was billed -- and every payment method with its use', async () => {
    const db = database({
      settings: {
        sendFrom: new Date('2026-12-01T00:00:00.000Z'),
        salesAccountId: 'a-400',
        salesTaxType: 'NONE',
        salesAccounts: { 'filter change': 'a-410', 'gutter cleaning': 'a-410' },
        paymentAccounts: { PROPERTYWARE_LEDGER: 'a-815' },
        updatedAt: UPDATED,
      },
    });
    const view = await service(db).read(ORG);

    expect(view.products.map((item) => [item.name, item.listed, item.active, item.accountId])).toEqual([
      ['Move-out inspection', true, true, null],
      ['Retired service', true, false, null],
      // Billed but not on the list.
      ['Filter change', false, true, 'a-410'],
      // On neither any more: its choice still shows.
      ['gutter cleaning', false, false, 'a-410'],
    ]);
    expect(view.payments).toHaveLength(11);
    expect(view.payments[0]).toEqual({ method: 'PROPERTYWARE_LEDGER', accountId: 'a-815', payments: 10 });
    expect(view.payments.find((item) => item.method === 'CHECK')).toEqual({ method: 'CHECK', accountId: null, payments: 2 });
    expect(view.invoicesToSend).toBe(12);
    // Counted from the start date, on invoices that are neither drafts nor voided.
    expect(db.invoice.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ organizationId: ORG, status: { notIn: ['DRAFT', 'VOIDED'] }, issuedOn: { gte: new Date('2026-12-01T00:00:00.000Z') } }),
    });
    expect(view.updatedAt).toBe(UPDATED.toISOString());
  });

  it('says what is missing before anything can be sent', async () => {
    const view = await service(database()).read(ORG);
    expect(view.ready).toBe(false);
    const failing = Object.fromEntries(view.checks.filter((check) => !check.ok).map((check) => [check.key, check.detail]));
    expect(failing).toEqual({
      sendFrom: 'Choose the first day whose invoices go to Xero.',
      salesAccount: 'Choose where a line with no account of its own goes.',
      taxType: 'Choose the tax type every line carries.',
      payments: 'None yet for Propertyware ledger, Check.',
    });
  });

  it('is ready once everything in use has somewhere to go', async () => {
    const db = database({
      settings: {
        sendFrom: new Date('2026-12-01T00:00:00.000Z'),
        salesAccountId: 'a-400',
        salesTaxType: 'NONE',
        salesAccounts: {},
        paymentAccounts: { PROPERTYWARE_LEDGER: 'a-815', CHECK: 'a-bank' },
        updatedAt: UPDATED,
      },
    });
    const view = await service(db).read(ORG);
    expect(view.checks.filter((check) => !check.ok)).toEqual([]);
    expect(view.ready).toBe(true);
  });

  it('flags a chosen account Xero has since archived', async () => {
    const db = database({
      settings: {
        sendFrom: new Date('2026-12-01T00:00:00.000Z'),
        salesAccountId: 'a-400',
        salesTaxType: 'NONE',
        salesAccounts: { 'filter change': 'a-460' },
        paymentAccounts: { PROPERTYWARE_LEDGER: 'a-815', CHECK: 'a-gone' },
        updatedAt: UPDATED,
      },
    });
    const view = await service(db).read(ORG);
    const check = view.checks.find((item) => item.key === 'stillInXero')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toBe('Choose again for 460 Old revenue, an account Xero no longer lists.');
    expect(view.ready).toBe(false);
  });

  it('asks for Xero first while it is not connected', async () => {
    const view = await service(database({ connection: null })).read(ORG);
    expect(view.checks[0]).toEqual({ key: 'connected', label: 'Xero is connected and read', ok: false, detail: 'Connect Xero first.' });
  });
});

describe('saving the choices', () => {
  it('saves the first time, says what changed on the audit trail, and reads back', async () => {
    const db = database();
    const view = await service(db).save(office, input());
    expect(db.xeroSettings.create).toHaveBeenCalledWith({
      data: {
        organizationId: ORG,
        sendFrom: new Date('2026-12-01T00:00:00.000Z'),
        salesAccountId: 'a-400',
        salesTaxType: 'NONE',
        salesAccounts: { 'filter change': 'a-410' },
        paymentAccounts: { PROPERTYWARE_LEDGER: 'a-815', CHECK: 'a-bank' },
      },
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'XERO_SETTINGS_CHANGED',
        entityType: 'XeroSettings',
        actorUserId: office.id,
        metadata: {
          changes: [
            'Start date: none → 2026-12-01',
            'Default sales account: none → 400 Service revenue',
            'Tax type: none → NONE',
            'filter change: the default → 410 Repair revenue',
            'Propertyware ledger: none → 815 Owner funds clearing',
            'Check: none → Operating checking',
          ],
        },
      }),
    });
    expect(view.ready).toBe(true);
    // Phase 3: an invoice held back for its account gets another go with the new choices.
    expect(db.xeroInvoiceSync.updateMany).toHaveBeenCalledWith({ where: { organizationId: ORG, status: 'FAILED' }, data: { nextAttemptAt: expect.any(Date) } });
  });

  it('changes only the row it read: a save in between is refused', async () => {
    const db = database({
      settings: { ...valuesRow(), updatedAt: UPDATED },
    });
    await expect(service(db).save(office, input({ expectedUpdatedAt: '2026-11-18T00:00:00.000Z' }))).rejects.toMatchObject({
      code: 'XERO_SETTINGS_CHANGED',
    });
    await service(db).save(office, input({ salesTaxType: 'NONE', salesAccounts: {}, expectedUpdatedAt: UPDATED.toISOString() }));
    expect(db.xeroSettings.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: ORG, updatedAt: UPDATED } }));
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ metadata: { changes: ['filter change: 410 Repair revenue → the default'] } }),
    });
  });

  it('writes nothing when nothing changed', async () => {
    const db = database({ settings: { ...valuesRow(), updatedAt: UPDATED } });
    await service(db).save(office, input({ expectedUpdatedAt: UPDATED.toISOString() }));
    expect(db.xeroSettings.updateMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ salesAccountId: 'a-bank' }, 'The default sales account is not an active revenue account with a code in Xero.'],
    [{ salesAccountId: 'a-460' }, 'The default sales account is not an active revenue account with a code in Xero.'],
    [{ salesTaxType: 'OLD' }, 'That tax type is not an active one Xero allows on sales.'],
    [{ salesAccounts: { 'filter change': 'a-bank' } }, 'A product or service is given an account that is not an active revenue account with a code in Xero.'],
    [{ salesAccounts: { 'Filter Change': 'a-410' } }, 'A product or service is not named as the list names it.'],
    [{ paymentAccounts: { CHECK: 'a-400' } }, 'Check is given an account that does not take payments in Xero.'],
    [{ paymentAccounts: { BITCOIN: 'a-bank' } as never }, 'That is not a payment method the console knows.'],
    [{ sendFrom: '2026-02-30' }, 'The start date is not a date.'],
    [{ sendFrom: '2028-01-01' }, 'The start date is more than a year away.'],
  ])('refuses %j', async (over, message) => {
    const db = database();
    await expect(service(db).save(office, input(over as Partial<SaveXeroSettingsInput>))).rejects.toMatchObject({
      code: 'XERO_SETTINGS_INVALID',
      message,
    });
    expect(db.xeroSettings.create).not.toHaveBeenCalled();
  });

  it('needs Xero connected and read, since the accounts come from it', async () => {
    await expect(service(database({ connection: null })).save(office, input())).rejects.toMatchObject({ code: 'XERO_NOT_READ' });
    await expect(
      service(database({ connection: { status: 'CONNECTED', accounts: ACCOUNTS, taxRates: TAX_RATES, catalogReadAt: null } })).save(office, input()),
    ).rejects.toMatchObject({ code: 'XERO_NOT_READ' });
  });

  it('never calls Xero: reading and saving use the console’s last read', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    const db = database();
    await service(db).read(ORG);
    await service(db).save(office, input());
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});

describe('the words', () => {
  it('drops blanks, so an empty choice is no choice', () => {
    expect(
      valuesFromInput({
        ...input(),
        sendFrom: ' ',
        salesAccountId: '',
        salesAccounts: { 'filter change': '', 'move-out inspection': 'a-410' },
        paymentAccounts: { CHECK: '' },
      }),
    ).toEqual({ sendFrom: null, salesAccountId: null, salesTaxType: 'NONE', salesAccounts: { 'move-out inspection': 'a-410' }, paymentAccounts: {} });
  });

  it('reads no row as nothing chosen, and ignores what is not a method', () => {
    expect(valuesFrom(null)).toEqual({ sendFrom: null, salesAccountId: null, salesTaxType: null, salesAccounts: {}, paymentAccounts: {} });
    expect(valuesFrom({ ...valuesRow(), paymentAccounts: { CHECK: 'a-bank', NOPE: 'x' } }).paymentAccounts).toEqual({ CHECK: 'a-bank' });
  });

  it('names an account Xero no longer lists without its id', () => {
    const before = valuesFrom(null);
    expect(settingsChanges(before, { ...before, salesAccountId: 'a-missing' }, ACCOUNTS)).toEqual([
      'Default sales account: none → an account Xero no longer lists',
    ]);
  });
});

describe('who may', () => {
  const permissions = (method: keyof XeroController) => Reflect.getMetadata(PERMISSIONS_METADATA_KEY, XeroController.prototype[method]);
  it('reads with integrations:read and saves with integrations:manage', () => {
    expect(permissions('readSettings')).toEqual(['integrations:read']);
    expect(permissions('saveSettings')).toEqual(['integrations:manage']);
  });
});

function valuesRow() {
  return {
    sendFrom: new Date('2026-12-01T00:00:00.000Z'),
    salesAccountId: 'a-400',
    salesTaxType: 'NONE',
    salesAccounts: { 'filter change': 'a-410' } as Record<string, string>,
    paymentAccounts: { PROPERTYWARE_LEDGER: 'a-815', CHECK: 'a-bank' } as Record<string, string>,
  };
}
