import { describe, expect, it } from 'vitest';

import {
  badDebtAccounts,
  connectedOrganisations,
  labourOf,
  paymentAccounts,
  revenueAccounts,
  trackingGroups,
  trackingOptionFor,
  xeroCanMakeProjects,
  xeroCanWrite,
  xeroChecks,
  xeroProjectName,
  xeroSendingBlockers,
  xeroSettingsProblem,
  type XeroAccount,
  type XeroOrganisationView,
  type XeroTrackingCategory,
} from '../src/contracts/xero';

describe('a visit’s project in Xero (2026-11-11)', () => {
  const visit = { day: '2026-11-10', technicianName: 'Ada Lane', packageQuarter: { year: 2026, quarter: 4 }, kind: 'HVAC Inspection & Filter Change' };

  it('is named as the office names them: the technician’s first name, the package’s quarter, the visit’s day', () => {
    expect(xeroProjectName(visit)).toBe('Ada: Tenant Benefit Package - 4th Qtr - 2026 - 11.10.2026');
    expect(xeroProjectName({ ...visit, packageQuarter: { year: 2027, quarter: 1 } })).toBe('Ada: Tenant Benefit Package - 1st Qtr - 2027 - 11.10.2026');
    expect(xeroProjectName({ ...visit, packageQuarter: { year: 2027, quarter: 2 } })).toContain('2nd Qtr');
    expect(xeroProjectName({ ...visit, packageQuarter: { year: 2027, quarter: 3 } })).toContain('3rd Qtr');
  });

  it('names any other visit by what it was, and none without a technician', () => {
    expect(xeroProjectName({ ...visit, packageQuarter: null, kind: ' Move Out Inspection ' })).toBe('Ada: Move Out Inspection - 11.10.2026');
    expect(xeroProjectName({ ...visit, technicianName: '  ' })).toBeNull();
    expect(xeroProjectName({ ...visit, technicianName: null })).toBeNull();
  });

  it('logs the labour the office has been adding by hand, and none when projects are off or either part is 0', () => {
    expect(labourOf({ projectsEnabled: true })).toEqual({ rateCents: 3500, minutes: 6 });
    expect(labourOf({ projectsEnabled: false, labourRateCents: 3500, labourMinutes: 6 })).toBeNull();
    expect(labourOf({ projectsEnabled: true, labourMinutes: 0 })).toBeNull();
    expect(labourOf({ projectsEnabled: true, labourRateCents: 0 })).toBeNull();
  });

  it('needs a connection allowed to make projects, only once projects are on', () => {
    const scopes = ['accounting.contacts', 'accounting.invoices'];
    expect(xeroCanMakeProjects(scopes)).toBe(false);
    expect(xeroSendingBlockers({ connected: true, scopes, settingsReady: true, invoiceRemindersOn: false })).toEqual([]);
    expect(xeroSendingBlockers({ connected: true, scopes, settingsReady: true, invoiceRemindersOn: false, projectsEnabled: true })).toEqual([
      'Connect again, so Xero lets the console make projects.',
    ]);
    expect(xeroSendingBlockers({ connected: true, scopes: [...scopes, 'projects'], settingsReady: true, invoiceRemindersOn: false, projectsEnabled: true })).toEqual([]);
  });
});

describe('the office’s organisations', () => {
  const organisation = (tenantId: string, status: XeroOrganisationView['status']) => ({ tenantId, status }) as XeroOrganisationView;

  it('are worked with only while the sign-in and the organisation are both connected', () => {
    const organisations = [organisation('homes', 'CONNECTED'), organisation('old', 'REMOVED'), organisation('pest', 'CONNECTED')];
    expect(connectedOrganisations({ status: 'CONNECTED', organisations }).map((item) => item.tenantId)).toEqual(['homes', 'pest']);
    expect(connectedOrganisations({ status: 'REAUTHORIZATION_REQUIRED', organisations })).toEqual([]);
  });
});

describe('sending to Xero', () => {
  const writes = ['offline_access', 'accounting.settings.read', 'accounting.contacts', 'accounting.invoices'];
  const ready = { connected: true, scopes: writes, settingsReady: true, invoiceRemindersOn: false };

  it('may write only with the contacts and invoices scopes', () => {
    expect(xeroCanWrite(writes)).toBe(true);
    expect(xeroCanWrite(['offline_access', 'accounting.settings.read'])).toBe(false);
  });

  it('is blocked until connected, allowed to write, ready, and Xero’s reminders are off', () => {
    expect(xeroSendingBlockers({ ...ready, connected: false })).toEqual(['Connect Xero.']);
    expect(xeroSendingBlockers(ready)).toEqual([]);
    // Not knowing whether Xero's reminders are on does not block; knowing they are does.
    expect(xeroSendingBlockers({ ...ready, invoiceRemindersOn: null })).toEqual([]);
    expect(xeroSendingBlockers({ ...ready, scopes: ['offline_access'], settingsReady: false, invoiceRemindersOn: true })).toHaveLength(3);
  });

});

