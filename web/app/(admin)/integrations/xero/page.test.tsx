import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { XeroConnectionView, XeroSendingView, XeroSettingsView } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import XeroPage from './page';

/**
 * The office's Xero organisation (2026-11-10, phases 1-3 of the Xero plan):
 * connected by whoever runs the integrations, read, its accounts chosen, and
 * its invoices sent once that is all in place. Everything invented.
 */

const xero = vi.hoisted(() => ({
  view: null as unknown,
  settings: null as unknown,
  sending: null as unknown,
  sendingActions: { setEnabled: { mutate: vi.fn(), isPending: false }, run: { mutate: vi.fn(), isPending: false }, retry: { mutate: vi.fn(), isPending: false } },
  save: { mutate: vi.fn(), isPending: false },
  authorize: { mutateAsync: vi.fn(), isPending: false },
  read: { mutate: vi.fn(), isPending: false },
  disconnect: { mutate: vi.fn(), isPending: false },
}));
vi.mock('@/lib/xero-queries', () => ({
  useXeroConnection: () => ({ isLoading: false, isError: false, data: xero.view, refetch: vi.fn() }),
  useXeroActions: () => ({ authorize: xero.authorize, read: xero.read, disconnect: xero.disconnect }),
  useXeroSettings: () => ({ isLoading: false, isError: false, data: xero.settings, refetch: vi.fn() }),
  useSaveXeroSettings: () => xero.save,
  useXeroSending: () => ({ isLoading: false, isError: false, data: xero.sending, refetch: vi.fn() }),
  useXeroSendingActions: () => xero.sendingActions,
}));
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: (key: string) => permissions.granted.has(key) }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const DISCONNECTED: XeroConnectionView = {
  configured: true,
  status: 'DISCONNECTED',
  tenantName: null,
  connectedAt: null,
  disconnectedAt: null,
  problem: null,
  scopes: [],
  organisation: null,
  accounts: [],
  taxRates: [],
  readAt: null,
  readProblem: null,
  callsToday: 0,
  dailyCeiling: 300,
  invoiceRemindersOn: null,
};

const CONNECTED: XeroConnectionView = {
  ...DISCONNECTED,
  status: 'CONNECTED',
  tenantName: 'Example Homes LLC',
  connectedAt: '2026-11-20T15:00:00.000Z',
  organisation: { name: 'Example Homes LLC', legalName: null, baseCurrency: 'USD', countryCode: 'US', organisationType: 'COMPANY', salesTaxBasis: 'NONE', shortCode: '!aB1c' },
  accounts: [
    { accountId: 'a1', code: '400', name: 'Service revenue', type: 'REVENUE', class: 'REVENUE', status: 'ACTIVE', takesPayments: false },
    { accountId: 'a2', code: '460', name: 'Old revenue', type: 'REVENUE', class: 'REVENUE', status: 'ARCHIVED', takesPayments: false },
    { accountId: 'a3', code: null, name: 'Operating checking', type: 'BANK', class: 'ASSET', status: 'ACTIVE', takesPayments: true },
  ],
  taxRates: [{ name: 'Tax Exempt', taxType: 'NONE', status: 'ACTIVE', effectiveRate: 0, appliesToRevenue: true }],
  readAt: '2026-11-20T15:00:05.000Z',
  callsToday: 4,
  scopes: ['offline_access', 'accounting.settings.read', 'accounting.contacts', 'accounting.invoices', 'accounting.payments'],
  invoiceRemindersOn: false,
};

const SENDING: XeroSendingView = {
  enabled: false,
  changedAt: null,
  canWrite: true,
  blockers: ['Finish “Before anything is sent”.'],
  counts: { sent: 0, failed: 0, notYet: 5 },
  lastRunAt: null,
  lastRunProblem: null,
  failures: [],
};

const SETTINGS: XeroSettingsView = {
  values: { sendFrom: null, salesAccountId: null, salesTaxType: null, salesAccounts: {}, paymentAccounts: {} },
  products: [{ nameKey: 'move-out inspection', name: 'Move-out inspection', listed: true, active: true, accountId: null }],
  payments: [{ method: 'PROPERTYWARE_LEDGER', accountId: null, payments: 3 }],
  invoicesToSend: 5,
  checks: [{ key: 'sendFrom', label: 'A start date', ok: false, detail: 'Choose the first day whose invoices go to Xero.' }],
  ready: false,
  updatedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  xero.settings = SETTINGS;
  xero.sending = SENDING;
  permissions.granted = new Set(['integrations:read', 'integrations:manage']);
  xero.view = DISCONNECTED;
});

