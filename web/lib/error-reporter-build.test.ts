import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which build a crash report came from.
 *
 * Every console report ever filed carried `Build: —`, because the reporter read
 * `NEXT_PUBLIC_BUILD_ID` and nothing sets it — not `docker/web/Dockerfile`, not
 * the publish workflow, not any env file. The variable CI does set, and which
 * the console footer already shows, is `NEXT_PUBLIC_APP_VERSION`.
 *
 * It sounds cosmetic and is not. That field is what ages a report: a React #185
 * burst from 9 September was indistinguishable from one filed today, with six
 * releases in between and no way to tell whether the fix had already shipped.
 */

const post = vi.fn();

beforeEach(() => {
  vi.resetModules();
  post.mockReset().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', post);
  vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000000' });
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
  });
  process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.test';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_APP_VERSION;
});

/** The JSON one report was sent with. */
async function sendOne() {
  const { reportError, flush } = await import('./error-reporter');
  reportError(new Error('boom'), 'test', true);
  await flush();
  const body = post.mock.calls.at(-1)?.[1]?.body as string | undefined;
  return body ? (JSON.parse(body) as { buildId?: string }) : undefined;
}

describe('naming the build a report came from', () => {
  it('sends the release the console is running', async () => {
    process.env.NEXT_PUBLIC_APP_VERSION = 'v2.5.23';

    expect((await sendOne())?.buildId).toBe('v2.5.23');
  });

  it('normalises a tag published without its v', async () => {
    // The image tag drops the leading `v`, so the raw variable can arrive
    // either way. The footer and the report should not disagree about the name
    // of the same build.
    process.env.NEXT_PUBLIC_APP_VERSION = '2.5.23';

    expect((await sendOne())?.buildId).toBe('v2.5.23');
  });

  it('sends nothing rather than the word "dev" from an unpublished build', async () => {
    /**
     * A local build has no release, and `APP_VERSION_LABEL` says `dev` so the
     * footer reads sensibly. Filing that as a build id would put a row in the
     * error log claiming to come from a build called "dev", which is worse than
     * an empty field: it looks like real provenance.
     */
    expect((await sendOne())?.buildId).toBeUndefined();
  });
});
