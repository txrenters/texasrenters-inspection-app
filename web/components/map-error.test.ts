import { describe, expect, it } from 'vitest';

import { fatalMapError } from './map-error';

/**
 * The map stops disappearing over nothing.
 *
 * Reported from production with a screenshot: "Mapbox would not load this map"
 * across the whole technician map — while the token was valid and every one of
 * the five styles the console uses answered 200 to a request carrying the
 * console's own referer.
 *
 * The map was fine. The handler was not: it treated every `error` event as
 * fatal, and Mapbox reports tiles, sprites, glyphs and sources through that one
 * channel. The reader's map type is restored from `localStorage` after mount,
 * so the style is swapped a moment after the map appears — which is precisely
 * when a transient source error is thrown.
 */

describe('deciding whether a map error is fatal', () => {
  it('is fatal when the token is rejected for this site', () => {
    expect(fatalMapError({ error: { status: 401 } })).toContain('rejected this token');
    expect(fatalMapError({ error: { status: 403 } })).toContain('rejected this token');
  });

  it('says what to go and look at, not merely that something failed', () => {
    expect(fatalMapError({ error: { status: 403 } })).toContain('URL restrictions');
  });

  it('is fatal when the rejection arrives as a message rather than a status', () => {
    expect(fatalMapError({ error: new Error('Unauthorized: invalid token') })).toContain(
      'rejected this token',
    );
  });

  /**
   * Every one of these used to take the whole map down. They are the ordinary
   * weather of a map being panned, zoomed and restyled.
   */
  it('is not fatal for a tile that did not load', () => {
    expect(fatalMapError({ error: { status: 404, message: 'Not Found' } })).toBeNull();
  });

  it('is not fatal for a source touched while the style is still loading', () => {
    expect(
      fatalMapError({ error: new Error('Style is not done loading') }),
    ).toBeNull();
  });

  it('is not fatal for a rate limit or a server hiccup, which pass', () => {
    expect(fatalMapError({ error: { status: 429 } })).toBeNull();
    expect(fatalMapError({ error: { status: 500 } })).toBeNull();
  });

  it('does not fall over on an event that carries nothing useful', () => {
    expect(fatalMapError(undefined)).toBeNull();
    expect(fatalMapError({})).toBeNull();
    expect(fatalMapError({ error: null })).toBeNull();
    expect(fatalMapError({ error: { status: 'oops', message: 42 } })).toBeNull();
  });
});
