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

    expect(result.current[0]).toEqual({ mapType: 'roadmap', tilted: false });
    expect(DEFAULT_PREFERENCES).toEqual({ mapType: 'roadmap', tilted: false });
  });

  it('restores what was chosen last time', () => {
    store.set(KEY, JSON.stringify({ mapType: 'hybrid', tilted: true }));

    const { result } = renderHook(() => useMapPreferences());

    expect(result.current[0]).toEqual({ mapType: 'hybrid', tilted: true });
  });

  it('writes the choice through, merged rather than replaced', () => {
    // Changing the map type must not silently switch 3D off, and vice versa:
    // the dropdown sets one field at a time.
    const { result } = renderHook(() => useMapPreferences());

    act(() => result.current[1]({ tilted: true }));
    act(() => result.current[1]({ mapType: 'terrain' }));

    expect(result.current[0]).toEqual({ mapType: 'terrain', tilted: true });
    expect(JSON.parse(store.get(KEY) ?? '{}')).toEqual({ mapType: 'terrain', tilted: true });
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
