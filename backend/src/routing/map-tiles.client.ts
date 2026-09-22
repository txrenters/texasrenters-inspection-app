import { Injectable, Logger } from '@nestjs/common';

/**
 * Google's Map Tiles API, proxied so the phone never holds a key.
 *
 * ## Why a proxy at all
 *
 * The technician's map has to be a real Google map -- the office and the
 * technician argue about addresses, and two different basemaps make that
 * argument unwinnable. The obvious way to get one into an Expo app is
 * `react-native-maps`, and that is a native module: adding it changes the
 * runtime version, so every handset needs a new binary from the store before it
 * can take another OTA update. The Map Tiles API is the way out. It explicitly
 * permits third-party renderers, so raster tiles can be drawn by anything --
 * in our case SVG, which is already in the bundle.
 *
 * But a tile request carries a key, and a bare `fetch` from React Native cannot
 * prove which application it is. An application-restricted key is therefore
 * useless there, and a key shipped in the bundle is a key published: the bundle
 * is downloadable, and `eas update` puts it on a CDN. Google's per-request
 * billing makes that an invoice rather than an inconvenience.
 *
 * So the phone asks this backend, which holds the key, and the tile bytes come
 * back through an endpoint the technician is already authenticated against.
 *
 * ## Never throws
 *
 * Same posture as the routing clients beside it. A map that cannot draw is not
 * an incident -- the screen shows the route on a blank field and keeps
 * navigating, which is a degraded map rather than a broken drive.
 */

const REQUEST_TIMEOUT_MS = 10_000;
const SESSION_URL = 'https://tile.googleapis.com/v1/createSession';
const TILE_URL = 'https://tile.googleapis.com/v1/2dtiles';
const VIEWPORT_URL = 'https://tile.googleapis.com/tile/v1/viewport';

/** What kind of map. `roadmap` is the only one a `styles` array applies to. */
export type MapTileType = 'roadmap' | 'satellite' | 'terrain';
export type MapTileTheme = 'light' | 'dark';

export const MAP_TILE_TYPES: readonly MapTileType[] = ['roadmap', 'satellite', 'terrain'];

/**
 * The key, resolved the same way `google-routes.client` resolves its own, with
 * one addition in front.
 *
 * `GOOGLE_MAP_TILES_API_KEY` first so tiles can be split onto their own key
 * later without a code change -- tiles are billed per request and a map left
 * open bills steadily, which is a very different spend profile from routing and
 * one somebody will eventually want to watch separately. Falling back to the
 * routing key means a deployment that has not split them still works.
 *
 * Never the browser key: this is a server-to-server call with no referrer, and
 * a referrer-restricted key is refused outright.
 */
function apiKey(): string {
  return (
    process.env.GOOGLE_MAP_TILES_API_KEY ??
    process.env.GOOGLE_ROUTES_API_KEY ??
    process.env.GOOGLE_SERVER_API_KEY ??
    ''
  );
}

/**
 * The dark map, styled rather than dimmed.
 *
 * The first attempt at a night map was a translucent black overlay on the light
 * tiles, which is what most applications do. It is unreadable while driving:
 * dimming takes the road down with the background, so the line the technician
 * is following loses its contrast exactly when the ambient light is lowest.
 * Styling the tiles instead keeps the roads bright against a dark field.
 *
 * These hexadecimal values are mobile's own dark tokens, written out because
 * Google's API takes colours and knows nothing about our theme. They are the
 * one place in the system where a theme colour is a literal, and they must be
 * kept in step with `mobile/src/lib/theme-colors` by hand -- a map that is a
 * slightly different black from the screen around it reads as a rendering
 * fault.
 */
