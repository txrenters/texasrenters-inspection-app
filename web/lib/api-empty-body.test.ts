import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { api } from './api';

/**
 * An empty response body is an answer, not a failure.
 *
 * A Nest handler that returns `null` — "no comparison for this move-out yet",
 * "no import running against this inspection" — serialises as a **200 with no
 * body**, not a 204. Calling `.json()` on that throws "Unexpected end of JSON
 * input", and the console painted a data-loading error over a page that was
 * working perfectly: the answer really was nothing.
 *
 * It reached a user as "This data could not be loaded" on the move-in
 * comparison tab of an inspection that simply had no comparison yet.
 */

vi.mock('./session', () => ({
  getSession: () => Promise.resolve({ accessToken: 'token' }),
  signOut: vi.fn(),
}));

const respond = (init: { status: number; body: string }) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    headers: { get: () => null },
    text: () => Promise.resolve(init.body),
    json: () => (init.body ? Promise.resolve(JSON.parse(init.body)) : Promise.reject(new Error('empty'))),
  } as unknown as Response);

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.test';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reading a response', () => {
  it('reads an empty 200 as null rather than throwing', async () => {
    // The reported bug, exactly: the comparison endpoint answers `null` for a
    // move-out that has none yet.
    respond({ status: 200, body: '' });
    await expect(api('/api/v1/admin/inspections/x/comparison')).resolves.toBeNull();
  });

  it('still parses a body when there is one', async () => {
    respond({ status: 200, body: '{"id":"comparison-1"}' });
    await expect(api('/api/v1/admin/inspections/x/comparison')).resolves.toEqual({
      id: 'comparison-1',
    });
  });

  it('still treats 204 as nothing', async () => {
    respond({ status: 204, body: '' });
    await expect(api('/api/v1/admin/thing')).resolves.toBeUndefined();
  });

  it('does not swallow a real error response', async () => {
    // The guard against fixing an empty body by treating every failure as one.
    respond({ status: 409, body: '{"code":"REPORT_ALREADY_IMPORTED","message":"nope"}' });
    await expect(api('/api/v1/admin/thing')).rejects.toMatchObject({
      status: 409,
      code: 'REPORT_ALREADY_IMPORTED',
    });
  });

  it('still reports malformed JSON rather than hiding it', async () => {
    // An empty body is an answer; a truncated one is a fault, and pretending
    // otherwise would turn a broken endpoint into a silent null.
    respond({ status: 200, body: '{"id":' });
    await expect(api('/api/v1/admin/thing')).rejects.toThrow();
  });
});
