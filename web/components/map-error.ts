'use client';

import { useCallback, useState } from 'react';

/**
 * Which Mapbox errors are worth taking the map away for, and which are weather.
 *
 * **Almost none of them.** Mapbox reports everything through one `error` event:
 * a tile that 404s while somebody pans past the coast, a sprite or glyph that
 * arrives late, a source replaced while the style is still loading. The first
 * version of this treated every one of them as fatal and replaced the map with
 * a permanent message — so the console showed "Mapbox would not load this map"
 * over a map whose token was fine and whose styles all answered 200.
 *
 * It fired reliably, too, rather than rarely: the reader's map type is restored
 * from `localStorage` after mount and the theme resolves after mount, so the
 * style is swapped once or twice within a second of the map appearing, and a
 * swap is exactly when a transient source error is thrown.
 *
 * Google's equivalent only ever reacted to two terminal statuses, and that was
 * the right shape. Here the terminal case is the same one: the token is not
 * accepted for this site.
 */

/** A rejected token, said so the reader can act on it; null for anything else. */
export function fatalMapError(event: unknown): string | null {
  const error = (event as { error?: unknown } | undefined)?.error as
    | { status?: unknown; message?: unknown }
    | undefined;

  const status = typeof error?.status === 'number' ? error.status : undefined;
  if (status === 401 || status === 403)
    return 'Mapbox rejected this token for this site. Check the token’s URL restrictions in the Mapbox account.';

  /**
   * Some rejections arrive as a plain `Error` with no status -- a token that is
   * malformed rather than merely unauthorised, for instance. Matched on the
   * word rather than the class, because the class is Mapbox's to change.
   */
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/unauthorized|not authorized|invalid.*token|token.*invalid/i.test(message))
    return `Mapbox rejected this token: ${message}`;

  return null;
}

/**
 * The fatal reason, if one has happened, and the handler to give `<Map>`.
 *
 * Everything non-fatal is warned to the console rather than swallowed: a tile
 * failing repeatedly is worth being able to see, it is just not worth throwing
 * the map away for.
 */
export function useMapFailure(): [string | null, (event: unknown) => void] {
  const [failure, setFailure] = useState<string | null>(null);

  const onError = useCallback((event: unknown) => {
    const fatal = fatalMapError(event);
    if (fatal) {
      setFailure(fatal);
      return;
    }
    const error = (event as { error?: unknown } | undefined)?.error;
    console.warn('[map] recoverable error', error);
  }, []);

  return [failure, onError];
}
