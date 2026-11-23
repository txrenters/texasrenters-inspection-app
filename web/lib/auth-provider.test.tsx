import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminGuard, AuthProvider, SESSION_RETRY_MS } from './auth';
import { getSession, SessionUnavailableError, type AppSession } from './session';

/**
 * Opening the console with a remembered sign-in whose hour is up (2026-11-24:
 * "when remember me is ticked, it should not expire for 12 hrs").
 *
 * The page renews before its first request. When that renewal got no answer --
 * the server restarting for a release, a laptop's Wi-Fi not back yet -- the
 * console took it for "no session" and sent the person to the login page.
 */

const mocks = vi.hoisted(() => ({ replace: vi.fn(), api: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('./api', () => ({ api: mocks.api }));
vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  getSession: vi.fn(),
  onSessionChange: () => () => undefined,
  signOut: vi.fn(),
}));

const session: AppSession = {
  accessToken: 'token',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  authUserId: 'auth-user',
  mustChangePassword: false,
};

/** Lets the provider's awaits and the effects after them run. */
const flush = () => act(async () => vi.advanceTimersByTimeAsync(0));

function openConsole() {
  render(
    <AuthProvider>
      <AdminGuard>
        <p>Dashboard</p>
      </AdminGuard>
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  mocks.api.mockResolvedValue({ isActive: true, memberships: [{ role: 'SYSTEM_ADMIN' }], permissions: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(getSession).mockReset();
  mocks.replace.mockReset();
  mocks.api.mockReset();
});

describe('opening the console when the session cannot be renewed yet', () => {
  it('keeps restoring and tries again, rather than sending a remembered sign-in to the login page', async () => {
    vi.mocked(getSession).mockRejectedValueOnce(new SessionUnavailableError()).mockResolvedValue(session);

    openConsole();
    await flush();

    expect(screen.getByText('Restoring secure session…')).toBeTruthy();
    expect(screen.getByText(new SessionUnavailableError().message)).toBeTruthy();
    expect(mocks.replace).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(SESSION_RETRY_MS));
    await flush();

    expect(getSession).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Dashboard')).toBeTruthy();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('still sends someone with no session to the login page', async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    openConsole();
    await flush();

    expect(mocks.replace).toHaveBeenCalledWith('/login');
    expect(screen.queryByText('Dashboard')).toBeNull();
  });
});
