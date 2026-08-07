import { QueryClient } from '@tanstack/react-query';

let mockSessionUserId: string | null = 'tech-1';

jest.mock('../src/auth/session', () => ({
  getSession: async () =>
    mockSessionUserId ? { authUserId: mockSessionUserId, accessToken: 'token' } : null,
  onSessionChange: () => () => undefined,
}));

// Imported after the mock on purpose: these modules pull in `auth/session` at
// evaluation time, so hoisting them above `jest.mock` would bind the real
// module before the double is installed.
/* eslint-disable import/first */
import { demoStorage } from '../src/storage/demo-storage';
import {
  buster,
  clearQueryCache,
  persistQueryCache,
  restoreQueryCache,
} from '../src/storage/query-cache-persistence';
/* eslint-enable import/first */

const KEY = 'texasrenters-query-cache-v1:tech-1';

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Writes a payload straight to disk, standing in for a previous app run. */
async function seed(payload: unknown, key = KEY) {
  await demoStorage.setItem(key, JSON.stringify(payload));
}

function dehydratedOneQuery(queryKey: unknown[], data: unknown) {
  return {
    mutations: [],
    queries: [
      {
        queryKey,
        queryHash: JSON.stringify(queryKey),
        state: {
          data,
          dataUpdateCount: 1,
          dataUpdatedAt: Date.now(),
          error: null,
          errorUpdateCount: 0,
          errorUpdatedAt: 0,
          fetchFailureCount: 0,
          fetchFailureReason: null,
          fetchMeta: null,
          isInvalidated: false,
          status: 'success',
          fetchStatus: 'idle',
        },
      },
    ],
  };
}

beforeEach(async () => {
  mockSessionUserId = 'tech-1';
  await demoStorage.removeItem(KEY);
  await demoStorage.removeItem('texasrenters-query-cache-v1:tech-2');
});

describe('restoreQueryCache', () => {
  it('repaints the last known screen data without a request', async () => {
    await seed({
      buster: buster(),
      savedAt: Date.now(),
      state: dehydratedOneQuery(['dashboard'], { assignments: [{ id: 'insp-1' }] }),
    });

    const queryClient = client();
    expect(await restoreQueryCache(queryClient)).toBe(true);
    expect(queryClient.getQueryData(['dashboard'])).toEqual({
      assignments: [{ id: 'insp-1' }],
    });
  });

  it('drops a cache written by a different app version', async () => {
    // The whole point of the buster: restored payloads are not re-validated
    // against their schemas, so a release that renames a field would hand the
    // screen data shaped for the previous build.
    await seed({
      buster: '0.0.1-old',
      savedAt: Date.now(),
      state: dehydratedOneQuery(['dashboard'], { assignments: [] }),
    });

    const queryClient = client();
    expect(await restoreQueryCache(queryClient)).toBe(false);
    expect(queryClient.getQueryData(['dashboard'])).toBeUndefined();
    expect(await demoStorage.getItem(KEY)).toBeNull();
  });

  it('drops a cache written by an older shape at the same app version', async () => {
    // The case the app version could not catch, and the one that actually bit:
    // `version` sat at 0.1.0 for all of development, so every DTO change shipped
    // against caches written by the previous shape. The review screen crashed on
    // `room.findings.map` because the restored rooms predated that field.
    const [appVersion] = buster().split(':');
    await seed({
      buster: `${appVersion}:1`,
      savedAt: Date.now(),
      state: dehydratedOneQuery(['dashboard'], { assignments: [] }),
    });

    const queryClient = client();
    expect(await restoreQueryCache(queryClient)).toBe(false);
    expect(await demoStorage.getItem(KEY)).toBeNull();
  });

  it('carries both the app version and the shape version', async () => {
    // Either one moving has to invalidate the cache, so neither may be dropped
    // from the key.
    expect(buster()).toMatch(/^.+:\d+$/);
  });

  it('drops data older than a day rather than presenting it as current', async () => {
    await seed({
      buster: buster(),
      savedAt: Date.now() - 25 * 60 * 60_000,
      state: dehydratedOneQuery(['dashboard'], { assignments: [{ id: 'stale' }] }),
    });

    const queryClient = client();
    expect(await restoreQueryCache(queryClient)).toBe(false);
    expect(queryClient.getQueryData(['dashboard'])).toBeUndefined();
  });

  it('discards a corrupt payload instead of wedging every future launch', async () => {
    await demoStorage.setItem(KEY, '{ not json');

    const queryClient = client();
    expect(await restoreQueryCache(queryClient)).toBe(false);
    expect(await demoStorage.getItem(KEY)).toBeNull();
  });

  it('reads nothing when no technician is signed in', async () => {
    await seed({
      buster: buster(),
      savedAt: Date.now(),
      state: dehydratedOneQuery(['dashboard'], { assignments: [] }),
    });
    mockSessionUserId = null;

    const queryClient = client();
    expect(await restoreQueryCache(queryClient)).toBe(false);
    expect(queryClient.getQueryData(['dashboard'])).toBeUndefined();
  });

  it('never hands one technician the cache of another', async () => {
    await seed(
      {
        buster: buster(),
        savedAt: Date.now(),
        state: dehydratedOneQuery(['dashboard'], { assignments: [{ id: 'not-yours' }] }),
      },
      KEY,
    );
    mockSessionUserId = 'tech-2';

    const queryClient = client();
    expect(await restoreQueryCache(queryClient)).toBe(false);
    expect(queryClient.getQueryData(['dashboard'])).toBeUndefined();
  });
});

describe('persistQueryCache', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('writes successful query data and restores it into a fresh client', async () => {
    jest.useFakeTimers();
    const source = client();
    const stop = persistQueryCache(source);
    source.setQueryData(['dashboard'], { assignments: [{ id: 'insp-9' }] });
    jest.advanceTimersByTime(2_100);
    jest.useRealTimers();
    await flush();
    stop();

    const target = client();
    expect(await restoreQueryCache(target)).toBe(true);
    expect(target.getQueryData(['dashboard'])).toEqual({ assignments: [{ id: 'insp-9' }] });
  });

  it('does not persist a failed query as though it were content', async () => {
    jest.useFakeTimers();
    const source = client();
    const stop = persistQueryCache(source);
    source.setQueryData(['dashboard'], { assignments: [] });
    // A query that errored has status 'error' and must not reach disk, or the
    // next launch restores a broken-looking screen before any request is made.
    source.getQueryCache().build(source, { queryKey: ['inspection', 'x'] });
    jest.advanceTimersByTime(2_100);
    jest.useRealTimers();
    await flush();
    stop();

    const stored = await demoStorage.getItem(KEY);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored as string) as { state: { queries: unknown[] } };
    expect(parsed.state.queries).toHaveLength(1);
  });

  it('stops writing once unsubscribed', async () => {
    jest.useFakeTimers();
    const source = client();
    const stop = persistQueryCache(source);
    stop();
    source.setQueryData(['dashboard'], { assignments: [] });
    jest.advanceTimersByTime(5_000);
    jest.useRealTimers();
    await flush();

    expect(await demoStorage.getItem(KEY)).toBeNull();
  });
});

describe('clearQueryCache', () => {
  it('erases the stored snapshot for the signed-in technician', async () => {
    await seed({
      buster: buster(),
      savedAt: Date.now(),
      state: dehydratedOneQuery(['dashboard'], { assignments: [] }),
    });

    await clearQueryCache();
    expect(await demoStorage.getItem(KEY)).toBeNull();
  });
});