const DARK_MAP_STYLES: readonly unknown[] = [
  { elementType: 'geometry', stylers: [{ color: '#1C1B19' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#6F6A62' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1C1B19' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#35332F' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#6F6A62' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#22301F' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#35332F' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#6F6A62' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#544A38' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#544A38' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#16262E' }] },
];

/**
 * The deepest zoom Google serves, and the widest.
 *
 * Checked before the upstream URL is built rather than after: `z`, `x` and `y`
 * arrive as path segments from a phone, and an unchecked one is a string
 * pasted into a URL we then fetch with our own key attached.
 */
export const MIN_TILE_ZOOM = 0;
export const MAX_TILE_ZOOM = 22;

/**
 * Whether a tile coordinate names a tile that can exist. Exported for tests.
 *
 * `x` and `y` are bounded by `2^z`, which is the whole point -- at zoom 2 there
 * are sixteen tiles, and asking for the five-hundredth is either a bug in the
 * caller or somebody probing the proxy. Integers only: `1.5` and `1e3` and
 * `0x10` all coerce to numbers happily and none of them is a tile.
 */
export function isTileInRange(z: number, x: number, y: number): boolean {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (z < MIN_TILE_ZOOM || z > MAX_TILE_ZOOM) return false;
  const side = 2 ** z;
  return x >= 0 && x < side && y >= 0 && y < side;
}

/** What a tile request needs to know beyond its coordinates. */
export interface MapTileOptions {
  mapType: MapTileType;
  theme: MapTileTheme;
  /** Google's live traffic layer, drawn over the basemap by Google itself. */
  traffic: boolean;
}

/** A tile as it arrived, with the headers that govern how it may be kept. */
export interface MapTileResponse {
  bytes: Buffer;
  contentType: string;
  /**
   * Upstream's, passed through untouched. Google's terms require clients to
   * respect the max-age it sets, so inventing one here -- in either direction
   * -- is a licensing decision this proxy has no business making.
   */
  cacheControl: string | null;
  etag: string | null;
}

interface CachedSession {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/**
 * How long before a token's stated expiry it is treated as spent.
 *
 * A token that expires between minting and use produces a 403 on a tile, which
 * the phone draws as a hole in the map. Tokens last a fortnight, so giving up
 * the last minute of one costs nothing.
 */
const SESSION_EXPIRY_MARGIN_MS = 60_000;

/**
 * The viewport asked about when nobody says which one.
 *
 * Attribution is per session and per area -- Google names the data providers
 * whose data is in view, and in the United States that is usually Google alone
 * but is not guaranteed to be. The service area is Texas, so that is what is
 * asked about by default; the endpoint lets a caller pass its own bounds.
 */
const DEFAULT_VIEWPORT = { north: 36.6, south: 25.8, east: -93.5, west: -106.7, zoom: 10 };

/**
 * What Google requires be shown when it has not told us anything more specific.
 *
 * Displaying attribution is mandatory, so a failed metadata call cannot be
 * allowed to mean no attribution is shown. This is the minimum Google itself
 * states for its map data, not a string invented here.
 */
export const FALLBACK_MAP_ATTRIBUTION = 'Map data ©Google';

@Injectable()
export class MapTilesClient {
  private readonly logger = new Logger(MapTilesClient.name);

  /**
   * Session tokens, per map being drawn.
   *
   * A token lasts two weeks and is reusable across clients, so minting one per
   * request would be a wasted round trip on every tile of every pan. Keyed by
   * everything that changes what the session *is* -- the map type, the theme
   * (which is a `styles` array, and a session carries its styling) and whether
   * the traffic layer was asked for. Sharing one token between a styled dark
   * session and a plain light one would serve the wrong map, not merely a
   * stale one.
   *
   * In memory, like the drawn routes next door: one backend process, and a
   * restart costs one extra createSession per map in use.
   */
  private readonly sessions = new Map<string, CachedSession>();
  /** Mints already under way, so a screenful of tiles shares one. */
  private readonly minting = new Map<string, Promise<CachedSession | null>>();

  /** Absent configuration means the map is unavailable, and the caller says so. */
  get configured() {
    return Boolean(apiKey());
  }

  /**
   * A session token for this map, minted or reused. Null when unavailable.
   *
   * Public because the attribution endpoint needs the same token the tiles were
   * drawn with -- attribution belongs to a session, and asking about a
   * different one would describe a map nobody is looking at.
   */
  async session(options: MapTileOptions): Promise<string | null> {
    if (!this.configured) return null;

    const key = `${options.mapType}:${options.theme}:${options.traffic ? 'traffic' : 'plain'}`;
    const cached = this.sessions.get(key);
    if (cached && cached.expiresAt - SESSION_EXPIRY_MARGIN_MS > Date.now()) return cached.token;

    const pending =
      this.minting.get(key) ??
      this.mint(options).finally(() => {
        this.minting.delete(key);
      });
    this.minting.set(key, pending);

    const minted = await pending;
    if (!minted) return null;
    this.sessions.set(key, minted);
    return minted.token;
  }

  private async mint(options: MapTileOptions): Promise<CachedSession | null> {
    const body = await this.post(`${SESSION_URL}?key=${encodeURIComponent(apiKey())}`, {
      mapType: options.mapType,
      language: 'en-US',
      region: 'US',
      // Styling is a roadmap-only affordance; sending it with satellite imagery
      // is rejected outright rather than ignored.
      ...(options.theme === 'dark' && options.mapType === 'roadmap'
        ? { styles: DARK_MAP_STYLES }
        : {}),
      ...(options.traffic ? { layerTypes: ['layerTraffic'] } : {}),
    });

    const token = (body as { session?: unknown } | null)?.session;
    if (typeof token !== 'string' || !token) return null;

    /**
     * `expiry` is epoch **seconds**, as a string.
     *
     * Read as milliseconds it lands in 1970 and every session is expired on
     * arrival, which mints a new token per tile -- a quota failure that looks
     * like a caching bug. Anything unreadable is treated as a short-lived
     * token rather than an immortal one.
     */
    const expiry = Number((body as { expiry?: unknown }).expiry);
    const expiresAt = Number.isFinite(expiry) && expiry > 0 ? expiry * 1_000 : Date.now() + 3_600_000;

    return { token, expiresAt };
  }

  /**
   * One tile's bytes. Null when it could not be fetched, for any reason.
   *
   * The caller has already checked the coordinates with `isTileInRange`; this
   * checks again, because the check is what stands between a path segment from
   * a handset and a URL sent with our key.
   */
  async tile(z: number, x: number, y: number, options: MapTileOptions): Promise<MapTileResponse | null> {
    if (!isTileInRange(z, x, y)) return null;

    const session = await this.session(options);
    if (!session) return null;

    try {
      const response = await fetch(
        `${TILE_URL}/${z}/${x}/${y}?session=${encodeURIComponent(session)}&key=${encodeURIComponent(apiKey())}`,
        { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { accept: 'image/*' } },
      );
      if (!response.ok) {
        // A 403 here is usually an expired session rather than a bad key, so
        // the token is dropped and the next request mints a fresh one. Logged
        // without the coordinates: they say where a technician is looking.
        if (response.status === 403 || response.status === 401) this.forget(options);
        this.logger.warn({ event: 'map_tile_http_error', status: response.status, zoom: z });
        return null;
      }

      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') ?? 'image/png',
        cacheControl: response.headers.get('cache-control'),
        etag: response.headers.get('etag'),
      };
    } catch (error) {
      this.logger.warn({
        event: 'map_tile_request_failed',
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Who the map data belongs to, for the line the screen is required to show.
   *
   * Never null: attribution that is missing is worse than attribution that is
   * less specific than it could be, so a failed call falls back to the minimum
   * Google states rather than leaving the screen with nothing.
   */
  async attribution(
    options: MapTileOptions,
    viewport: Partial<typeof DEFAULT_VIEWPORT> = {},
  ): Promise<string> {
    const session = await this.session(options);
    if (!session) return FALLBACK_MAP_ATTRIBUTION;

    const bounds = { ...DEFAULT_VIEWPORT, ...viewport };
    const query = new URLSearchParams({
      session,
      key: apiKey(),
      zoom: String(bounds.zoom),
      north: String(bounds.north),
      south: String(bounds.south),
      east: String(bounds.east),
      west: String(bounds.west),
    });

    const body = await this.get(`${VIEWPORT_URL}?${query.toString()}`);
    const copyright = (body as { copyright?: unknown } | null)?.copyright;
    return typeof copyright === 'string' && copyright ? copyright : FALLBACK_MAP_ATTRIBUTION;
  }

  /** Drops a session Google has stopped accepting, so the next call re-mints. */
  private forget(options: MapTileOptions) {
    this.sessions.delete(
      `${options.mapType}:${options.theme}:${options.traffic ? 'traffic' : 'plain'}`,
    );
  }

  private async post(url: string, payload: unknown): Promise<unknown | null> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        this.logger.warn({
          event: 'map_tiles_session_http_error',
          status: response.status,
          // The message only. Google echoes the request on some errors, and the
          // request carries our styling but the URL carries the key.
          message: (detail as { error?: { message?: unknown } } | null)?.error?.message ?? null,
        });
        return null;
      }
      return await response.json();
    } catch (error) {
      this.logger.warn({
        event: 'map_tiles_session_failed',
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async get(url: string): Promise<unknown | null> {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        this.logger.warn({ event: 'map_tiles_viewport_http_error', status: response.status });
        return null;
      }
      return await response.json();
    } catch (error) {
      this.logger.warn({
        event: 'map_tiles_viewport_failed',
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
