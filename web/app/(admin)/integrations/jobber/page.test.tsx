import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import JobberIntegrationPage from './page';

/**
 * Renders the page against a CONNECTED account.
 *
 * That is the state the Reconnect button and its explanatory line appear in,
 * and the state the page was throwing a client-side exception in on the beta
 * stack. A page this full of conditional branches deserves at least one test
 * that actually mounts it.
 */
const hooks = vi.hoisted(() => ({
  useJobberConnection: vi.fn(),
  useJobberQueue: vi.fn(),
  useJobberVisitImports: vi.fn(),
  useJobberMutations: vi.fn(),
  useLeases: vi.fn(),
  usePropertyOptions: vi.fn(),
  useUnits: vi.fn(),
}));

vi.mock('@/lib/queries', () => hooks);
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: () => true }) }));
vi.mock('@/lib/url-state', () => ({ useUrlState: () => [{ tab: 'queue' }, vi.fn()] }));

const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isSuccess: false, data: undefined };

function connected(status = 'CONNECTED') {
  hooks.useJobberConnection.mockReturnValue({
    isLoading: false,
    isError: false,
    data: {
      status,
      jobberAccountName: 'Texas Home Maintenance Pros',
      apiVersion: '2025-01-20',
      connectedAt: '2026-09-01T13:25:48.000Z',
      lastSyncCompletedAt: '2026-09-01T14:31:56.000Z',
      lastSyncVisitCount: 212,
    },
  });
  hooks.useJobberQueue.mockReturnValue({ isLoading: false, data: [] });
  hooks.useJobberVisitImports.mockReturnValue({ isLoading: false, data: [] });
  hooks.useJobberMutations.mockReturnValue({
    authorize: idle,
    disconnect: idle,
    sync: idle,
    link: idle,
    ignore: idle,
  });
  hooks.useLeases.mockReturnValue({ data: undefined });
  hooks.usePropertyOptions.mockReturnValue({ data: undefined });
  hooks.useUnits.mockReturnValue({ data: undefined });
}

describe('Jobber integration page', () => {
  it('renders a connected account without throwing', () => {
    connected();
    render(<JobberIntegrationPage />);
    expect(screen.getByText('Texas Home Maintenance Pros')).toBeTruthy();
  });

  it('offers Reconnect while connected, not only Connect while disconnected', () => {
    // Widening the app's scopes in Jobber invalidates its refresh token, so a
    // healthy-looking connection needs re-consent. Without this the only route
    // was Disconnect then Connect.
    connected();
    render(<JobberIntegrationPage />);
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });

  it('explains why Reconnect exists, since it reads as a fix for something broken', () => {
    connected();
    render(<JobberIntegrationPage />);
    expect(screen.getByText(/scope change invalidates the stored credentials/)).toBeTruthy();
  });

  it('shows Connect and no Reconnect while disconnected', () => {
    connected('DISCONNECTED');
    render(<JobberIntegrationPage />);
    expect(screen.getByRole('button', { name: 'Connect Jobber' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
  });
});
