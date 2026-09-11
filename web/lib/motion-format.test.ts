import { describe, expect, it } from 'vitest';

import { EMPTY, formatCompass, formatSpeed } from './format';

/**
 * A dispatcher reads "heading northeast" and knows which road that is.
 * "Heading 47°" is a number they have to convert first, on a screen they are
 * watching because something has already gone wrong.
 */

describe('a bearing, as a direction', () => {
  it.each([
    [0, 'N'],
    [45, 'NE'],
    [90, 'E'],
    [180, 'S'],
    [270, 'W'],
    [359, 'N'],
  ])('reads %p degrees as %p', (degrees, expected) => {
    expect(formatCompass(degrees)).toBe(expected);
  });

  it('keeps sixteen points rather than eight', () => {
    // GPS course is good to a few degrees. Rounding a genuine north-northeast
    // onto north would name a different road.
    expect(formatCompass(22)).toBe('NNE');
    expect(formatCompass(247)).toBe('WSW');
  });

  it('wraps a negative bearing instead of indexing off the front', () => {
    // A device reporting -10 means 350. Without the wrap this reached for a
    // negative array index and rendered `undefined`.
    expect(formatCompass(-10)).toBe('N');
    expect(formatCompass(-90)).toBe('W');
  });

  it('is the em dash when there is no heading', () => {
    expect(formatCompass(null)).toBe(EMPTY);
    expect(formatCompass(undefined)).toBe(EMPTY);
    expect(formatCompass(Number.NaN)).toBe(EMPTY);
  });
});

describe('a ground speed, as the road signs give it', () => {
  it('converts metres per second to miles per hour', () => {
    // 13.4 m/s is 30 mph, which is what a residential street is posted at.
    expect(formatSpeed(13.4)).toBe('30 mph');
    expect(formatSpeed(0)).toBe('0 mph');
  });

  it('does not claim a decimal place the sensor has not got', () => {
    // The figure is a Doppler estimate that moves by a mile or two between
    // fixes; a tenth of a mile per hour would be invented precision.
    expect(formatSpeed(13.42)).not.toMatch(/\./);
  });

  it('is the em dash when the device reported no speed', () => {
    expect(formatSpeed(null)).toBe(EMPTY);
    expect(formatSpeed(undefined)).toBe(EMPTY);
  });
});
