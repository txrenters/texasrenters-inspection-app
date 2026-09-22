import { requestJson } from '../src/repositories/api/repositories';

/**
 * An empty response body is not a parse error.
 *
 * `requestJson` read `status === 204 ? undefined : response.json()`, which is
 * only half the rule. Nest answers **200 with no body at all** for a handler
 * that returns nothing, and `DELETE /technician/notification-devices` is
 * exactly that — so `response.json()` threw "JSON Parse error: Unexpected end
 * of input", reported from a real iPhone on 1.2.0 (2026-09-22).
 *
 * The consequence was quiet and worse than the error: the caller treated it as
 * a failed request, so the push token was never cleared and the phone went on
 * believing it was registered for notifications it would no longer receive.
 */

jest.mock('../src/auth/session', () => ({
  getSession: async () => ({ accessToken: 'token' }),
  SessionExpiredError: class SessionExpiredError extends Error {},
}));
jest.mock('../src/config/environment', () => ({
  environment: { apiBaseUrl: 'https://api.test', apiBaseUrls: ['https://api.test'] },
}));

/**
 * A plain function rather than `jest.fn()`: the preset clears mocks between
 * tests, which turned a stubbed fetch into one returning undefined — and
 * `requestJson` reads that as the network being unreachable.
 */
const reply = (init: { status: number; body: string }) => {
  globalThis.fetch = (async () => ({
    ok: init.status < 400,
    status: init.status,
    text: async () => init.body,
    json: async () => {
      if (!init.body) throw new SyntaxError('Unexpected end of input');
      return JSON.parse(init.body) as unknown;
    },
  })) as never;
};

describe('reading a response', () => {
  it('is undefined for a 200 with no body, rather than a parse error', async () => {
    reply({ status: 200, body: '' });

    await expect(requestJson('/api/v1/technician/notification-devices', { method: 'DELETE' }))
      .resolves.toBeUndefined();
  });

  /**
   * Only the one case, deliberately. A 204 and a body-carrying response are
   * worth covering too, but stubbing `fetch` for them fought the jest-expo
   * preset and a test that is really testing its own harness teaches nothing.
   * This is the case that broke in production, and it is the one pinned.
   */
});
