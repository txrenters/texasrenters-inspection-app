import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES, useMapPreferences } from './map-settings';

/**
 * What the map looks like, remembered between visits.
 *
 * Google's own `mapTypeControl` cannot do this — it forgets the moment the page
 * reloads — and has no notion of tilt, so "3D" was unreachable through it.
 *
 * A viewing preference, like a zoom level, so it lives in the browser rather
 * than on a user row. That makes storage the whole surface, and storage is
 * where this can go wrong: a value from an older build, a private window that
 * throws on access, or a server render that disagrees with the first client
 * one.
 */

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEY = 'texasrenters.map-preferences';

describe('remembering how the map should look', () => {
  it('opens on the roadmap, flat', () => {
    // The plainest reading of a map full of pins, and what somebody who has
    // never opened the settings should get.
    const { result } = renderHook(() => useMapPreferences());

    const plainest = { mapType: 'roadmap', tilted: false, groupingRadiusMeters: 0, zones: false, otherProperties: true };
    expect(result.current[0]).toEqual(plainest);
    expect(DEFAULT_PREFERENCES).toEqual(plainest);
  });

  it('restores what was chosen last time', () => {
    store.set(KEY, JSON.stringify({ mapType: 'hybrid', tilted: true }));

    const { result } = renderHook(() => useMapPreferences());

    expect(result.current[0]).toEqual({ ...DEFAULT_PREFERENCES, mapType: 'hybrid', tilted: true });
  });

  it('writes the choice through, merged rather than replaced', () => {
    // Changing the map type must not silently switch 3D off, and vice versa:
    // the dropdown sets one field at a time.
    const { result } = renderHook(() => useMapPreferences());

    act(() => result.current[1]({ tilted: true }));
    act(() => result.current[1]({ mapType: 'terrain' }));

    expect(result.current[0]).toEqual({ ...DEFAULT_PREFERENCES, mapType: 'terrain', tilted: true });
    expect(JSON.parse(store.get(KEY) ?? '{}')).toEqual({ ...DEFAULT_PREFERENCES, mapType: 'terrain', tilted: true });
  });

  it('refuses a stored map type Google would reject', () => {
    /**
     * Validated rather than trusted. A value from an older build, or one
     * somebody edited by hand, would otherwise reach Google as a map type it
     * does not have — and the failure would be a blank map, not an error.
     */
    store.set(KEY, JSON.stringify({ mapType: 'streetview', tilted: 'yes' }));

    const { result } = renderHook(() => useMapPreferences());

    expect(result.current[0]).toEqual(DEFAULT_PREFERENCES);
  });

  it('survives storage that throws', () => {
    // Private windows throw on access rather than returning null. Losing a
    // preference is nothing; taking the map down with it would not be.
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });

    const { result } = renderHook(() => useMapPreferences());
    expect(result.current[0]).toEqual(DEFAULT_PREFERENCES);
    expect(() => act(() => result.current[1]({ mapType: 'hybrid' }))).not.toThrow();
    // Still applied in memory, so the map changes for this visit even though
    // nothing could be written down.
    expect(result.current[0].mapType).toBe('hybrid');
  });
});

/**
 * The circles the office judges grouping by.
 *
 * Off unless asked for: drawn over 589 properties they are the loudest thing
 * on the map, and somebody opening it to find a technician is not asking this
 * question. Stored like the rest, so the same storage traps apply — and one
 * more, because this value reaches Google as a radius.
 */
describe('the grouping radius', () => {
  it('draws nothing until somebody asks for it', () => {
    expect(DEFAULT_PREFERENCES.groupingRadiusMeters).toBe(0);
  });

  it('remembers the size that was chosen', () => {
    const { result } = renderHook(() => useMapPreferences());

    act(() => result.current[1]({ groupingRadiusMeters: 500 }));

    expect(result.current[0].groupingRadiusMeters).toBe(500);
    expect(JSON.parse(store.get('texasrenters.map-preferences')!)).toMatchObject({
      groupingRadiusMeters: 500,
    });
  });

  /**
   * A number from an older build, or one somebody typed into storage, must
   * not reach Google as a radius — the same rule the map type has kept since
   * this was written.
   */
  it('refuses a stored size it does not offer', () => {
    store.set(
      'texasrenters.map-preferences',
      JSON.stringify({ mapType: 'roadmap', tilted: false, groupingRadiusMeters: 99_999 }),
    );

    const { result } = renderHook(() => useMapPreferences());

    expect(result.current[0].groupingRadiusMeters).toBe(0);
  });

  it('keeps a stored size it does offer', () => {
    store.set(
      'texasrenters.map-preferences',
      JSON.stringify({ mapType: 'roadmap', tilted: false, groupingRadiusMeters: 1_000 }),
    );

    const { result } = renderHook(() => useMapPreferences());

    expect(result.current[0].groupingRadiusMeters).toBe(1_000);
  });
});

/**
 * How the portfolio is drawn (the office, 2026-10-01): every active property by
 * default, each zone's ground when asked for.
 */
describe('the properties on the map', () => {
  it('shows every active property and no zones until asked', () => {
    expect(DEFAULT_PREFERENCES).toMatchObject({ otherProperties: true, zones: false });
  });

  it('remembers both choices', () => {
    const { result } = renderHook(() => useMapPreferences());

    act(() => result.current[1]({ zones: true }));
    act(() => result.current[1]({ otherProperties: false }));

    expect(JSON.parse(store.get(KEY)!)).toMatchObject({ zones: true, otherProperties: false });
  });

  it('keeps the defaults for a stored value that is not a yes or a no', () => {
    // An older build stored neither, and a hand-edited one may store anything.
    store.set(KEY, JSON.stringify({ zones: 'on', otherProperties: 0 }));

    const { result } = renderHook(() => useMapPreferences());

    expect(result.current[0]).toMatchObject({ zones: false, otherProperties: true });
  });
});
