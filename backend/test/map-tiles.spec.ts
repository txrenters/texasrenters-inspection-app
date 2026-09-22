import { isTileInRange, MapTilesClient, MAX_TILE_ZOOM } from '../src/routing/map-tiles.client';

/**
 * The basemap proxy, which exists so the phone never holds a key.
 *
 * A bare `fetch` from React Native cannot prove which application it is, so an
 * application-restricted key is useless there and an unrestricted one in the
 * bundle is a published key on a CDN. The tiles therefore come through the API,
 * and three things about that need pinning:
 *
 * - **Session tokens are reused.** They last a fortnight and are reusable
 *   across clients; minting one per tile would be a second round trip on every
 *   tile of every pan, and a quota failure that looks like a caching bug.
 * - **Coordinates are checked before the upstream URL is built.** They arrive
 *   as path segments from a handset, and an unchecked one is a string pasted
 *   into a request we then make with our own key attached.
 * - **Cache-Control is Google's, not ours.** Their terms require clients to
 *   respect the lifetime they set, so it is passed through untouched.
 */

const NOW = Date.parse('2026-09-22T15:00:00.000Z');
/** Google returns `expiry` as epoch **seconds**, as a string. */
const TWO_WEEKS_AWAY = String(Math.floor(NOW / 1000) + 14 * 24 * 60 * 60);

interface FetchCall {
  url: string;
  body: unknown;
}

function stubFetch(calls: FetchCall[], tileHeaders: Record<string, string>) {
  return jest.fn(async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });

    if (url.startsWith('https://tile.googleapis.com/v1/createSession'))
      return {
        ok: true,
        status: 200,
        json: async () => ({ session: `token-${calls.length}`, expiry: TWO_WEEKS_AWAY }),
      } as never;

    if (url.startsWith('https://tile.googleapis.com/tile/v1/viewport'))
      return {
        ok: true,
        status: 200,
        json: async () => ({ copyright: 'Map data ©2026 Google, INEGI' }),
      } as never;

    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
      headers: { get: (name: string) => tileHeaders[name.toLowerCase()] ?? null },
    } as never;
  });
}

function harness(tileHeaders: Record<string, string> = {}) {
  const calls: FetchCall[] = [];
  global.fetch = stubFetch(calls, tileHeaders) as never;
  return { client: new MapTilesClient(), calls };
}

const ROADMAP = { mapType: 'roadmap', theme: 'light', traffic: false } as const;
const sessions = (calls: FetchCall[]) =>
  calls.filter((call) => call.url.includes('createSession'));

beforeEach(() => {
  process.env.GOOGLE_MAP_TILES_API_KEY = 'a-tiles-key';
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  delete process.env.GOOGLE_MAP_TILES_API_KEY;
  jest.restoreAllMocks();
});

