import { requestJson } from '../src/repositories/api/repositories';
import { ApiConnectionError } from '../src/storage/offline-record-cache';

/**
 * Which failure a request reports, and why the distinction is load-bearing.
 *
 * `requestJson` throws `ApiConnectionError` for four different things, and the
 * offline write queue used to hold a write for all of them — so a phone on
 * full bars, talking to an API that was up and answering 500, was told its
 * work would send "when you are back on a network". `classifyWriteFailure`
 * decides what to hold, but it can only be as right as the `reason` it is
 * given, and nothing else in the app would notice if this mapping drifted.
 *
 * Pinned here rather than in the queue's own test because this is the seam:
 * the queue test asserts the rule, this asserts the facts it runs on.
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
const replyWith = (status: number) => {
  globalThis.fetch = (async () => ({
    ok: status < 400,
    status,
    text: async () => '',
    json: async () => ({ message: `TexasRenters API request failed (${status}).` }),
  })) as never;
};

const write = () => requestJson('/api/v1/technician/rooms/room-1/note', { method: 'PATCH' });

const reasonOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof ApiConnectionError ? error.reason : `plain:${(error as Error).name}`;
  }
  throw new Error('the request was expected to fail');
};

describe('what a failed request reports as its cause', () => {
  it('calls a rejected fetch a transport failure — nothing left the handset', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Network request failed');
    }) as never;

    await expect(reasonOf(write)).resolves.toBe('transport');
  });

  /**
   * The three codes an edge returns when it could not reach the app behind it.
   * `requestJson` already trusts this reading for GETs, where they are the
   * only statuses that move on to the next base URL.
   */
  it.each([502, 503, 504])('calls %i unavailable — the edge answered, not the app', async (status) => {
    replyWith(status);

    await expect(reasonOf(write)).resolves.toBe('unavailable');
  });

  /**
   * The case the queue was getting wrong. A 500 is the app's own answer: it
   * received the request, ran, and failed — possibly on this exact payload,
   * every time.
   */
  it('calls a 500 a fault — the app received it and failed on it', async () => {
    replyWith(500);

    await expect(reasonOf(write)).resolves.toBe('fault');
  });

  it('leaves a 4xx a plain error, as it always was', async () => {
    replyWith(400);

    await expect(reasonOf(write)).resolves.toBe('plain:Error');
  });

  /** A 401 keeps its own path: the app signs out rather than queueing. */
  it('leaves a 401 to the session handling', async () => {
    replyWith(401);

    await expect(reasonOf(write)).resolves.toBe('plain:SessionExpiredError');
  });

  /**
   * The real 15-second deadline, not a stand-in: `requestJson` builds its own
   * AbortController, and the only way to tell its abort from a bare network
   * rejection is that `controller.signal.aborted` is set when fetch throws.
   */
  it('calls its own 15-second deadline a timeout', async () => {
    jest.useFakeTimers();
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
      })) as never;

    try {
      const pending = reasonOf(write);
      await jest.advanceTimersByTimeAsync(15_000);
      await expect(pending).resolves.toBe('timeout');
    } finally {
      jest.useRealTimers();
    }
  });
});
