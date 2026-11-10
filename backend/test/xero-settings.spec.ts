import { UserRole, type SaveXeroSettingsInput, type XeroAccount, type XeroTaxRate } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { PERMISSIONS_METADATA_KEY } from '../src/common/auth';
import { ValidationPipe } from '@nestjs/common';

import { SaveXeroSettingsDto, XeroController } from '../src/integrations/xero/xero.controller';
import { XeroSettingsService, settingsChanges, valuesFrom, valuesFromInput } from '../src/integrations/xero/xero-settings.service';

/**
 * The office's choices for sending to Xero (2026-11-10, phase 2 of the Xero
 * plan): from which day, to which accounts, with which tax type. Checked
 * against the console's last read of Xero; nothing calls Xero. Everything
 * invented.
 */

const ORG = '90000000-0000-4000-8000-000000000001';
/** The organisation the choices are for: each has its own chart of accounts. */
const TENANT = 'a1000000-0000-4000-8000-000000000001';
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

function database(options: { settings?: Record<string, unknown> | null; organisation?: Record<string, unknown> | null; signedIn?: boolean } = {}) {
  let settings = options.settings === undefined ? null : options.settings;
  const organisation =
    options.organisation === undefined
      ? { name: 'Example Home Services', status: 'CONNECTED', accounts: ACCOUNTS, taxRates: TAX_RATES, catalogReadAt: new Date('2026-11-20T15:00:00.000Z') }
      : options.organisation;
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
    xeroConnection: { findUnique: jest.fn(async () => ({ status: options.signedIn === false ? 'DISCONNECTED' : 'CONNECTED' })) },
    xeroOrganisation: { findUnique: jest.fn(async () => organisation) },
    invoiceProduct: {
      findMany: jest.fn(async () => [
        { id: 'p1', name: 'Move-out inspection', nameKey: 'move-out inspection', description: null, unitPriceCents: 15000, active: true, xeroTenantId: TENANT, updatedAt: UPDATED },
        { id: 'p2', name: 'Retired service', nameKey: 'retired service', description: null, unitPriceCents: 5000, active: false, xeroTenantId: TENANT, updatedAt: UPDATED },
        // Another company's books.
        { id: 'p3', name: 'Pest control', nameKey: 'pest control', description: null, unitPriceCents: 6500, active: true, xeroTenantId: 'a2000000-0000-4000-8000-000000000002', updatedAt: UPDATED },
        // Not chosen yet.
        { id: 'p4', name: 'Gate repair', nameKey: 'gate repair', description: null, unitPriceCents: 12000, active: true, xeroTenantId: null, updatedAt: UPDATED },
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
    xeroPaymentSync: { updateMany: jest.fn(async () => ({ count: 0 })) },
    xeroWriteOffSync: { updateMany: jest.fn(async () => ({ count: 0 })) },
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
  it('lists the services the office sends to this organisation, and every payment method with its use', async () => {
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
    const view = await service(db).read(ORG, TENANT);

    expect(view.products.map((item) => [item.name, item.listed, item.active, item.accountId])).toEqual([
      ['Move-out inspection', true, true, null],
      ['Retired service', true, false, null],
      // Pest control goes to another organisation, and Filter change is only billed: neither is this one's.
      // On neither list any more: its choice still shows.
      ['gutter cleaning', false, false, 'a-410'],
    ]);
    // Gate repair is offered and goes nowhere yet.
    expect(view.withoutOrganisation).toBe(1);
    expect(view.payments).toHaveLength(11);
    expect(view.payments[0]).toEqual({ method: 'PROPERTYWARE_LEDGER', accountId: 'a-815', payments: 10 });
    expect(view.payments.find((item) => item.method === 'CHECK')).toEqual({ method: 'CHECK', accountId: null, payments: 2 });
    expect(view.invoicesToSend).toBe(12);
    // Counted from the start date, on this organisation's invoices that are neither drafts nor voided (2026-11-10).
    const invoices = { organizationId: ORG, xeroTenantId: TENANT, status: { notIn: ['DRAFT', 'VOIDED'] }, issuedOn: { gte: new Date('2026-12-01T00:00:00.000Z') } };
    expect(db.invoice.count).toHaveBeenCalledWith({ where: expect.objectContaining(invoices) });
    // And the payments by method, on the same invoices only.
    expect(db.invoicePayment.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: ORG, invoice: expect.objectContaining(invoices) } }));
    expect(view.updatedAt).toBe(UPDATED.toISOString());
  });

  it('says what is missing before anything can be sent', async () => {
    const view = await service(database()).read(ORG, TENANT);
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
    const view = await service(db).read(ORG, TENANT);
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
    const view = await service(db).read(ORG, TENANT);
    const check = view.checks.find((item) => item.key === 'stillInXero')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toBe('Choose again for 460 Old revenue, an account Xero no longer lists.');
    expect(view.ready).toBe(false);
  });

  it('asks for Xero first while it is not connected', async () => {
    const view = await service(database({ signedIn: false })).read(ORG, TENANT);
    expect(view.checks[0]).toEqual({ key: 'connected', label: 'Xero is connected and read', ok: false, detail: 'Connect Xero first.' });
    const removed = await service(database({ organisation: { name: 'Example Pest Co', status: 'REMOVED', accounts: ACCOUNTS, taxRates: TAX_RATES } })).read(ORG, TENANT);
    expect(removed.checks[0]!.ok).toBe(false);
  });

  it('is each organisation’s own, and refuses one the office does not have', async () => {
    expect((await service(database()).read(ORG, TENANT)).tenantId).toBe(TENANT);
    await expect(service(database({ organisation: null })).read(ORG, TENANT)).rejects.toMatchObject({ code: 'XERO_ORGANISATION_UNKNOWN', status: 404 });
  });
});

