import { describe, expect, it } from 'vitest';

import { paymentAccounts, revenueAccounts, type XeroAccount } from '../src/contracts/xero';

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
