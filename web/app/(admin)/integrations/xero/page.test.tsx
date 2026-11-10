import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { XeroConnectionView, XeroOrganisationView, XeroSendingView, XeroSettingsView } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import XeroPage from './page';

/**
 * The office's Xero organisations (2026-11-10): one sign-in, a tab for each
 * company's books, each read and chosen for on its own, never written.
 * Everything invented.
 */

const HOMES = 'a1000000-0000-4000-8000-000000000001';
const PEST = 'a2000000-0000-4000-8000-000000000002';

const xero = vi.hoisted(() => ({
  view: null as unknown,
  settings: {} as Record<string, unknown>,
  settingsAsked: [] as string[],
  save: { mutate: vi.fn(), isPending: false },
  authorize: { mutateAsync: vi.fn(), isPending: false },
  read: { mutate: vi.fn(), isPending: false, variables: undefined as string | undefined },
  disconnect: { mutate: vi.fn(), isPending: false },
  disconnectOrganisation: { mutate: vi.fn(), isPending: false },
  sendingAsked: [] as string[],
  sendingActions: { setEnabled: { mutate: vi.fn(), isPending: false }, run: { mutate: vi.fn(), isPending: false }, retry: { mutate: vi.fn(), isPending: false } },
}));
vi.mock('@/lib/xero-queries', () => ({
  useXeroConnection: () => ({ isLoading: false, isError: false, data: xero.view, refetch: vi.fn() }),
  useXeroActions: () => ({ authorize: xero.authorize, read: xero.read, disconnect: xero.disconnect, disconnectOrganisation: xero.disconnectOrganisation }),
  useXeroSettings: (tenantId: string) => {
    xero.settingsAsked.push(tenantId);
    return { isLoading: false, isError: false, data: xero.settings[tenantId], refetch: vi.fn() };
  },
  useSaveXeroSettings: () => xero.save,
  useXeroSending: (tenantId: string) => {
    xero.sendingAsked.push(tenantId);
    return { isLoading: false, isError: false, data: sending(tenantId), refetch: vi.fn() };
  },
  useXeroSendingActions: () => xero.sendingActions,
  // The month's check (2026-11-10, phase 5) has its own tests (xero-check-panel.test.tsx).
  useXeroCheck: () => ({ isLoading: false, isError: false, data: undefined, refetch: vi.fn() }),
  useRunXeroCheck: () => ({ mutate: vi.fn(), isPending: false }),
}));
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: (key: string) => permissions.granted.has(key) }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const DISCONNECTED: XeroConnectionView = {
  configured: true,
  status: 'DISCONNECTED',
  connectedAt: null,
  disconnectedAt: null,
  problem: null,
  scopes: [],
  organisations: [],
  dailyCeiling: 300,
};

const organisation = (over: Partial<XeroOrganisationView>): XeroOrganisationView => ({
  tenantId: HOMES,
  name: 'Example Home Services',
  status: 'CONNECTED',
  connectedAt: '2026-11-20T15:00:00.000Z',
  removedAt: null,
  organisation: { name: 'Example Home Services', legalName: null, baseCurrency: 'USD', countryCode: 'US', organisationType: 'COMPANY', salesTaxBasis: 'NONE', shortCode: '!aB1c' },
  accounts: [{ accountId: 'a1', code: '400', name: 'Service revenue', type: 'REVENUE', class: 'REVENUE', status: 'ACTIVE', takesPayments: false }],
  taxRates: [{ name: 'Tax Exempt', taxType: 'NONE', status: 'ACTIVE', effectiveRate: 0, appliesToRevenue: true }],
  readAt: '2026-11-20T15:00:05.000Z',
  readProblem: null,
  callsToday: 4,
  invoiceRemindersOn: false,
  ...over,
});

const CONNECTED: XeroConnectionView = {
  ...DISCONNECTED,
  status: 'CONNECTED',
  connectedAt: '2026-11-20T15:00:00.000Z',
  scopes: ['offline_access', 'accounting.settings.read', 'accounting.contacts', 'accounting.invoices', 'accounting.payments'],
  organisations: [
    organisation({}),
    organisation({ tenantId: PEST, name: 'Example Pest Co', callsToday: 9, organisation: null, taxRates: [] }),
    organisation({ tenantId: 'a3000000-0000-4000-8000-000000000003', name: 'Old Books LLC', status: 'REMOVED', removedAt: '2026-11-19T15:00:00.000Z' }),
  ],
};

const settings = (tenantId: string): XeroSettingsView => ({
  tenantId,
  values: { sendFrom: null, salesAccountId: null, salesTaxType: null, salesAccounts: {}, paymentAccounts: {} },
  products: [{ nameKey: 'move-out inspection', name: 'Move-out inspection', listed: true, active: true, accountId: null }],
  payments: [{ method: 'PROPERTYWARE_LEDGER', accountId: null, payments: 3 }],
  withoutOrganisation: 0,
  invoicesToSend: 5,
  checks: [{ key: 'sendFrom', label: 'A start date', ok: false, detail: 'Choose the first day whose invoices go to Xero.' }],
  ready: false,
  updatedAt: null,
});