describe('what counts as a tile', () => {
  it('accepts a tile that can exist', () => {
    expect(isTileInRange(0, 0, 0)).toBe(true);
    expect(isTileInRange(2, 3, 3)).toBe(true);
    expect(isTileInRange(MAX_TILE_ZOOM, 0, 0)).toBe(true);
  });

  /**
   * `x` and `y` are bounded by `2^z`: at zoom 2 there are sixteen tiles, so
   * the seventeenth is either a bug in the caller or somebody probing a proxy
   * that fetches with our key on it.
   */
  it('refuses a column or row the zoom does not have', () => {
    expect(isTileInRange(2, 4, 0)).toBe(false);
    expect(isTileInRange(2, 0, 4)).toBe(false);
    expect(isTileInRange(2, -1, 0)).toBe(false);
    expect(isTileInRange(0, 1, 0)).toBe(false);
  });

  it('refuses a zoom Google does not serve', () => {
    expect(isTileInRange(-1, 0, 0)).toBe(false);
    expect(isTileInRange(MAX_TILE_ZOOM + 1, 0, 0)).toBe(false);
  });

  /**
   * Integers only. `1.5`, `1e3` and an unparseable query string all coerce to
   * numbers happily, and none of them is a tile.
   */
  it('refuses anything that is not a whole number', () => {
    expect(isTileInRange(1.5, 0, 0)).toBe(false);
    expect(isTileInRange(2, 1.5, 0)).toBe(false);
    expect(isTileInRange(2, 0, Number.NaN)).toBe(false);
    expect(isTileInRange(Number.POSITIVE_INFINITY, 0, 0)).toBe(false);
    expect(isTileInRange(Number(''), Number('x'), 0)).toBe(false);
  });

  it('never reaches the network for a tile that cannot exist', async () => {
    const { client, calls } = harness();

    expect(await client.tile(2, 99, 0, ROADMAP)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('the session token', () => {
  it('is minted once and reused for every tile of the same map', async () => {
    const { client, calls } = harness();

    await client.tile(12, 940, 1_710, ROADMAP);
    await client.tile(12, 941, 1_710, ROADMAP);
    await client.tile(12, 942, 1_710, ROADMAP);

    expect(sessions(calls)).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });

  it('is re-minted once it has expired', async () => {
    const { client, calls } = harness();

    await client.tile(12, 940, 1_710, ROADMAP);
    // A fortnight and a day later. Tokens last two weeks.
    jest.spyOn(Date, 'now').mockReturnValue(NOW + 15 * 24 * 60 * 60 * 1000);
    await client.tile(12, 940, 1_710, ROADMAP);

    expect(sessions(calls)).toHaveLength(2);
  });

  /**
   * A session carries its styling, so the dark map is a different session and
   * not a differently drawn one. Sharing a token between them would serve the
   * wrong map rather than merely a stale one.
   */
  it('is not shared between the light map and the dark one', async () => {
    const { client, calls } = harness();

    await client.tile(12, 940, 1_710, ROADMAP);
    await client.tile(12, 940, 1_710, { ...ROADMAP, theme: 'dark' });

    const minted = sessions(calls);
    expect(minted).toHaveLength(2);
    // The dark one is styled to mobile's own tokens rather than dimmed, which
    // is what keeps the roads readable at night.
    expect((minted[0].body as { styles?: unknown }).styles).toBeUndefined();
    expect((minted[1].body as { styles?: unknown[] }).styles?.length).toBeGreaterThan(0);
  });

  it('is not shared between a plain map and one carrying traffic', async () => {
    const { client, calls } = harness();

    await client.tile(12, 940, 1_710, ROADMAP);
    await client.tile(12, 940, 1_710, { ...ROADMAP, traffic: true });

    const minted = sessions(calls);
    expect(minted).toHaveLength(2);
    expect((minted[1].body as { layerTypes?: unknown }).layerTypes).toEqual(['layerTraffic']);
  });

  it('does not style satellite imagery, which Google refuses outright', async () => {
    const { client, calls } = harness();

    await client.tile(12, 940, 1_710, { mapType: 'satellite', theme: 'dark', traffic: false });

    expect((sessions(calls)[0].body as { styles?: unknown }).styles).toBeUndefined();
  });
});

describe('serving a tile', () => {
  it('passes Google’s own Cache-Control and ETag through', async () => {
    const { client } = harness({
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=86400',
      etag: '"abc123"',
    });

    const tile = await client.tile(12, 940, 1_710, ROADMAP);

    // Untouched, in both directions. Lengthening it is a licensing decision
    // this proxy has no business making; shortening it bills us for tiles the
    // phone already has.
    expect(tile?.cacheControl).toBe('public, max-age=86400');
    expect(tile?.etag).toBe('"abc123"');
    expect(tile?.contentType).toBe('image/jpeg');
    expect(tile?.bytes.length).toBe(4);
  });

  it('invents no cache lifetime when Google set none', async () => {
    const { client } = harness({ 'content-type': 'image/png' });

    const tile = await client.tile(12, 940, 1_710, ROADMAP);

    expect(tile?.cacheControl).toBeNull();
    expect(tile?.etag).toBeNull();
  });

  it('keeps the key in the request and out of everything else', async () => {
    const { client, calls } = harness();

    await client.tile(12, 940, 1_710, ROADMAP);

    // The Map Tiles API takes the key as a query parameter -- unlike Routes,
    // which takes a header -- so this only checks it went where it had to and
    // that the session token travelled with it.
    expect(calls[1].url).toContain('key=a-tiles-key');
    expect(calls[1].url).toContain('session=token-1');
  });
});

describe('when there is no key at all', () => {
  it('draws nothing rather than asking Google without one', async () => {
    delete process.env.GOOGLE_MAP_TILES_API_KEY;
    const { client, calls } = harness();

    expect(client.configured).toBe(false);
    expect(await client.tile(12, 940, 1_710, ROADMAP)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('attribution, which the screen is required to show', () => {
  it('reads it from the session Google is drawing', async () => {
    const { client } = harness();

    expect(await client.attribution(ROADMAP)).toBe('Map data ©2026 Google, INEGI');
  });

  /**
   * Never empty. Displaying attribution is a condition of drawing the tiles at
   * all, so a failed metadata call falls back to the minimum Google states
   * rather than leaving the screen with nothing.
   */
  it('falls back rather than leaving the map unattributed', async () => {
    delete process.env.GOOGLE_MAP_TILES_API_KEY;
    const { client } = harness();

    expect(await client.attribution(ROADMAP)).toBe('Map data ©Google');
  });
});