const account = (over: Partial<XeroAccount>): XeroAccount => ({
  accountId: 'a',
  code: '400',
  name: 'Revenue',
  type: 'REVENUE',
  class: 'REVENUE',
  status: 'ACTIVE',
  takesPayments: false,
  ...over,
});

describe('Xero accounts', () => {
  it('offer active revenue accounts with a code for sales', () => {
    const accounts = [
      account({ accountId: '1' }),
      account({ accountId: '2', type: 'SALES', class: null }),
      account({ accountId: '3', status: 'ARCHIVED' }),
      account({ accountId: '4', code: null }),
      account({ accountId: '5', type: 'EXPENSE', class: 'EXPENSE' }),
    ];
    expect(revenueAccounts(accounts).map((item) => item.accountId)).toEqual(['1', '2']);
  });

  it('offer active accounts that take payments for payments', () => {
    const accounts = [
      account({ accountId: 'bank', type: 'BANK', class: 'ASSET', code: null, takesPayments: true }),
      account({ accountId: 'clearing', type: 'CURRLIAB', class: 'LIABILITY', takesPayments: true }),
      account({ accountId: 'closed', type: 'BANK', takesPayments: true, status: 'ARCHIVED' }),
      account({ accountId: 'sales' }),
    ];
    expect(paymentAccounts(accounts).map((item) => item.accountId)).toEqual(['bank', 'clearing']);
  });

  it('offer active expense accounts with a code for bad debts (2026-11-10)', () => {
    const accounts = [
      account({ accountId: 'bad-debts', type: 'EXPENSE', class: 'EXPENSE', code: '480' }),
      account({ accountId: 'overheads', type: 'OVERHEADS', class: null, code: '490' }),
      account({ accountId: 'no-code', type: 'EXPENSE', class: 'EXPENSE', code: null }),
      account({ accountId: 'archived', type: 'EXPENSE', class: 'EXPENSE', status: 'ARCHIVED' }),
      account({ accountId: 'sales' }),
    ];
    expect(badDebtAccounts(accounts).map((item) => item.accountId)).toEqual(['bad-debts', 'overheads']);
  });
});

