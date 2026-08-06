import { generateKeyPairSync } from 'node:crypto';

import { CloudflareStreamService } from '../src/media/cloudflare-stream.service';

const ORIGINAL_ENV = { ...process.env };
const originalFetch = global.fetch;

function configure(extra: Record<string, string> = {}) {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct-1';
  process.env.CLOUDFLARE_STREAM_API_TOKEN = 'super-secret-token';
  Object.assign(process.env, extra);
}

function mockFetch(response: Partial<Response> & { headers?: Headers }) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => '',
    json: async () => ({}),
    ...response,
  });
  global.fetch = fetchMock as never;
  return fetchMock;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('Stream configuration', () => {
  it('reports itself unconfigured rather than failing at request time', () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_STREAM_API_TOKEN;
    expect(new CloudflareStreamService().configured).toBe(false);
  });

  it('refuses an upload session with a 503 when credentials are absent', async () => {
    // The backend must still boot and serve every other feature on a machine
    // with no Cloudflare account; this is the difference between a clear answer
    // and a stack trace about undefined.
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    await expect(
      new CloudflareStreamService().createDirectUpload({
        uploadLengthBytes: 1,
        maxDurationSeconds: 1,
        metadata: {},
      }),
    ).rejects.toMatchObject({ code: 'STREAM_NOT_CONFIGURED' });
  });
});

describe('direct upload session', () => {
  it('takes the video id from Cloudflare header, not by parsing the upload URL', async () => {
    // The upload URL's shape is not a contract. Scraping a uid out of it would
    // keep working right up until Cloudflare changed the path, then fail
    // silently by storing a wrong id against real evidence.
    configure();
    mockFetch({
      headers: new Headers({
        location: 'https://upload.cloudflarestream.com/tus/NOT-THE-UID?tusv2=true',
        'stream-media-id': 'the-real-uid',
      }),
    });

    const result = await new CloudflareStreamService().createDirectUpload({
      uploadLengthBytes: 1024,
      maxDurationSeconds: 600,
      metadata: {},
    });
    expect(result.streamUid).toBe('the-real-uid');
    expect(result.uploadUrl).toContain('upload.cloudflarestream.com');
  });

  it('asks Cloudflare to require signed playback', async () => {
    // Inspection video is evidence about someone's home. Without this flag the
    // resulting video is publicly addressable to anyone holding the uid.
    configure();
    const fetchMock = mockFetch({
      headers: new Headers({ location: 'https://u/x', 'stream-media-id': 'uid' }),
    });

    await new CloudflareStreamService().createDirectUpload({
      uploadLengthBytes: 1024,
      maxDurationSeconds: 600,
      metadata: {},
    });
    const metadata = (fetchMock.mock.calls[0][1].headers as Record<string, string>)[
      'Upload-Metadata'
    ];
    expect(metadata).toContain('requiresignedurls');
    // A cap Cloudflare enforces server-side, so a client that lies about
    // duration still cannot store an unbounded video.
    expect(metadata).toContain('maxdurationseconds');
  });

  it('sends the length up front so tus can resume', async () => {
    configure();
    const fetchMock = mockFetch({
      headers: new Headers({ location: 'https://u/x', 'stream-media-id': 'uid' }),
    });

    await new CloudflareStreamService().createDirectUpload({
      uploadLengthBytes: 183421938,
      maxDurationSeconds: 600,
      metadata: {},
    });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Upload-Length']).toBe('183421938');
    expect(headers['Tus-Resumable']).toBe('1.0.0');
  });

  it('fails loudly when Cloudflare answers without an upload location', async () => {
    configure();
    mockFetch({ headers: new Headers({ 'stream-media-id': 'uid' }) });
    await expect(
      new CloudflareStreamService().createDirectUpload({
        uploadLengthBytes: 1,
        maxDurationSeconds: 1,
        metadata: {},
      }),
    ).rejects.toMatchObject({ code: 'STREAM_UPLOAD_SESSION_FAILED' });
  });
});

describe('credential containment', () => {
  it('never puts the API token in a thrown error or a log line', async () => {
    // The single most damaging leak available here: this token can create and
    // delete every video in the account.
    configure();
    const logged: unknown[] = [];
    const service = new CloudflareStreamService();
    jest
      .spyOn((service as unknown as { logger: { error: (v: unknown) => void } }).logger, 'error')
      .mockImplementation((value: unknown) => {
        logged.push(value);
      });

    mockFetch({ ok: false, status: 403, text: async () => 'Cloudflare says: bad token' });
    const error = await service
      .createDirectUpload({ uploadLengthBytes: 1, maxDurationSeconds: 1, metadata: {} })
      .catch((thrown: Error) => thrown);

    const serialized = `${JSON.stringify(logged)}${JSON.stringify(error)}${String(error)}`;
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('Authorization');
  });

  it('surfaces a transport failure as a 502 rather than leaking the request', async () => {
    configure();
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET')) as never;
    const service = new CloudflareStreamService();
    jest
      .spyOn((service as unknown as { logger: { error: () => void } }).logger, 'error')
      .mockImplementation(() => undefined);

    await expect(
      service.createDirectUpload({ uploadLengthBytes: 1, maxDurationSeconds: 1, metadata: {} }),
    ).rejects.toMatchObject({ code: 'STREAM_UNREACHABLE' });
  });
});

describe('signed playback tokens', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  it('refuses to mint a token when signing is not configured', () => {
    configure();
    expect(() => new CloudflareStreamService().signPlaybackToken('uid', 60)).toThrow(
      /not configured/i,
    );
  });

  it('mints a scoped, expiring token', () => {
    configure({
      CLOUDFLARE_STREAM_SIGNING_KEY_ID: 'key-1',
      CLOUDFLARE_STREAM_SIGNING_KEY_PEM: pem,
    });
    const { token, expiresAt } = new CloudflareStreamService().signPlaybackToken('uid-9', 300);

    const [, payloadPart] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString()) as {
      sub: string;
      exp: number;
    };
    // Scoped to one video: a token for one inspection's walkthrough must not
    // open another's.
    expect(payload.sub).toBe('uid-9');
    // And it expires, so a leaked token is not a permanent grant.
    expect(payload.exp * 1000).toBeGreaterThan(Date.now());
    expect(payload.exp * 1000).toBeLessThanOrEqual(Date.now() + 300_000 + 1_000);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('accepts a base64-wrapped key, which is how it survives an env file', () => {
    // A raw PEM pasted into a .env loses its newlines and fails to parse with an
    // error that explains nothing.
    configure({
      CLOUDFLARE_STREAM_SIGNING_KEY_ID: 'key-1',
      CLOUDFLARE_STREAM_SIGNING_KEY_PEM: Buffer.from(pem).toString('base64'),
    });
    expect(() => new CloudflareStreamService().signPlaybackToken('uid', 60)).not.toThrow();
  });
});
