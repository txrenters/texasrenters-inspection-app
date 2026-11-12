import { fireEvent, render, screen, within } from '@testing-library/react';
import type { XeroAccount, XeroItem, XeroSettingsView, XeroTaxRate, XeroTrackingCategory } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { XeroSettingsForm } from './xero-settings-form';

/**
 * What goes where in Xero (2026-11-10, phase 2 of the Xero plan): chosen from
 * the console's last read of Xero, saved over the row as it was read. Nothing
 * is sent to Xero. Everything invented.
 */

const save = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
vi.mock('@/lib/xero-queries', () => ({ useSaveXeroSettings: () => save }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ACCOUNTS: XeroAccount[] = [
  { accountId: 'a-400', code: '400', name: 'Service revenue', type: 'REVENUE', class: 'REVENUE', status: 'ACTIVE', takesPayments: false },
  { accountId: 'a-410', code: '410', name: 'Repair revenue', type: 'REVENUE', class: 'REVENUE', status: 'ACTIVE', takesPayments: false },
  { accountId: 'a-460', code: '460', name: 'Old revenue', type: 'REVENUE', class: 'REVENUE', status: 'ARCHIVED', takesPayments: false },
  { accountId: 'a-bank', code: null, name: 'Operating checking', type: 'BANK', class: 'ASSET', status: 'ACTIVE', takesPayments: true },
  { accountId: 'a-815', code: '815', name: 'Owner funds clearing', type: 'CURRLIAB', class: 'LIABILITY', status: 'ACTIVE', takesPayments: true },
];
const TAX_RATES: XeroTaxRate[] = [{ name: 'Tax Exempt', taxType: 'NONE', status: 'ACTIVE', effectiveRate: 0, appliesToRevenue: true }];

const VIEW: XeroSettingsView = {
  tenantId: 'a1000000-0000-4000-8000-000000000001',
  values: { sendFrom: '2026-12-01', salesAccountId: 'a-400', salesTaxType: 'NONE', salesAccounts: {}, paymentAccounts: {} },
  products: [
    { nameKey: 'move-out inspection', name: 'Move-out inspection', listed: true, active: true, accountId: null },
    { nameKey: 'filter change', name: 'Filter change', listed: false, active: true, accountId: null },
  ],
  withoutOrganisation: 0,
  payments: [
    { method: 'PROPERTYWARE_LEDGER', accountId: null, payments: 10 },
    { method: 'CHECK', accountId: null, payments: 2 },
  ],
  invoicesToSend: 12,
  checks: [
    { key: 'connected', label: 'Xero is connected and read', ok: true, detail: null },
    { key: 'payments', label: 'An account for every payment method in use', ok: false, detail: 'None yet for Propertyware ledger, Check.' },
  ],
  ready: false,
  updatedAt: '2026-11-19T15:00:00.000Z',
  booksRead: false,
  madeInConsole: false,
};

const pick = (combobox: string, option: RegExp | string) => {
  // Radix opens a select on pointer-down, as it does a menu.
  fireEvent.pointerDown(screen.getByRole('combobox', { name: combobox }), { button: 0, pointerId: 1, pointerType: 'mouse' });
  fireEvent.click(screen.getByRole('option', { name: option }));
};

const mount = (view: XeroSettingsView = VIEW, canManage = true) =>
  render(<XeroSettingsForm accounts={ACCOUNTS} canManage={canManage} taxRates={TAX_RATES} view={view} />);

beforeEach(() => {
  vi.clearAllMocks();
  save.isPending = false;
});

describe('choosing what goes where', () => {
  it('says what is still missing, and how many invoices it covers', () => {
    mount();
    expect(screen.getByText('None yet for Propertyware ledger, Check.')).toBeInTheDocument();
    expect(screen.getByText(/12 invoices issued since/)).toBeInTheDocument();
  });

  it('saves a product’s account and a payment method’s, over the row it read', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    pick('Account for Filter change', '410 Repair revenue');
    pick('Account for Propertyware ledger', '815 Owner funds clearing');
    pick('Account for Check', 'Operating checking');
    expect(screen.getByText('Not saved yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save.mutate).toHaveBeenCalledWith(
      {
        sendFrom: '2026-12-01',
        salesAccountId: 'a-400',
        salesTaxType: 'NONE',
        salesAccounts: { 'filter change': 'a-410' },
        paymentAccounts: { PROPERTYWARE_LEDGER: 'a-815', CHECK: 'a-bank' },
        expectedUpdatedAt: '2026-11-19T15:00:00.000Z',
      },
      expect.anything(),
    );
  });

  it('offers only revenue accounts for sales and only accounts taking payments for payments', () => {
    mount();
    fireEvent.pointerDown(screen.getByRole('combobox', { name: 'Account for Filter change' }), { button: 0, pointerId: 1, pointerType: 'mouse' });
    const sales = screen.getAllByRole('option').map((option) => option.textContent);
    expect(sales).toEqual(['The default (400 Service revenue)', '400 Service revenue', '410 Repair revenue']);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    fireEvent.pointerDown(screen.getByRole('combobox', { name: 'Account for Check' }), { button: 0, pointerId: 1, pointerType: 'mouse' });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Not chosen', 'Operating checking', '815 Owner funds clearing']);
  });

  it('goes back to the default when the product’s own account is taken away', () => {
    mount({ ...VIEW, values: { ...VIEW.values, salesAccounts: { 'filter change': 'a-410' } } });
    pick('Account for Filter change', /^The default/);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save.mutate.mock.calls[0]![0].salesAccounts).toEqual({});
  });

  it('still shows a choice Xero has since archived, so it can be seen and changed', () => {
    mount({ ...VIEW, values: { ...VIEW.values, salesAccounts: { 'filter change': 'a-460' } } });
    expect(screen.getByRole('combobox', { name: 'Account for Filter change' })).toHaveTextContent('460 Old revenue (not active in Xero)');
  });

  it('marks a name that is billed but not on the products list', () => {
    mount();
    const row = screen.getByText('Filter change').closest('tr')!;
    expect(within(row).getByText('billed, not on the list')).toBeInTheDocument();
  });

  it('undoes what was not saved', () => {
    mount();
    pick('Account for Check', 'Operating checking');
    fireEvent.click(screen.getByRole('button', { name: 'Undo changes' }));
    expect(screen.getByRole('combobox', { name: 'Account for Check' })).toHaveTextContent('Not chosen');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('is only looked at by whoever does not run the integrations', () => {
    mount(VIEW, false);
    expect(screen.getByRole('combobox', { name: 'Account for Check' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});

describe('as the office finishes its invoices in Xero (2026-11-11)', () => {
  const CATEGORIES: XeroTrackingCategory[] = [
    {
      trackingCategoryId: 'tc-1',
      name: 'Income by Employee',
      status: 'ACTIVE',
      options: [
        { optionId: 'o-1', name: 'Air Filter Income: Ada', status: 'ACTIVE' },
        { optionId: 'o-2', name: 'Move Out Inspection Income: Ada', status: 'ACTIVE' },
      ],
    },
  ];
  const ITEMS: XeroItem[] = [
    { itemId: 'i-1', code: 'Filter Change', name: 'Filter Change', isSold: true },
    { itemId: 'i-2', code: 'Bought in', name: null, isSold: false },
  ];
  const mountTagged = (view: XeroSettingsView = VIEW) =>
    render(<XeroSettingsForm accounts={ACCOUNTS} canManage items={ITEMS} taxRates={TAX_RATES} trackingCategories={CATEGORIES} view={view} />);

  it('tags lines in a category, and saves each product’s item and what it is tracked as', () => {
    mountTagged();
    // Tracked as is chosen once there is a category to track in.
    expect(screen.queryByRole('combobox', { name: 'Tracked as for Filter change' })).not.toBeInTheDocument();
    pick('Tag lines in', 'Income by Employee');
    fireEvent.pointerDown(screen.getByRole('combobox', { name: 'Tracked as for Filter change' }), { button: 0, pointerId: 1, pointerType: 'mouse' });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Not tracked', 'Air Filter Income', 'Move Out Inspection Income']);
    fireEvent.click(screen.getByRole('option', { name: 'Air Filter Income' }));
    fireEvent.pointerDown(screen.getByRole('combobox', { name: 'Xero item for Filter change' }), { button: 0, pointerId: 1, pointerType: 'mouse' });
    // Only what Xero sells.
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['None', 'Filter Change']);
    fireEvent.click(screen.getByRole('option', { name: 'Filter Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ trackingCategoryId: 'tc-1', trackingGroups: { 'filter change': 'Air Filter Income' }, itemCodes: { 'filter change': 'Filter Change' } }),
      expect.anything(),
    );
  });

  it('forgets what each product was tracked as when the category goes', () => {
    mountTagged({ ...VIEW, values: { ...VIEW.values, trackingCategoryId: 'tc-1', trackingGroups: { 'filter change': 'Air Filter Income' } } });
    pick('Tag lines in', 'No tracking');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save.mutate).toHaveBeenCalledWith(expect.objectContaining({ trackingCategoryId: null, trackingGroups: {} }), expect.anything());
  });

  it('takes prices that include the tax with the switch, and says what Xero does with them (2026-11-12)', () => {
    mountTagged();
    expect(screen.getByText(/added on top of each line’s price/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Prices include sales tax' }));
    expect(screen.getByText(/already has the tax in it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save.mutate).toHaveBeenCalledWith(expect.objectContaining({ pricesIncludeTax: true }), expect.anything());
  });

  it('keeps payments out of Xero with the switch, and then asks for no account for them', () => {
    mountTagged();
    fireEvent.click(screen.getByRole('switch', { name: 'Send payments to Xero' }));
    expect(screen.queryByRole('combobox', { name: 'Account for Check' })).not.toBeInTheDocument();
    expect(screen.getByText(/Payments stay out of Xero/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save.mutate).toHaveBeenCalledWith(expect.objectContaining({ paymentsToXero: false }), expect.anything());
  });
});

describe('once the console makes the invoices and the books are read (2026-11-13)', () => {
  it('asks nothing about payments or bad debts: they are recorded in Xero', () => {
    mount({ ...VIEW, booksRead: true, madeInConsole: true });
    expect(screen.queryByRole('switch', { name: 'Send payments to Xero' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Written off to')).not.toBeInTheDocument();
    expect(screen.getByText(/This company's books are read back from there every hour, its payments and credit notes with them/)).toBeInTheDocument();
  });

  it('says the start date as it is now, with no Zap, and that invoices go as drafts', () => {
    mount({ ...VIEW, madeInConsole: true });
    expect(screen.getByText('Invoices made in the console on or after it go to Xero, whatever day each is dated; one made before it never does.')).toBeInTheDocument();
    expect(screen.queryByText(/Zap/)).not.toBeInTheDocument();
    expect(screen.getByText('No projects are made. Invoices still go as drafts, for the office to approve in Xero.')).toBeInTheDocument();
  });

  it('still asks where payments land while the books are not read', () => {
    mount();
    expect(screen.getByRole('switch', { name: 'Send payments to Xero' })).toBeInTheDocument();
    expect(screen.getByText(/made through Zapier or by hand/)).toBeInTheDocument();
  });
});

describe('a project for each visit (2026-11-11)', () => {
  const mountProjects = (values: Partial<XeroSettingsView['values']> = {}, projectUsers = [{ userId: 'user-1', name: 'Ada Office' }]) =>
    render(
      <XeroSettingsForm
        accounts={ACCOUNTS}
        canManage
        projectUsers={projectUsers}
        taxRates={TAX_RATES}
        view={{ ...VIEW, values: { ...VIEW.values, paymentsToXero: true, ...values } }}
      />,
    );

  it('makes one for each visit, keeping payments out, with the labour logged under a Xero user', () => {
    mountProjects();
    fireEvent.click(screen.getByRole('switch', { name: 'Make a Xero project for each visit' }));
    // Xero takes no payment on a draft: payments go out, and stay out while projects are on.
    expect(screen.getByRole('switch', { name: 'Send payments to Xero' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Send payments to Xero' })).toBeDisabled();
    expect(screen.getByText(/invoices go as drafts: in Xero, put each line on its project, then approve it/)).toBeInTheDocument();
    pick('Labour logged as', 'Ada Office');
    expect(screen.getByText(/\$3\.50 a visit/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Minutes a visit'), { target: { value: '12' } });
    expect(screen.getByText(/\$7\.00 a visit/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ projectsEnabled: true, paymentsToXero: false, projectUserId: 'user-1', labourMinutes: 12 }),
      expect.anything(),
    );
  });

  it('logs no labour at 0 minutes, and says how to list the Xero users before the connection may', () => {
    mountProjects({ paymentsToXero: false, projectsEnabled: true, labourMinutes: 0 }, []);
    expect(screen.getByText(/No labour is logged/)).toBeInTheDocument();
    expect(screen.getByText(/Connect again so Xero lets the console make projects/)).toBeInTheDocument();
  });

  it('puts the typed rate and minutes back with the rest when the changes are undone', () => {
    mountProjects({ paymentsToXero: false, projectsEnabled: true });
    fireEvent.change(screen.getByLabelText('Rate an hour ($)'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Undo changes' }));
    expect(screen.getByLabelText('Rate an hour ($)')).toHaveValue(35);
  });
});

describe('the services this organisation is sent', () => {
  it('says how many go to no organisation yet, and where to choose', () => {
    mount({ ...VIEW, withoutOrganisation: 3 });
    const note = screen.getByText(/3 products and services go to no/);
    expect(within(note).getByRole('link', { name: 'Invoices → Settings' })).toHaveAttribute('href', '/invoices/settings');
  });

  it('says so when none goes to it', () => {
    mount({ ...VIEW, products: [] });
    expect(screen.getByText(/No product or service goes to this organisation yet/)).toBeInTheDocument();
  });
});
