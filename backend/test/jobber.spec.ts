import { createHash, randomBytes } from 'node:crypto';

import { openSecret, readEnvelopeKey, sealSecret } from '../src/common/secret-envelope';
import { JobberClient } from '../src/integrations/jobber/jobber.client';
import { JobberError } from '../src/integrations/jobber/jobber.errors';
import { JobberOAuthService } from '../src/integrations/jobber/jobber.oauth.service';
import type { JobberTokenService } from '../src/integrations/jobber/jobber.tokens.service';

const KEY = randomBytes(32).toString('hex');

const jobberEnvironment = {
  JOBBER_CLIENT_ID: 'client-id',
  JOBBER_CLIENT_SECRET: 'client-secret',
  JOBBER_API_VERSION: '2025-01-20',
  JOBBER_OAUTH_REDIRECT_URI: 'https://backend.example.com/api/v1/integrations/jobber/oauth/callback',
  JOBBER_TOKEN_ENCRYPTION_KEY: KEY,
};

const withEnvironment = <T>(overrides: Record<string, string | undefined>, build: () => T): T => {
  const previous = { ...process.env };
  Object.assign(process.env, jobberEnvironment, overrides);
  try {
    return build();
  } finally {
    process.env = previous;
  }
};

describe('secret envelope', () => {
  const key = readEnvelopeKey(KEY, 'TEST_KEY')!;

  it('round-trips a value', () => {
    expect(openSecret(sealSecret('refresh-token', key), key)).toBe('refresh-token');
  });

  it('produces a different envelope every time so ciphertext cannot be compared', () => {
    expect(sealSecret('refresh-token', key)).not.toBe(sealSecret('refresh-token', key));
  });

  it('refuses a value sealed under a different key rather than returning garbage', () => {
    const other = readEnvelopeKey(randomBytes(32).toString('hex'), 'TEST_KEY')!;
    expect(openSecret(sealSecret('refresh-token', key), other)).toBeNull();
  });

  it('detects a tampered ciphertext', () => {
    const [version, iv, tag, ciphertext] = sealSecret('refresh-token', key).split('.');
    const flipped = Buffer.from(ciphertext, 'base64url');
    flipped[0] ^= 0xff;
    expect(
      openSecret([version, iv, tag, flipped.toString('base64url')].join('.'), key),
    ).toBeNull();
  });

  it('rejects a key that does not decode to 32 bytes instead of padding it', () => {
    expect(() => readEnvelopeKey('too-short', 'TEST_KEY')).toThrow('TEST_KEY');
  });
});

describe('Jobber authorization flow', () => {
  const service = () => withEnvironment({}, () => new JobberOAuthService());

  it('derives the PKCE challenge from the verifier it stores in the state', () => {
    const oauth = service();
    const url = new URL(
      withEnvironment({}, () =>
        oauth.buildAuthorizationUrl({ organizationId: 'org-1', userId: 'user-1' }),
      ),
    );

    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = withEnvironment({}, () => oauth.readState(url.searchParams.get('state')!));
    const expected = createHash('sha256').update(state.codeVerifier).digest('base64url');
    expect(url.searchParams.get('code_challenge')).toBe(expected);
    expect(state.organizationId).toBe('org-1');
  });

  it('carries the organization through the redirect so the callback needs no session', () => {
    const oauth = service();
    const url = new URL(
      withEnvironment({}, () =>
        oauth.buildAuthorizationUrl({ organizationId: 'org-42', userId: null }),
      ),
    );
    // The verifier must never be readable by the browser that carries it.
    expect(url.searchParams.get('state')).not.toContain('org-42');
    expect(
      withEnvironment({}, () => oauth.readState(url.searchParams.get('state')!)).organizationId,
    ).toBe('org-42');
  });

  it('refuses a state it did not seal', () => {
    const oauth = service();
    expect(() => withEnvironment({}, () => oauth.readState('v1.aaa.bbb.ccc'))).toThrow(
      /could not be verified/,
    );
  });

  it('refuses a state older than the ten minutes an authorization code lives', () => {
    const oauth = service();
    const url = new URL(
      withEnvironment({}, () =>
        oauth.buildAuthorizationUrl({ organizationId: 'org-1', userId: null }),
      ),
    );
    const state = url.searchParams.get('state')!;
    const elevenMinutes = Date.now() + 11 * 60_000;
    jest.spyOn(Date, 'now').mockReturnValue(elevenMinutes);
    try {
      expect(() => withEnvironment({}, () => oauth.readState(state))).toThrow(/expired/);
    } finally {
      jest.spyOn(Date, 'now').mockRestore();
    }
  });
});

describe('Jobber GraphQL client', () => {
  const tokens = { getAccessToken: jest.fn(), refresh: jest.fn() } as unknown as JobberTokenService;

  const client = (overrides: Record<string, string | undefined> = {}) =>
    withEnvironment(overrides, () => new JobberClient(tokens));

  beforeEach(() => {
    jest.mocked(tokens.getAccessToken).mockResolvedValue('access-token');
    jest.mocked(tokens.refresh).mockResolvedValue('refreshed-token');
  });

  afterEach(() => jest.restoreAllMocks());

  const respondWith = (body: unknown, status = 200) =>
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: status === 200, status, json: async () => body } as Response);

  it('sends the pinned schema version, because an omitted header follows Jobber to current', async () => {
    const fetchMock = respondWith({ data: { account: { id: 'a', name: 'Texas Renters' } } });
    await client().fetchAccount('org-1');

    const headers = fetchMock.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers['x-jobber-graphql-version']).toBe('2025-01-20');
    expect(headers.authorization).toBe('Bearer access-token');
  });

  it('treats GraphQL errors inside a 200 as a failure', async () => {
    respondWith({ errors: [{ message: 'nope', extensions: { code: 'UNAUTHORIZED' } }] });
    await expect(client().fetchAccount('org-1')).rejects.toThrow(/rejected the query/);
  });

  it('marks a throttled query retryable so the sync backs off rather than giving up', async () => {
    respondWith({ errors: [{ message: 'slow down', extensions: { code: 'THROTTLED' } }] });
    await expect(client().fetchAccount('org-1')).rejects.toMatchObject({
      status: 429,
      retryable: true,
    });
  });

  it('refreshes once on a 401 and retries, rather than looping on the refresh token', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { account: { id: 'a', name: 'Texas Renters' } } }),
      } as Response);

    await expect(client().fetchAccount('org-1')).resolves.toEqual({
      id: 'a',
      name: 'Texas Renters',
    });
    expect(jest.mocked(tokens.refresh)).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses to send a request at all when no schema version is pinned', async () => {
    respondWith({ data: {} });
    await expect(
      client({ JOBBER_API_VERSION: undefined }).fetchAccount('org-1'),
    ).rejects.toBeInstanceOf(JobberError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
