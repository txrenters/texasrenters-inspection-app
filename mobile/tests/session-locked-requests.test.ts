import { requestJson } from '../src/repositories/api/repositories';
import { ApiConnectionError, SessionExpiredError } from '../src/storage/offline-record-cache';

/**
 * A request made from a locked iPhone, once its token has run out.
 *
 * The session cannot be renewed there (`sessionMaySaveNow`), and it is not gone
 * either. Reported as "not reached" -- nothing left the phone -- so a read
 * answers from what is stored and a write is held, exactly as with no signal.
 * Never as an expired session, which sends the technician to sign in.
 */

const mockGetSession = jest.fn();

jest.mock('../src/auth/session', () => {
  class SessionUnavailableError extends Error {}
  return {
    getSession: (...args: unknown[]) => mockGetSession(...args),
    SessionUnavailableError,
  };
});
jest.mock('../src/config/environment', () => ({
  environment: { apiBaseUrl: 'https://api.test', apiBaseUrls: ['https://api.test'] },
}));

const { SessionUnavailableError } = jest.requireMock<{
  SessionUnavailableError: new (message: string) => Error;
}>('../src/auth/session');

describe('a request from a locked phone with a spent token', () => {
  it('is not reached, rather than signed out, and nothing is sent', async () => {
    const fetchCalls: unknown[] = [];
    globalThis.fetch = (async (...args: unknown[]) => {
      fetchCalls.push(args);
      return { ok: true, status: 200, text: async () => '{}' };
    }) as never;
    mockGetSession.mockImplementation(async () => {
      throw new SessionUnavailableError('The phone is locked.');
    });

    const failure = requestJson('/api/v1/technician/dashboard');

    await expect(failure).rejects.toBeInstanceOf(ApiConnectionError);
    await expect(failure).rejects.toMatchObject({ reason: 'transport' });
    await expect(failure).rejects.not.toBeInstanceOf(SessionExpiredError);
    expect(fetchCalls).toHaveLength(0);
  });

  it('still reports a missing session as signed out', async () => {
    mockGetSession.mockImplementation(async () => null);

    await expect(requestJson('/api/v1/technician/dashboard')).rejects.toBeInstanceOf(SessionExpiredError);
  });
});
