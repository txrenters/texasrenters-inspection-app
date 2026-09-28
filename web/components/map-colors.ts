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

/**
 * The same colour, in a form Mapbox can actually parse.
 *
 * **This is why the routes drew white and the circles did not draw at all.**
 * The design system is authored in `oklch`, and `getComputedStyle` hands the
 * value back in the colour space it was written in — `oklch(0.68 0.19 52)`.
 * Google took that happily, because Google paints through canvas and canvas
 * understands every colour the browser does. Mapbox parses colours *itself*,
 * in JavaScript, for WebGL, and does not know `oklch`.
 *
 * An unparseable colour does not degrade: it makes the whole paint property
 * invalid, so Mapbox refuses to add the layer at all. On a route that left
 * only the white casing underneath — a white line where an orange one should
 * be — and the geofence and grouping circles, which have nothing underneath
 * them, simply never appeared.
 *
 * Canvas is the way back: it accepts any colour the browser understands and
 * hands it back normalised to `#rrggbb` or `rgba(...)`, which Mapbox does
 * understand.
 *
 * Not cached. `useMapStroke` memoises per class and per theme, so this runs a
 * handful of times for a whole map — and a kept context would outlive the
 * document it came from.
 */
export function renderableColor(value: string, fallback = '#2563eb'): string {
  if (!value) return fallback;
  // Already a form Mapbox parses; most of the web is still written this way.
  if (/^(#|rgb|hsl)/i.test(value)) return value;
  if (typeof document === 'undefined') return fallback;

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return fallback;

  /**
   * Canvas keeps its previous `fillStyle` when handed something it cannot
   * read, so a known value goes in first and a result still equal to it means
   * the colour was refused rather than converted.
   */
  const sentinel = '#010203';
  context.fillStyle = sentinel;
  context.fillStyle = value;
  if (String(context.fillStyle) === sentinel) return fallback;

  /**
   * Read back as a *painted pixel*, not as a string.
   *
   * Reading `fillStyle` back was the first attempt and it was not enough:
   * Chrome returns a wide-gamut colour as `color(srgb 0.9 0.42 0.1)`, which
   * Mapbox understands no better than the `oklch` it came from. So the route
   * drew in the fallback blue instead of the design system's orange — the
   * right shape, the wrong colour, and no error anywhere.
   *
   * Painting one pixel and reading its bytes asks the browser to do the
   * conversion it is actually good at, and there is no serialisation left to
   * disagree about.
   */
  try {
    context.clearRect(0, 0, 1, 1);
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
    if (red === undefined || green === undefined || blue === undefined) return fallback;
    return alpha === 255 || alpha === undefined
      ? `rgb(${red}, ${green}, ${blue})`
      : `rgba(${red}, ${green}, ${blue}, ${(alpha / 255).toFixed(3)})`;
  } catch {
    // A tainted or blocked canvas refuses `getImageData`. The serialised value
    // is still worth having when it happens to be a form Mapbox can read.
    const painted = String(context.fillStyle);
    return /^(#|rgb|hsl)/i.test(painted) ? painted : fallback;
  }
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
  return renderableColor(painted);
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
