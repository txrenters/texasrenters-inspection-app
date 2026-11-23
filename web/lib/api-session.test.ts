import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError, apiBlob, apiUpload } from './api';
import { getSession, SessionUnavailableError, signOut } from './session';

/**
 * A request whose session could not be renewed (2026-11-24: "when remember me
 * is ticked, it should not expire for 12 hrs").
 *
 * The page used to show "Your session has expired" whenever the renewal before
 * a request got no answer -- a server restarting for a release, a dropped
 * connection -- with the session perfectly good. It is the same failure as the
 * request itself not reaching the API, and is reported as one.
 */

vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSession: vi.fn(),
  signOut: vi.fn(),
}));

const requests: Array<[string, () => Promise<unknown>]> = [
  ['api', () => api('/api/v1/admin/profile')],
  ['apiUpload', () => apiUpload('/api/v1/admin/files', new FormData())],
  ['apiBlob', () => apiBlob('/api/v1/admin/report.pdf')],
];

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.test';
  vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(getSession).mockReset();
  vi.mocked(signOut).mockReset();
});

describe('a request whose session renewal got no answer', () => {
  it.each(requests)('%s says the API could not be reached, not that the session expired', async (_name, send) => {
    vi.mocked(getSession).mockRejectedValue(new SessionUnavailableError());

    const error = await send().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    // Nothing was sent, and nobody was signed out.
    expect(fetch).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it.each(requests)('%s still says the session expired when there is none', async (_name, send) => {
    vi.mocked(getSession).mockResolvedValue(null);

    const error = await send().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 401, code: 'SESSION_EXPIRED' });
  });
});
