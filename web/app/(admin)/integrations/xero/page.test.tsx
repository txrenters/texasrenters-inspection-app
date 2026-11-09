import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { XeroConnectionView } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import XeroPage from './page';

/**
 * The office's Xero organisation (2026-11-10, phase 1 of the Xero plan):
 * connected by whoever runs the integrations, then read, never written.
 * Everything invented.
 */

const xero = vi.hoisted(() => ({
  view: null as unknown,
  authorize: { mutateAsync: vi.fn(), isPending: false },
  read: { mutate: vi.fn(), isPending: false },
  disconnect: { mutate: vi.fn(), isPending: false },
}));
vi.mock('@/lib/xero-queries', () => ({
  useXeroConnection: () => ({ isLoading: false, isError: false, data: xero.view, refetch: vi.fn() }),
  useXeroActions: () => ({ authorize: xero.authorize, read: xero.read, disconnect: xero.disconnect }),
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
};

beforeEach(() => {
  vi.clearAllMocks();
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

  it('shows what was read: the organisation, where sales and payments can go, and its tax rates', () => {
    xero.view = CONNECTED;
    render(<XeroPage />);
    expect(screen.getByText('4 of 300')).toBeInTheDocument();
    const sales = screen.getByRole('heading', { name: /Where sales go/ }).closest('section')!;
    expect(within(sales).getByText('Service revenue')).toBeInTheDocument();
    // An archived account is not offered.
    expect(within(sales).queryByText('Old revenue')).not.toBeInTheDocument();
    const payments = screen.getByRole('heading', { name: /Where payments land/ }).closest('section')!;
    expect(within(payments).getByText('Operating checking')).toBeInTheDocument();
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
