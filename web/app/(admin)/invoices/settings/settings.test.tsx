import { fireEvent, render, screen, within } from '@testing-library/react';
import { EMPTY_INVOICE_SETTINGS, type InvoiceSettingsView } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoiceSettingsPage from './page';

/**
 * Invoice settings (2026-11-06, phase 6): the company details and a new
 * invoice's defaults, each blank field showing what it falls back to, and the
 * products and services list with what was billed but is not on it. Changed
 * by whoever makes invoices; read by whoever reads them. Everything invented.
 */

const hooks = vi.hoisted(() => ({
  view: { current: null as unknown },
  save: { mutate: vi.fn(), isPending: false },
  addProducts: { mutate: vi.fn(), isPending: false },
  changeProduct: { mutate: vi.fn(), isPending: false },
  addBillingRules: { mutate: vi.fn(), isPending: false },
  removeBillingRule: { mutate: vi.fn(), isPending: false },
}));
vi.mock('@/lib/invoice-settings-queries', () => ({
  useInvoiceSettings: () => ({ isLoading: false, isError: false, data: hooks.view.current, refetch: vi.fn() }),
  useInvoiceSettingsEdits: () => hooks,
}));
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: (key: string) => permissions.granted.has(key) }) }));
// The cutover is tested in invoice-takeover.test.tsx.
vi.mock('@/components/invoices/invoice-takeover-section', () => ({ InvoiceTakeoverSection: () => null }));
vi.mock('@/components/invoices/invoice-emails-section', () => ({ InvoiceEmailsSection: () => null }));
// Drafting automatically has its own tests (invoice-auto-drafts-section.test.tsx).
vi.mock('@/components/invoices/invoice-auto-drafts-section', () => ({ InvoiceAutoDraftsSection: () => null }));
vi.mock('@/components/invoices/statement-settings-section', () => ({ StatementSettingsSection: () => null }));
vi.mock('@/components/invoices/email-templates-section', () => ({ EmailTemplatesSection: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Notes, files and the office's email words have their own tests (invoice-records.test.tsx).
vi.mock('@/lib/invoice-record-queries', () => ({
  useInvoiceRecords: () => ({
    addNote: { mutate: vi.fn(), isPending: false },
    removeNote: { mutate: vi.fn(), isPending: false },
    addFile: { mutate: vi.fn(), isPending: false },
    removeFile: { mutate: vi.fn(), isPending: false },
  }),
  useEmailTemplates: () => ({ isLoading: false, data: undefined }),
  useSaveEmailTemplates: () => ({ mutate: vi.fn(), isPending: false }),
}));

const SAVED_AT = '2026-11-06T15:00:00.000Z';
const BRAND = { name: 'Server Co', addressLine1: '1 Server Plaza', addressLine2: null, phone: '555-0100', email: null };
const FALLBACK = { subject: 'For Services Rendered', termsDays: 30, clientMessage: 'Thank you for your business.', contractDisclaimer: 'Due within 30 days.' };

const VIEW: InvoiceSettingsView = {
  values: { ...EMPTY_INVOICE_SETTINGS, companyName: 'Example Company' },
  fallback: { brand: BRAND, ...FALLBACK },
  brand: { ...BRAND, name: 'Example Company' },
  defaults: FALLBACK,
  updatedAt: SAVED_AT,
  products: [
    { id: 'p1', name: 'Filter Change', description: 'One filter, any size', unitPriceCents: 4500, active: true, xeroTenantId: null, updatedAt: SAVED_AT },
    { id: 'p2', name: 'Lockbox Install', description: null, unitPriceCents: 3000, active: false, xeroTenantId: null, updatedAt: SAVED_AT },
  ],
  billed: [
    { name: 'Pest Control', unitPriceCents: 2500 },
    { name: 'Gate Repair', unitPriceCents: 12000 },
  ],
  // What a visit bills (2026-11-12): tested in billing-rules-section.test.tsx.
  billingRules: [],
  suggestedRules: [],
  // No Xero organisation yet: the column is not shown.
  organisations: [],
  madeInConsole: false,
};

/** The companies' books in Xero: two connected, one no longer. */
const ORGANISATIONS: InvoiceSettingsView['organisations'] = [
  { tenantId: 'a1000000-0000-4000-8000-000000000001', name: 'Example Home Services', connected: true },
  { tenantId: 'a2000000-0000-4000-8000-000000000002', name: 'Example Pest Co', connected: true },
  { tenantId: 'a3000000-0000-4000-8000-000000000003', name: 'Old Books LLC', connected: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  permissions.granted = new Set(['invoices:read', 'invoices:manage']);
  hooks.view.current = VIEW;
});

describe('the company details and new-invoice defaults', () => {
  it('show what each blank field falls back to, and save only once something changed', () => {
    render(<InvoiceSettingsPage />);
    expect(screen.getByLabelText('Company name')).toHaveValue('Example Company');
    expect(screen.getByLabelText('Address')).toHaveAttribute('placeholder', '1 Server Plaza');
    expect(screen.getByLabelText('Subject')).toHaveAttribute('placeholder', 'For Services Rendered');
    expect(screen.getByLabelText('Contract / disclaimer')).toHaveAttribute('placeholder', 'Due within 30 days.');
    expect(screen.getByLabelText('Payment terms')).toHaveTextContent('As the latest invoice (Net 30)');

    const save = screen.getByRole('button', { name: 'Save settings' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: ' 555-0199 ' } });
    fireEvent.click(save);

    expect(hooks.save.mutate).toHaveBeenCalledWith(
      { ...EMPTY_INVOICE_SETTINGS, companyName: 'Example Company', phone: '555-0199', expectedUpdatedAt: SAVED_AT },
      expect.anything(),
    );
  });

  it('asks no payment terms once the console makes the invoices (2026-11-13): Xero dates them and sets when they fall due', () => {
    hooks.view.current = { ...VIEW, madeInConsole: true };
    render(<InvoiceSettingsPage />);
    expect(screen.queryByLabelText('Payment terms')).not.toBeInTheDocument();
    expect(screen.getByText(/each invoice is dated on its visit’s day and falls due on the last day of that month/)).toBeInTheDocument();
    // What a save sends is unchanged.
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '555-0199' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(hooks.save.mutate).toHaveBeenCalledWith(expect.objectContaining({ defaultTermsDays: EMPTY_INVOICE_SETTINGS.defaultTermsDays }), expect.anything());
  });

  it('says what is wrong before anything is saved', () => {
    render(<InvoiceSettingsPage />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'billing@example' } });
    expect(screen.getByText('billing@example is not an email address.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
  });

  it('is read-only for anybody who does not make invoices', () => {
    permissions.granted = new Set(['invoices:read']);
    render(<InvoiceSettingsPage />);
    expect(screen.getByLabelText('Company name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Set aside/ })).not.toBeInTheDocument();
    expect(screen.getByText('Only whoever makes invoices changes these.')).toBeInTheDocument();
  });
});

describe('the products and services list', () => {
  it('lists what is offered, and adds one at its price', () => {
    render(<InvoiceSettingsPage />);
    const section = screen.getByRole('region', { name: 'Products and services' });
    expect(within(section).getByRole('row', { name: /Filter Change/ })).toHaveTextContent('$45.00');

    fireEvent.change(within(section).getByLabelText('Name'), { target: { value: 'Smoke Detector Battery' } });
    fireEvent.change(within(section).getByLabelText('Price'), { target: { value: '12.5' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Add' }));
    expect(hooks.addProducts.mutate).toHaveBeenCalledWith(
      { products: [{ name: 'Smoke Detector Battery', description: null, unitPriceCents: 1250 }] },
      expect.anything(),
    );
  });

  it('refuses a price that is not one', () => {
    render(<InvoiceSettingsPage />);
    const section = screen.getByRole('region', { name: 'Products and services' });
    fireEvent.change(within(section).getByLabelText('Name'), { target: { value: 'Gate' } });
    fireEvent.change(within(section).getByLabelText('Price'), { target: { value: 'ten' } });
    expect(section).toHaveTextContent('Give the price in dollars and cents.');
    expect(within(section).getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('sets one aside against the product as it was read, and offers a set-aside one again', () => {
    render(<InvoiceSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Set aside Filter Change' }));
    expect(hooks.changeProduct.mutate).toHaveBeenCalledWith(
      { id: 'p1', input: { active: false, expectedUpdatedAt: SAVED_AT } },
      expect.anything(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Offer Lockbox Install again' }));
    expect(hooks.changeProduct.mutate).toHaveBeenLastCalledWith(
      { id: 'p2', input: { active: true, expectedUpdatedAt: SAVED_AT } },
      expect.anything(),
    );
  });

  it('changes a price in place', () => {
    render(<InvoiceSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Change Filter Change' }));
    fireEvent.change(screen.getByLabelText('Price', { selector: 'table input' }), { target: { value: '49.99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(hooks.changeProduct.mutate).toHaveBeenCalledWith(
      { id: 'p1', input: { name: 'Filter Change', description: 'One filter, any size', unitPriceCents: 4999, expectedUpdatedAt: SAVED_AT } },
      expect.anything(),
    );
  });

  it('offers what was billed but is not on the list, one at a time or all at once', () => {
    render(<InvoiceSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Pest Control' }));
    expect(hooks.addProducts.mutate).toHaveBeenCalledWith({ products: [{ name: 'Pest Control', unitPriceCents: 2500 }] }, expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Add all 2' }));
    expect(hooks.addProducts.mutate).toHaveBeenLastCalledWith({ products: VIEW.billed }, expect.anything());
  });
});

describe('which company each goes to', () => {
  const pick = (combobox: string, option: string) => {
    // Radix opens a select on pointer-down, as it does a menu.
    fireEvent.pointerDown(screen.getByRole('combobox', { name: combobox }), { button: 0, pointerId: 1, pointerType: 'mouse' });
    fireEvent.click(screen.getByRole('option', { name: option }));
  };

  it('is not asked until Xero has an organisation', () => {
    render(<InvoiceSettingsPage />);
    expect(screen.queryByRole('columnheader', { name: 'Xero organisation' })).not.toBeInTheDocument();
  });

  it('is chosen from the connected organisations, against the product as it was read', () => {
    hooks.view.current = { ...VIEW, organisations: ORGANISATIONS };
    render(<InvoiceSettingsPage />);
    expect(screen.getByRole('columnheader', { name: 'Xero organisation' })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('combobox', { name: 'Xero organisation for Filter Change' }), { button: 0, pointerId: 1, pointerType: 'mouse' });
    // One no longer connected is not offered.
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Not chosen', 'Example Home Services', 'Example Pest Co']);
    fireEvent.click(screen.getByRole('option', { name: 'Example Pest Co' }));
    expect(hooks.changeProduct.mutate).toHaveBeenCalledWith(
      { id: 'p1', input: { xeroTenantId: 'a2000000-0000-4000-8000-000000000002', expectedUpdatedAt: SAVED_AT } },
      expect.anything(),
    );
  });

  it('goes back to none', () => {
    hooks.view.current = {
      ...VIEW,
      organisations: ORGANISATIONS,
      products: [{ ...VIEW.products[0]!, xeroTenantId: 'a1000000-0000-4000-8000-000000000001' }],
    };
    render(<InvoiceSettingsPage />);
    pick('Xero organisation for Filter Change', 'Not chosen');
    expect(hooks.changeProduct.mutate).toHaveBeenCalledWith({ id: 'p1', input: { xeroTenantId: null, expectedUpdatedAt: SAVED_AT } }, expect.anything());
  });

  it('still shows an organisation since disconnected, so it can be changed', () => {
    hooks.view.current = {
      ...VIEW,
      organisations: ORGANISATIONS,
      products: [{ ...VIEW.products[0]!, xeroTenantId: 'a3000000-0000-4000-8000-000000000003' }],
    };
    render(<InvoiceSettingsPage />);
    expect(screen.getByRole('combobox', { name: 'Xero organisation for Filter Change' })).toHaveTextContent('Old Books LLC (not connected)');
  });

  it('is read, not changed, by whoever does not make invoices', () => {
    permissions.granted = new Set(['invoices:read']);
    hooks.view.current = {
      ...VIEW,
      organisations: ORGANISATIONS,
      products: [{ ...VIEW.products[0]!, xeroTenantId: 'a2000000-0000-4000-8000-000000000002' }],
    };
    render(<InvoiceSettingsPage />);
    expect(screen.queryByRole('combobox', { name: 'Xero organisation for Filter Change' })).not.toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Example Pest Co' })).toBeInTheDocument();
  });
});
