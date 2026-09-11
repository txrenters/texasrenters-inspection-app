import { describe, expect, it } from 'vitest';

import { strokeFrom } from './technician-map';

/**
 * Why the route line was black no matter what the token said.
 *
 * Google styles polylines through options rather than CSS, so the colour is
 * read off a hidden probe element carrying the design-system class. The classes
 * set `stroke` — under Leaflet the class landed on an SVG path, where that is
 * the property that paints. After the port this read `color`, which on a bare
 * `span` inherits the body's text colour. Every line came out near-black, the
 * white casing included, and changing `--map-route` moved nothing.
 */

describe('where a map line gets its colour', () => {
  it('takes the stroke, which is what the classes set', () => {
    expect(strokeFrom({ stroke: 'rgb(240, 130, 40)', color: 'rgb(20, 20, 20)' })).toBe(
      'rgb(240, 130, 40)',
    );
  });

  it('does not mistake the inherited text colour for the line colour', () => {
    // The bug, stated directly: with a stroke present, `color` must lose.
    const inheritedBlack = { stroke: 'rgb(240, 130, 40)', color: 'rgb(10, 10, 10)' };
    expect(strokeFrom(inheritedBlack)).not.toBe('rgb(10, 10, 10)');
  });

  it('ignores a stroke of "none"', () => {
    /**
     * What an element no rule has touched computes to. It is not a colour, and
     * handing it to Google draws an invisible line — which looks exactly like a
     * route that failed to load, and is the harder failure to diagnose.
     */
    expect(strokeFrom({ stroke: 'none', color: 'rgb(37, 99, 235)' })).toBe('rgb(37, 99, 235)');
  });

  it('falls back to color for a class that sets one', () => {
    expect(strokeFrom({ color: 'rgb(1, 2, 3)' })).toBe('rgb(1, 2, 3)');
  });

  it('has a literal behind both, so a line is never undefined', () => {
    expect(strokeFrom({})).toBe('#2563eb');
    expect(strokeFrom({ stroke: '', color: '' })).toBe('#2563eb');
    expect(strokeFrom({ stroke: null, color: null })).toBe('#2563eb');
  });
});