describe('saving the choices', () => {
  it('saves the first time, says what changed on the audit trail, and reads back', async () => {
    const db = database();
    const view = await service(db).save(office, TENANT, input());
    expect(db.xeroSettings.create).toHaveBeenCalledWith({
      data: {
        organizationId: ORG,
        xeroTenantId: TENANT,
        sendFrom: new Date('2026-12-01T00:00:00.000Z'),
        salesAccountId: 'a-400',
        salesTaxType: 'NONE',
        salesAccounts: { 'filter change': 'a-410' },
        paymentAccounts: { PROPERTYWARE_LEDGER: 'a-815', CHECK: 'a-bank' },
        badDebtAccountId: null,
        paymentsToXero: true,
        trackingCategoryId: null,
        trackingGroups: {},
        itemCodes: {},
        // No project for each visit unless the office says so (2026-11-11); the labour as it has been.
        projectsEnabled: false,
        projectUserId: null,
        labourRateCents: 3500,
        labourMinutes: 6,
      },
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'XERO_SETTINGS_CHANGED',
        entityType: 'XeroSettings',
        actorUserId: office.id,
        metadata: {
          organisation: 'Example Home Services',
          tenantId: TENANT,
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
    expect(db.xeroInvoiceSync.updateMany).toHaveBeenCalledWith({ where: { organizationId: ORG, xeroTenantId: TENANT, status: 'FAILED' }, data: { nextAttemptAt: expect.any(Date) } });
  });

  it('changes only the row it read: a save in between is refused', async () => {
    const db = database({
      settings: { ...valuesRow(), updatedAt: UPDATED },
    });
    await expect(service(db).save(office, TENANT, input({ expectedUpdatedAt: '2026-11-18T00:00:00.000Z' }))).rejects.toMatchObject({
      code: 'XERO_SETTINGS_CHANGED',
    });
    await service(db).save(office, TENANT, input({ salesTaxType: 'NONE', salesAccounts: {}, expectedUpdatedAt: UPDATED.toISOString() }));
    expect(db.xeroSettings.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: ORG, xeroTenantId: TENANT, updatedAt: UPDATED } }));
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ metadata: { organisation: 'Example Home Services', tenantId: TENANT, changes: ['filter change: 410 Repair revenue → the default'] } }),
    });
  });

  it('writes nothing when nothing changed', async () => {
    const db = database({ settings: { ...valuesRow(), updatedAt: UPDATED } });
    await service(db).save(office, TENANT, input({ expectedUpdatedAt: UPDATED.toISOString() }));
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
    await expect(service(db).save(office, TENANT, input(over as Partial<SaveXeroSettingsInput>))).rejects.toMatchObject({
      code: 'XERO_SETTINGS_INVALID',
      message,
    });
    expect(db.xeroSettings.create).not.toHaveBeenCalled();
  });

  describe('a project for each visit (2026-11-11)', () => {
    const withUsers = () =>
      database({
        organisation: {
          name: 'Example Home Services',
          status: 'CONNECTED',
          accounts: ACCOUNTS,
          taxRates: TAX_RATES,
          projectUsers: [{ userId: 'user-1', name: 'Ada Office' }],
          catalogReadAt: new Date('2026-11-20T15:00:00.000Z'),
        },
      });
    const projects = (over: Partial<SaveXeroSettingsInput> = {}) =>
      input({ paymentsToXero: false, projectsEnabled: true, projectUserId: 'user-1', labourRateCents: 3500, labourMinutes: 6, ...over });

    it('is saved with the labour, on the audit trail in the office’s words', async () => {
      const db = withUsers();
      await service(db).save(office, TENANT, projects());
      expect(db.xeroSettings.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ projectsEnabled: true, projectUserId: 'user-1', labourRateCents: 3500, labourMinutes: 6, paymentsToXero: false }),
      });
      const changes = db.auditLog.create.mock.calls[0][0].data.metadata.changes as string[];
      expect(changes).toEqual(
        expect.arrayContaining(['Payments: sent to Xero → stay out of Xero', 'Projects: none → one for each visit, invoices as drafts', 'Labour logged as: none → Ada Office']),
      );
    });

    it('needs a Xero user for the labour before anything is sent, and none when no labour is logged', async () => {
      const db = withUsers();
      await service(db).save(office, TENANT, projects({ projectUserId: null }));
      const view = await service(db).read(ORG, TENANT);
      expect(view.checks.find((check) => check.key === 'projects')).toEqual({
        key: 'projects',
        label: 'A Xero user to log each visit’s labour under',
        ok: false,
        detail: 'Choose the Xero user the labour is logged under.',
      });
      const none = withUsers();
      await service(none).save(office, TENANT, projects({ projectUserId: null, labourMinutes: 0 }));
      expect((await service(none).read(ORG, TENANT)).checks.find((check) => check.key === 'projects')).toMatchObject({ label: 'Projects log no labour', ok: true });
    });

    it.each([
      [{ paymentsToXero: true }, 'Payments must stay out of Xero while each visit gets a project: its invoices go as drafts, and Xero takes no payment on a draft.'],
      [{ projectUserId: 'user-gone' }, 'That Xero user cannot log time on projects. Read from Xero again, then choose.'],
      [{ labourMinutes: 601 }, 'The labour is from 0 to 600 whole minutes.'],
      [{ labourRateCents: 12.5 }, 'The labour’s rate is from $0 to $1000 an hour, in whole cents.'],
    ])('refuses %j', async (over, message) => {
      const db = withUsers();
      await expect(service(db).save(office, TENANT, projects(over as Partial<SaveXeroSettingsInput>))).rejects.toMatchObject({ code: 'XERO_SETTINGS_INVALID', message });
      expect(db.xeroSettings.create).not.toHaveBeenCalled();
    });
  });

  it('needs Xero connected and read, since the accounts come from it', async () => {
    await expect(service(database({ signedIn: false })).save(office, TENANT, input())).rejects.toMatchObject({ code: 'XERO_NOT_READ' });
    await expect(
      service(database({ organisation: { name: 'Example Home Services', status: 'CONNECTED', accounts: ACCOUNTS, taxRates: TAX_RATES, catalogReadAt: null } })).save(office, TENANT, input()),
    ).rejects.toMatchObject({ code: 'XERO_NOT_READ' });
  });

  it('never calls Xero: reading and saving use the console’s last read', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    const db = database();
    await service(db).read(ORG, TENANT);
    await service(db).save(office, TENANT, input());
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
    ).toEqual({
      sendFrom: null,
      salesAccountId: null,
      salesTaxType: 'NONE',
      salesAccounts: { 'move-out inspection': 'a-410' },
      paymentAccounts: {},
      badDebtAccountId: null,
      paymentsToXero: true, trackingCategoryId: null, trackingGroups: {}, itemCodes: {},
      projectsEnabled: false, projectUserId: null, labourRateCents: 3500, labourMinutes: 6,
    });
  });

  it('reads no row as nothing chosen, and ignores what is not a method', () => {
    expect(valuesFrom(null)).toEqual({
      sendFrom: null,
      salesAccountId: null,
      salesTaxType: null,
      salesAccounts: {},
      paymentAccounts: {},
      badDebtAccountId: null,
      paymentsToXero: true, trackingCategoryId: null, trackingGroups: {}, itemCodes: {},
      projectsEnabled: false, projectUserId: null, labourRateCents: 3500, labourMinutes: 6,
    });
    expect(valuesFrom({ ...valuesRow(), paymentAccounts: { CHECK: 'a-bank', NOPE: 'x' } }).paymentAccounts).toEqual({ CHECK: 'a-bank' });
  });

  it('names an account Xero no longer lists without its id', () => {
    const before = valuesFrom(null);
    expect(settingsChanges(before, { ...before, salesAccountId: 'a-missing' }, ACCOUNTS)).toEqual([
      'Default sales account: none → an account Xero no longer lists',
    ]);
  });
});