function sending(tenantId: string): XeroSendingView {
  return {
    tenantId,
    enabled: false,
    changedAt: null,
    canWrite: true,
    blockers: ['Finish “Before anything is sent”.'],
    counts: { sent: 0, failed: 0, notYet: 5, noCompany: 0, payments: { sent: 0, failed: 0 }, writeOffs: { sent: 0, failed: 0 } },
    lastRunAt: null,
    lastRunProblem: null,
    failures: [],
    paymentFailures: [],
    writeOffFailures: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  xero.sendingAsked = [];
  xero.settings = { [HOMES]: settings(HOMES), [PEST]: settings(PEST) };
  xero.settingsAsked = [];
  xero.read.variables = undefined;
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

  it('gives each connected organisation a tab, with Xero’s id for it and its own calls today', () => {
    xero.view = CONNECTED;
    render(<XeroPage />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Example Home Services', 'Example Pest Co']);
    expect(screen.getByText(HOMES)).toBeInTheDocument();
    expect(screen.getByText('4 of 300')).toBeInTheDocument();
    // Only the tab shown asks for its choices.
    expect(new Set(xero.settingsAsked)).toEqual(new Set([HOMES]));
    const sales = screen.getByRole('heading', { name: /Where sales go/ }).closest('section')!;
    expect(within(sales).getByRole('combobox', { name: 'Account for Move-out inspection' })).toBeInTheDocument();
  });

  it('switches to another organisation’s tab: its own reading and choices', async () => {
    xero.view = CONNECTED;
    render(<XeroPage />);
    const tab = screen.getByRole('tab', { name: 'Example Pest Co' });
    // Radix moves to a tab on mouse-down.
    fireEvent.mouseDown(tab, { button: 0 });
    await waitFor(() => expect(screen.getByText('9 of 300')).toBeInTheDocument());
    expect(xero.settingsAsked).toContain(PEST);
  });

  it('lists an organisation the sign-in no longer reaches, out of the tabs', () => {
    xero.view = CONNECTED;
    render(<XeroPage />);
    const panel = screen.getByRole('heading', { name: /No longer connected/ }).closest('section')!;
    expect(within(panel).getByText('Old Books LLC')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Old Books LLC' })).not.toBeInTheDocument();
  });

  it('reads one organisation again, and disconnects one only once asked', () => {
    xero.view = CONNECTED;
    render(<XeroPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Read from Xero' }));
    expect(xero.read.mutate).toHaveBeenCalledWith(HOMES, expect.anything());
    const panel = screen.getByRole('heading', { name: 'Organisation' }).closest('section')!;
    fireEvent.click(within(panel).getByRole('button', { name: 'Disconnect' }));
    expect(xero.disconnectOrganisation.mutate).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Disconnect Example Home Services?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect(xero.disconnectOrganisation.mutate).toHaveBeenCalledWith(HOMES, expect.anything());
    expect(xero.disconnect.mutate).not.toHaveBeenCalled();
  });

  it('offers to add or remove organisations, which is Xero’s own screen again', async () => {
    xero.view = CONNECTED;
    xero.authorize.mutateAsync.mockResolvedValue({ authorizationUrl: 'https://login.xero.com/identity/connect/authorize?x=2' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<XeroPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add or remove organisations' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://login.xero.com/identity/connect/authorize?x=2', '_blank', 'noopener,noreferrer'));
  });

  it('is only seen by whoever reads the integrations, and changed by whoever runs them', () => {
    xero.view = CONNECTED;
    permissions.granted = new Set(['integrations:read']);
    render(<XeroPage />);
    expect(screen.queryByRole('button', { name: 'Read from Xero' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add or remove organisations' })).not.toBeInTheDocument();
  });

  it('says why it must be connected again', () => {
    xero.view = { ...DISCONNECTED, status: 'REAUTHORIZATION_REQUIRED', problem: 'Xero refused the stored sign-in. Connect again.' };
    render(<XeroPage />);
    expect(screen.getByText('Xero refused the stored sign-in. Connect again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect again' })).toBeInTheDocument();
  });
});

describe('sending invoices', () => {
  it('belongs to each organisation’s tab, and says what it waits for', () => {
    xero.view = CONNECTED;
    render(<XeroPage />);
    const panel = screen.getByRole('heading', { name: /Sending to Xero/ }).closest('section')!;
    expect(within(panel).getByText('Finish “Before anything is sent”.')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Turn on' })).toBeDisabled();
    expect(new Set(xero.sendingAsked)).toEqual(new Set([HOMES]));
  });

  it('asks Xero again for a sign-in made to read only', async () => {
    xero.view = { ...CONNECTED, scopes: ['offline_access', 'accounting.settings.read'] };
    xero.authorize.mutateAsync.mockResolvedValue({ authorizationUrl: 'https://login.xero.com/identity/connect/authorize?x=3' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<XeroPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Allow sending' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://login.xero.com/identity/connect/authorize?x=3', '_blank', 'noopener,noreferrer'));
  });

  it('does not ask again once it may write', () => {
    xero.view = CONNECTED;
    render(<XeroPage />);
    expect(screen.queryByRole('button', { name: 'Allow sending' })).not.toBeInTheDocument();
  });
});
