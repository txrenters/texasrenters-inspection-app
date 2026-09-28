'use client';

import { useMemo } from 'react';
import { useTheme } from 'next-themes';

/**
 * The design system's colours, in the form a map can take them.
 *
 * Every map provider this console has used styles its shapes through options or
 * paint properties rather than CSS, so a token like `--map-route` has to be
 * resolved to a colour string before it can be handed over. Reading it off a
 * probe element keeps one source of truth: change the token and every line,
 * circle and ring follows.
 *
 * Its own module, away from the map components, because `mapbox-gl` wants a
 * browser and this does not — a unit test of the colour rule should not have to
 * stand up a map to run.
 */

/**
 * Which computed property actually carries the line's colour.
 *
 * `stroke` first. The map's line classes set `stroke`, because under Leaflet
 * the class landed on an SVG path, where that is the property that paints.
 * After the port to Google this read `color` instead — which on a bare `span`
 * inherits the body's text colour — so every line was drawn in near-black, the
 * white casing included, and changing the design token moved nothing at all.
 *
 * `color` is kept as a fallback for any class that legitimately sets it, and
 * the literal behind that is for a class that sets neither.
 */
export function strokeFrom(computed: {
  stroke?: string | null;
  color?: string | null;
}): string {
  // `stroke` computes to "none" on an element no rule has touched. That is not
  // a colour and must not reach the map as one -- it draws an invisible line,
  // which looks exactly like a route that failed to load.
  const painted = computed.stroke && computed.stroke !== 'none' ? computed.stroke : '';
  return painted || computed.color || '#2563eb';
}

/** The colour a class paints, read off a probe element. Server-safe. */
export function strokeOf(className: string): string {
  if (typeof document === 'undefined') return '#2563eb';
  const probe = document.createElement('span');
  probe.className = className;
  probe.style.display = 'none';
  document.body.append(probe);
  const painted = strokeFrom(getComputedStyle(probe));
  probe.remove();
  return painted;
}

/**
 * The same, as a hook, re-read when the console's theme changes.
 *
 * The provider versions of this did not: a line kept whatever colour it was
 * born in until something else remounted it, so switching the console to dark
 * mode left the routes painted for light.
 */
export function useMapStroke(className: string): string {
  const { resolvedTheme } = useTheme();
  return useMemo(
    () => strokeOf(className),
    // `resolvedTheme` is not read in the body; it is what makes this run again.
    [className, resolvedTheme],
  );
}