describe('the request check (2026-11-11)', () => {
  // As main.ts runs it on every request: a field the DTO does not name is refused.
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (body: unknown) => pipe.transform(body, { type: 'body', metatype: SaveXeroSettingsDto });
  // Every field of the contract, as the page sends them: one added there and not to the DTO fails here.
  const everything: Required<SaveXeroSettingsInput> = {
    sendFrom: '2026-12-01',
    salesAccountId: 'a-400',
    salesTaxType: 'NONE',
    salesAccounts: { 'filter change': 'a-410' },
    paymentAccounts: { CHECK: 'a-bank' },
    badDebtAccountId: null,
    paymentsToXero: false,
    trackingCategoryId: 'tc-1',
    trackingGroups: { 'filter change': 'Air Filter Income' },
    itemCodes: { 'filter change': 'Filter Change' },
    // A project for each visit (2026-11-11).
    projectsEnabled: true,
    projectUserId: 'user-1',
    labourRateCents: 3500,
    labourMinutes: 6,
    expectedUpdatedAt: null,
  };

  it('takes every choice the page saves', async () => {
    await expect(check(everything)).resolves.toMatchObject({
      paymentsToXero: false,
      trackingCategoryId: 'tc-1',
      trackingGroups: { 'filter change': 'Air Filter Income' },
      itemCodes: { 'filter change': 'Filter Change' },
      projectsEnabled: true,
      projectUserId: 'user-1',
      labourRateCents: 3500,
      labourMinutes: 6,
    });
    // And what the page sent before tracking and items, and before projects, for a page still open from a release before.
    const added = new Set(['paymentsToXero', 'trackingCategoryId', 'trackingGroups', 'itemCodes', 'projectsEnabled', 'projectUserId', 'labourRateCents', 'labourMinutes']);
    const before = Object.fromEntries(Object.entries(everything).filter(([key]) => !added.has(key)));
    await expect(check(before)).resolves.toBeInstanceOf(SaveXeroSettingsDto);
  });

  it('refuses what it does not know, and the wrong kind of answer', async () => {
    await expect(check({ ...everything, somethingElse: 1 })).rejects.toThrow();
    await expect(check({ ...everything, paymentsToXero: 'no' })).rejects.toThrow();
    await expect(check({ ...everything, trackingGroups: 'Air Filter Income' })).rejects.toThrow();
    await expect(check({ ...everything, projectsEnabled: 'yes' })).rejects.toThrow();
    await expect(check({ ...everything, labourMinutes: 6.5 })).rejects.toThrow();
    await expect(check({ ...everything, labourRateCents: -1 })).rejects.toThrow();
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
