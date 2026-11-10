import { describe, expect, it } from 'vitest';

import {
  connectedOrganisations,
  paymentAccounts,
  revenueAccounts,
  xeroCanWrite,
  xeroChecks,
  xeroSendingBlockers,
  xeroSettingsProblem,
  type XeroAccount,
  type XeroOrganisationView,
} from '../src/contracts/xero';

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

  it('ask for an account only for the payment methods in use', () => {
    const checks = xeroChecks({ connected: true, readAt: '2026-11-20T15:00:00.000Z', values, catalog, paymentsByMethod: { CHECK: 3, CASH: 0 } });
    expect(checks.every((check) => check.ok)).toBe(true);
    const missing = xeroChecks({ connected: true, readAt: '2026-11-20T15:00:00.000Z', values, catalog, paymentsByMethod: { CASH: 1 } });
    expect(missing.find((check) => check.key === 'payments')?.detail).toBe('None yet for Cash.');
  });
});