describe('Xero choices', () => {
  const catalog = {
    accounts: [account({ accountId: 'sales' }), account({ accountId: 'bank', type: 'BANK', class: 'ASSET', code: null, takesPayments: true })],
    taxRates: [{ name: 'Tax Exempt', taxType: 'NONE', status: 'ACTIVE', effectiveRate: 0, appliesToRevenue: true }],
  };
  const values = { sendFrom: '2026-12-01', salesAccountId: 'sales', salesTaxType: 'NONE', salesAccounts: {}, paymentAccounts: { CHECK: 'bank' } };

  it('take a real day, at most a year ahead', () => {
    expect(xeroSettingsProblem(values, catalog, '2026-11-20')).toBeNull();
    expect(xeroSettingsProblem({ ...values, sendFrom: '2026-02-29' }, catalog, '2026-11-20')).toBe('The start date is not a date.');
    expect(xeroSettingsProblem({ ...values, sendFrom: '2027-11-21' }, catalog, '2026-11-20')).toBeNull();
    expect(xeroSettingsProblem({ ...values, sendFrom: '2027-11-22' }, catalog, '2026-11-20')).toBe('The start date is more than a year away.');
  });

  it('write bad debts off only to an active expense account (2026-11-10)', () => {
    const withBadDebts = { ...catalog, accounts: [...catalog.accounts, account({ accountId: 'bad-debts', type: 'EXPENSE', class: 'EXPENSE', code: '480' })] };
    expect(xeroSettingsProblem({ ...values, badDebtAccountId: 'bad-debts' }, withBadDebts, '2026-11-20')).toBeNull();
    expect(xeroSettingsProblem({ ...values, badDebtAccountId: 'sales' }, withBadDebts, '2026-11-20')).toBe(
      'Bad debts are given an account that is not an active expense account with a code in Xero.',
    );
    // None chosen is no problem: an invoice closed as bad debt waits for one.
    expect(xeroSettingsProblem({ ...values, badDebtAccountId: null }, withBadDebts, '2026-11-20')).toBeNull();
  });

  it('ask for an account only for the payment methods in use', () => {
    const checks = xeroChecks({ connected: true, readAt: '2026-11-20T15:00:00.000Z', values, catalog, paymentsByMethod: { CHECK: 3, CASH: 0 } });
    expect(checks.every((check) => check.ok)).toBe(true);
    const missing = xeroChecks({ connected: true, readAt: '2026-11-20T15:00:00.000Z', values, catalog, paymentsByMethod: { CASH: 1 } });
    expect(missing.find((check) => check.key === 'payments')?.detail).toBe('None yet for Cash.');
  });

  it('ask for no payment account while payments stay out of Xero (2026-11-11)', () => {
    const out = xeroChecks({ connected: true, readAt: '2026-11-20T15:00:00.000Z', values: { ...values, paymentsToXero: false }, catalog, paymentsByMethod: { CASH: 1 } });
    expect(out.find((check) => check.key === 'payments')).toEqual({ key: 'payments', label: 'Payments stay out of Xero', ok: true, detail: null });
    expect(out.every((check) => check.ok)).toBe(true);
  });

  describe('tracking and items (2026-11-11)', () => {
    const category: XeroTrackingCategory = {
      trackingCategoryId: 'tc-1',
      name: 'Income by Employee',
      status: 'ACTIVE',
      options: [
        { optionId: '1', name: 'Air Filter Income: Ada', status: 'ACTIVE' },
        { optionId: '2', name: 'HVAC Inspection Income:  Ada Lane', status: 'ACTIVE' },
        { optionId: '3', name: 'Occupied Inspection Income Bea', status: 'ACTIVE' },
        { optionId: '4', name: 'Code Work Income: Ada', status: 'ARCHIVED' },
      ],
    };
    const tracked = {
      ...catalog,
      trackingCategories: [category, { trackingCategoryId: 'tc-old', name: 'Region', status: 'ARCHIVED', options: [] }],
      items: [
        { itemId: 'i-1', code: 'Filter Change', name: 'Filter Change', isSold: true },
        { itemId: 'i-2', code: 'Bought', name: null, isSold: false },
      ],
    };

    it('find a category’s groups -- what comes before the colon -- each once, active ones only', () => {
      expect(trackingGroups(category)).toEqual(['Air Filter Income', 'HVAC Inspection Income']);
      expect(trackingGroups(null)).toEqual([]);
    });

    it('find a technician’s option by first name, else whole name, however the colon and spaces are written', () => {
      expect(trackingOptionFor(category, 'Air Filter Income', 'Ada Lane')).toEqual({ optionId: '1', name: 'Air Filter Income: Ada' });
      expect(trackingOptionFor(category, 'hvac inspection income', 'Ada Lane')).toEqual({ optionId: '2', name: 'HVAC Inspection Income:  Ada Lane' });
      expect(trackingOptionFor(category, 'Occupied Inspection Income', 'Bea Stone')).toEqual({ optionId: '3', name: 'Occupied Inspection Income Bea' });
      expect(trackingOptionFor(category, 'Code Work Income', 'Ada Lane')).toBeNull();
      expect(trackingOptionFor(category, 'Air Filter Income', ' ')).toBeNull();
    });

    it('take only an active category, groups it has, and items Xero sells', () => {
      const chosen = { ...values, trackingCategoryId: 'tc-1', trackingGroups: { 'filter change': 'Air Filter Income' }, itemCodes: { 'filter change': 'Filter Change' } };
      expect(xeroSettingsProblem(chosen, tracked, '2026-11-20')).toBeNull();
      expect(xeroSettingsProblem({ ...chosen, trackingCategoryId: 'tc-old' }, tracked, '2026-11-20')).toBe('That tracking category is not an active one in Xero.');
      expect(xeroSettingsProblem({ ...chosen, trackingCategoryId: null }, tracked, '2026-11-20')).toBe(
        'Choose the tracking category before what each product or service is tracked as.',
      );
      expect(xeroSettingsProblem({ ...chosen, trackingGroups: { 'filter change': 'Pest Income' } }, tracked, '2026-11-20')).toBe(
        '“Pest Income” does not start any option of Income by Employee in Xero.',
      );
      expect(xeroSettingsProblem({ ...chosen, itemCodes: { 'filter change': 'Bought' } }, tracked, '2026-11-20')).toBe('“Bought” is not an item Xero sells.');
    });

    it('say when a chosen category, group or item has gone from Xero', () => {
      const gone = xeroChecks({
        connected: true,
        readAt: '2026-11-20T15:00:00.000Z',
        values: { ...values, trackingCategoryId: 'tc-1', trackingGroups: { 'filter change': 'Pest Income' }, itemCodes: { 'filter change': 'HVAC' } },
        catalog: tracked,
        paymentsByMethod: {},
      });
      expect(gone.find((check) => check.key === 'stillInXero')?.detail).toBe('Choose again for “Pest Income”, the item “HVAC”.');
    });
  });
});
