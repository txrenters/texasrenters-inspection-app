import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderableColor } from './map-colors';

/**
 * The map draws in the colours the design system asks for.
 *
 * Reported with a screenshot: the day's route drawn as a plain white line, and
 * the radius circles missing entirely.
 *
 * Both had one cause. Every map token in `globals.css` is authored in `oklch`
 * — `--map-route: oklch(0.68 0.19 52)` — and `getComputedStyle` hands a colour
 * back in the space it was written in. Google took that without complaint,
 * because Google paints through canvas and canvas understands every colour the
 * browser does. Mapbox parses colours itself, in JavaScript, for WebGL, and
 * does not know `oklch`.
 *
 * An unparseable colour does not degrade gracefully: it invalidates the whole
 * paint property and Mapbox refuses to add the layer. On a route that left the
 * white casing underneath showing through on its own; on the geofence and
 * grouping circles, which have nothing underneath them, it left nothing at all.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** A canvas that converts the way a browser's does. */
function canvasReturning(converted: string) {
  const context = {
    _value: '',
    set fillStyle(value: string) {
      // Real canvas keeps the previous value when it cannot read the colour.
      this._value = value === TOKEN ? converted : value;
    },
    get fillStyle() {
      return this._value;
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  return context;
}

const TOKEN = 'oklch(0.68 0.19 52)';

describe('a colour on its way to Mapbox', () => {
  it('passes hex straight through, which is most of the web', () => {
    expect(renderableColor('#ea580c')).toBe('#ea580c');
  });

  it('passes rgb and hsl through as well', () => {
    expect(renderableColor('rgb(234, 88, 12)')).toBe('rgb(234, 88, 12)');
    expect(renderableColor('rgba(234, 88, 12, 0.5)')).toBe('rgba(234, 88, 12, 0.5)');
    expect(renderableColor('hsl(24 94% 48%)')).toBe('hsl(24 94% 48%)');
  });

  /** The whole point: the design system's own tokens become paintable. */
  it('converts the oklch the design system is written in', () => {
    canvasReturning('#ea580c');

    expect(renderableColor(TOKEN)).toBe('#ea580c');
  });

  it('falls back rather than handing Mapbox a colour it refused', () => {
    // The sentinel comes back unchanged: canvas could not read it either.
    canvasReturning('#010203');

    expect(renderableColor(TOKEN, '#123456')).toBe('#123456');
  });

  /**
   * Some browsers hand a wide-gamut colour back as `color(display-p3 …)`,
   * which Mapbox cannot read any better than `oklch`. Converted is not the
   * same as usable.
   */
  it('falls back when the conversion is still not plain sRGB', () => {
    canvasReturning('color(display-p3 0.9 0.35 0.05)');

    expect(renderableColor(TOKEN, '#123456')).toBe('#123456');
  });

  it('falls back on nothing at all', () => {
    expect(renderableColor('', '#123456')).toBe('#123456');
  });

  it('falls back when the browser will not give a canvas', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    expect(renderableColor('lab(60% 40 50)', '#123456')).toBe('#123456');
  });
});
