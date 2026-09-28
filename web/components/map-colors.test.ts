import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderableColor } from './map-colors';

/**
 * The map draws in the colours the design system asks for.
 *
 * Reported twice, with screenshots. First the day's route drew as a plain white
 * line and the radius circles were missing altogether; then, after the first
 * attempt at this, the route drew **blue** — the fallback — instead of orange.
 *
 * One cause throughout. Every map token in `globals.css` is authored in
 * `oklch`, and `getComputedStyle` hands a colour back in the space it was
 * written in. Google took that without complaint, because Google paints through
 * canvas and canvas understands every colour the browser does. Mapbox parses
 * colours itself, in JavaScript, for WebGL, and knows neither `oklch` nor the
 * `color(srgb …)` Chrome converts it into.
 *
 * An unparseable colour does not degrade gracefully: it invalidates the whole
 * paint property and Mapbox refuses to add the layer. So the fix cannot stop at
 * "converted" — it has to end at a colour Mapbox can actually read, which is
 * why this reads a painted pixel rather than a serialised string.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const TOKEN = 'oklch(0.68 0.19 52)';

/**
 * A canvas that behaves like a browser's: it accepts the colour, serialises it
 * back in whatever form it likes, and rasterises it to sRGB bytes.
 */
function canvas({
  serialises = 'color(srgb 0.917 0.345 0.047)',
  pixel = [234, 88, 12, 255],
  throwsOnRead = false,
}: {
  serialises?: string;
  pixel?: number[];
  throwsOnRead?: boolean;
} = {}) {
  const context = {
    _value: '',
    set fillStyle(value: string) {
      // Real canvas keeps the previous value when it cannot read the colour.
      this._value = value === TOKEN ? serialises : value;
    },
    get fillStyle() {
      return this._value;
    },
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    getImageData: () => {
      if (throwsOnRead) throw new Error('tainted');
      return { data: Uint8ClampedArray.from(pixel) };
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  return context;
}

describe('a colour on its way to Mapbox', () => {
  it('passes hex straight through, which is most of the web', () => {
    expect(renderableColor('#ea580c')).toBe('#ea580c');
  });

  it('passes rgb and hsl through as well', () => {
    expect(renderableColor('rgb(234, 88, 12)')).toBe('rgb(234, 88, 12)');
    expect(renderableColor('hsl(24 94% 48%)')).toBe('hsl(24 94% 48%)');
  });

  /**
   * The bug behind the blue route. The browser converted the token perfectly
   * well and handed it back as `color(srgb …)`, which is no more readable to
   * Mapbox than the `oklch` it started as.
   */
  it('reads the painted pixel, not whatever the browser serialises to', () => {
    canvas({ serialises: 'color(srgb 0.917 0.345 0.047)', pixel: [234, 88, 12, 255] });

    expect(renderableColor(TOKEN)).toBe('rgb(234, 88, 12)');
  });

  it('keeps a colour that is not fully opaque', () => {
    canvas({ pixel: [234, 88, 12, 128] });

    expect(renderableColor(TOKEN)).toBe('rgba(234, 88, 12, 0.502)');
  });

  it('falls back rather than handing Mapbox a colour the browser refused', () => {
    // The sentinel comes back unchanged: canvas could not read it either.
    canvas({ serialises: '#010203' });

    expect(renderableColor(TOKEN, '#123456')).toBe('#123456');
  });

  /**
   * A tainted or blocked canvas refuses `getImageData`. The serialised value is
   * still worth having on the occasions it happens to be readable.
   */
  it('uses the serialised value when the pixel cannot be read', () => {
    canvas({ serialises: 'rgb(234, 88, 12)', throwsOnRead: true });

    expect(renderableColor(TOKEN)).toBe('rgb(234, 88, 12)');
  });

  it('falls back when the pixel cannot be read and the string is no better', () => {
    canvas({ serialises: 'color(srgb 0.9 0.35 0.05)', throwsOnRead: true });

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
