import { describe, expect, it } from 'vitest';

import { calmColor, calmGroupColorOf, colorDifference, nearUngroupedGreen } from './group-file';
import { COLOR_PRESETS, groupPalette } from './manual-grouping';

/**
 * Group colours as the maps paint them (console-development, 2026-10-09): the
 * office's groups keep their colours, drawn softer so a map of forty groups
 * reads as one palette rather than a rainbow.
 */

/** OKLab lightness and chroma of a `#rrggbb`, for checking where calming put it. */
function lc(hex: string) {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return {
    lightness: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    chroma: Math.hypot(a, bb),
    hue: (Math.atan2(bb, a) * 180) / Math.PI,
  };
}

describe('group colours, painted calm', () => {
  it('keeps the hue and brings lightness and chroma into one band', () => {
    for (const preset of COLOR_PRESETS) {
      const before = lc(preset);
      const after = lc(calmColor(preset));
      expect(after.lightness).toBeGreaterThanOrEqual(0.49);
      expect(after.lightness).toBeLessThanOrEqual(0.77);
      expect(after.chroma).toBeLessThanOrEqual(0.145);
      if (before.chroma > 0.05) expect(Math.abs(((after.hue - before.hue + 540) % 360) - 180)).toBeLessThan(6);
    }
  });

  it('still tells the twenty presets apart', () => {
    const calm = COLOR_PRESETS.map(calmColor);
    let closest = Number.POSITIVE_INFINITY;
    for (let one = 0; one < calm.length; one += 1)
      for (let other = one + 1; other < calm.length; other += 1)
        closest = Math.min(closest, colorDifference(calm[one]!, calm[other]!)!);
    expect(closest).toBeGreaterThanOrEqual(0.035);
  });

  it('never paints a group in a colour that could pass for "left to group"', () => {
    for (const color of groupPalette()) expect(nearUngroupedGreen(calmColor(color))).toBe(false);
  });

  it('chooses the numeral for the colour as painted, and leaves anything that is not a colour alone', () => {
    const shown = calmGroupColorOf('#000099');
    expect(shown?.fill).toBe(calmColor('#000099'));
    expect(['#ffffff', '#111827']).toContain(shown?.ink);
    expect(calmColor('not a colour')).toBe('not a colour');
  });
});
