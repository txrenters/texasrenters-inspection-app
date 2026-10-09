import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ApiClientsPage from './page';

/**
 * Revoking a key cannot be undone, so it asks first (console-development); it
 * fired on one click before. And a failed issue or revoke is said on screen
 * rather than changing nothing.
 */
const hooks = vi.hoisted(() => ({
  useApiClients: vi.fn(),
  useApiClientMutations: vi.fn(),
}));
const urlState = vi.hoisted(() => ({ search: '' }));

vi.mock('@/lib/queries', () => hooks);
vi.mock('@/lib/url-state', () => ({
  useUrlState: () => [{ page: 1, search: urlState.search }, vi.fn()],
}));

const idle = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null });

const CLIENT = {
  id: 'client-1',
  name: 'Example integration',
  description: null,
  isActive: true,
  environment: 'LIVE',
  requireSignature: false,
  permissions: ['inspections:read'],
  rateLimitPerMinute: 60,
  allowedIps: [],
  keys: [
    {
      id: 'key-1',
      prefix: 'abc123',
      label: 'Production key',
      createdAt: '2026-09-01T15:00:00.000Z',
      lastUsedAt: null,
      lastUsedIp: null,
      expiresAt: null,
      revokedAt: null,
    },
  ],
};

let mutations: Record<string, ReturnType<typeof idle>>;

beforeEach(() => {
  urlState.search = '';
  mutations = {
    createClient: idle(),
    issueKey: idle(),
    revokeClient: idle(),
    revokeKey: idle(),
    updateClient: idle(),
  };
  hooks.useApiClientMutations.mockReturnValue(mutations);
  hooks.useApiClients.mockReturnValue({
    isPending: false,
    isError: false,
    data: { data: [CLIENT], total: 1 },
  });
});

describe('revoking an API key', () => {
  it('asks first, and revokes only on confirmation', () => {
    render(<ApiClientsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(mutations.revokeKey!.mutate).not.toHaveBeenCalled();

    const dialog = screen.getByRole('alertdialog', { name: 'Revoke Production key?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke key' }));
    expect(mutations.revokeKey!.mutate).toHaveBeenCalledWith({ id: 'client-1', keyId: 'key-1' });
  });

  it('leaves the key alone when the confirmation is cancelled', () => {
    render(<ApiClientsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mutations.revokeKey!.mutate).not.toHaveBeenCalled();
  });
});

describe('what the page says', () => {
  it('reports a key that could not be issued', () => {
    mutations.issueKey = { ...idle(), error: new Error('Too many keys.') as never };
    hooks.useApiClientMutations.mockReturnValue(mutations);
    render(<ApiClientsPage />);

    expect(screen.getByText('The key could not be issued')).toBeInTheDocument();
    expect(screen.getByText('Too many keys.')).toBeInTheDocument();
  });

  it('tells a search that matched nothing from an empty registry', () => {
    urlState.search = 'nothing like it';
    hooks.useApiClients.mockReturnValue({ isPending: false, isError: false, data: { data: [], total: 0 } });
    render(<ApiClientsPage />);

    expect(screen.getByText('Nothing matches “nothing like it”')).toBeInTheDocument();
    expect(screen.queryByText('No API clients yet')).toBeNull();
  });

  it('names the copy buttons without reading the key aloud', () => {
    render(<ApiClientsPage />);
    expect(screen.getByRole('button', { name: 'Copy key ID' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /abc123/ })).toBeNull();
  });
});