describe('the Xero page', () => {
  it('opens Xero’s sign-in in a tab of its own', async () => {
    xero.authorize.mutateAsync.mockResolvedValue({ authorizationUrl: 'https://login.xero.com/identity/connect/authorize?x=1' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<XeroPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Xero' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://login.xero.com/identity/connect/authorize?x=1', '_blank', 'noopener,noreferrer'));
  });

  it('says when the server has no Xero app yet, and offers no button', () => {
    xero.view = { ...DISCONNECTED, configured: false };
    render(<XeroPage />);
    expect(screen.getByText(/Xero is not set up on this server yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Xero' })).not.toBeInTheDocument();
  });

  it('shows what was read, and what goes where: each product or service, each payment method', () => {
    xero.view = CONNECTED;
    render(<XeroPage />);
    expect(screen.getByText('4 of 300')).toBeInTheDocument();
    expect(screen.getByText('Choose the first day whose invoices go to Xero.')).toBeInTheDocument();
    const sales = screen.getByRole('heading', { name: /Where sales go/ }).closest('section')!;
    expect(within(sales).getByRole('combobox', { name: 'Account for Move-out inspection' })).toHaveTextContent('The default');
    const payments = screen.getByRole('heading', { name: /Where payments land/ }).closest('section')!;
    expect(within(payments).getByRole('combobox', { name: 'Account for Propertyware ledger' })).toHaveTextContent('Not chosen');
    const taxes = screen.getByRole('heading', { name: /Tax rates/ }).closest('section')!;
    expect(within(taxes).getByText('NONE')).toBeInTheDocument();
    expect(within(taxes).getByText('Tax Exempt')).toBeInTheDocument();
  });

  it('reads again on the press, and disconnects only once asked', () => {
    xero.view = CONNECTED;
    render(<XeroPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Read from Xero' }));
    expect(xero.read.mutate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(xero.disconnect.mutate).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }));
    expect(xero.disconnect.mutate).toHaveBeenCalledTimes(1);
  });

  it('is only seen by whoever reads the integrations, and changed by whoever runs them', () => {
    xero.view = CONNECTED;
    permissions.granted = new Set(['integrations:read']);
    render(<XeroPage />);
    expect(screen.queryByRole('button', { name: 'Read from Xero' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });

  it('says why it must be connected again', () => {
    xero.view = { ...DISCONNECTED, status: 'REAUTHORIZATION_REQUIRED', problem: 'Xero refused the stored sign-in. Connect again.' };
    render(<XeroPage />);
    expect(screen.getByText('Xero refused the stored sign-in. Connect again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect again' })).toBeInTheDocument();
  });
});

describe('choosing what goes where', () => {
  it('is not offered until Xero is connected', () => {
    render(<XeroPage />);
    expect(screen.queryByRole('heading', { name: /Where sales go/ })).not.toBeInTheDocument();
  });
});

describe('sending invoices', () => {
  it('shows what sending needs, under the choices', () => {
    xero.view = CONNECTED;
    render(<XeroPage />);
    const panel = screen.getByRole('heading', { name: /Sending to Xero/ }).closest('section')!;
    expect(within(panel).getByText('Finish “Before anything is sent”.')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Turn on' })).toBeDisabled();
  });

  it('asks Xero again for a connection made to read only', async () => {
    xero.view = { ...CONNECTED, scopes: ['offline_access', 'accounting.settings.read'] };
    xero.authorize.mutateAsync.mockResolvedValue({ authorizationUrl: 'https://login.xero.com/identity/connect/authorize?x=2' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<XeroPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Allow sending' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://login.xero.com/identity/connect/authorize?x=2', '_blank', 'noopener,noreferrer'));
  });

  it('does not ask again once it may write', () => {
    xero.view = CONNECTED;
    render(<XeroPage />);
    expect(screen.queryByRole('button', { name: 'Allow sending' })).not.toBeInTheDocument();
  });
});
