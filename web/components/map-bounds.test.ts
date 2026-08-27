import { describe, expect, it } from 'vitest';

import { type MapPoint, pointsToFit } from './map-bounds';

/** Three real Houston-area properties. */
const HOUSTON: MapPoint[] = [
  { latitude: 29.7264, longitude: -95.417 },
  { latitude: 29.8657, longitude: -95.2028 },
  { latitude: 30.1716, longitude: -95.5871 },
];

const IN_HOUSTON: MapPoint = { latitude: 29.75, longitude: -95.36 };
/** The reported case: a handset in Manila while every property is in Texas. */
const MANILA: MapPoint = { latitude: 14.5995, longitude: 120.9842 };

describe('pointsToFit', () => {
  it('excludes a technician on another continent from the framing', () => {
    // The bug. Fitting to everything produced a world map on which neither the
    // technician nor the properties could be read.
    const points = pointsToFit(HOUSTON, [MANILA]);

    expect(points).toHaveLength(HOUSTON.length);
    expect(points.some(([lat]) => lat === MANILA.latitude)).toBe(false);
  });

  it('keeps a technician who is actually in the patch', () => {
    const points = pointsToFit(HOUSTON, [IN_HOUSTON]);
    expect(points).toHaveLength(HOUSTON.length + 1);
  });

  it('keeps somebody a county or two out, who is just working', () => {
    // A degree is about 69 miles. Somebody an hour beyond the furthest
    // property is doing their job, not holding a stray device.
    const nextCounty: MapPoint = { latitude: 31.0, longitude: -96.4 };
    const points = pointsToFit(HOUSTON, [nextCounty]);
    expect(points).toHaveLength(HOUSTON.length + 1);
  });

  it('frames every position when there are no properties to judge against', () => {
    // Nothing to call an outlier relative to, and a map framing nothing would
    // be worse than one framed generously.
    const points = pointsToFit([], [MANILA, IN_HOUSTON]);
    expect(points).toHaveLength(2);
  });

  it('still frames the properties when every technician is an outlier', () => {
    const points = pointsToFit(HOUSTON, [MANILA, { latitude: 51.5, longitude: -0.12 }]);
    expect(points).toHaveLength(HOUSTON.length);
  });

  it('returns nothing to fit when there is nothing at all', () => {
    expect(pointsToFit([], [])).toEqual([]);
  });

  it('keeps a single property as its own anchor', () => {
    // One property is still a service area. A technician beside it belongs in
    // frame; one on another continent does not.
    const single = [HOUSTON[0]!];
    expect(pointsToFit(single, [IN_HOUSTON])).toHaveLength(2);
    expect(pointsToFit(single, [MANILA])).toHaveLength(1);
  });

  it('emits latitude first, as Leaflet expects', () => {
    // The recurring trap in this codebase: Leaflet is lat,lng while OSRM and
    // the Census geocoder are the other way round.
    const [first] = pointsToFit([HOUSTON[0]!], []);
    expect(first).toEqual([29.7264, -95.417]);
  });
});
