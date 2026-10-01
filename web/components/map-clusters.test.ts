import { describe, expect, it } from 'vitest';

import { inBox, metersPerPixel, padBox, ringIsLegible, spotOffsets } from './map-clusters';

const FAR_AWAY = { id: 'woodlands', latitude: 30.1716, longitude: -95.5871 };

describe('drawing only what is near the screen', () => {
  const houston = { north: 29.9, south: 29.6, east: -95.2, west: -95.6 };

  it('grows the view by a share of its own size on every side', () => {
    const padded = padBox(houston, 0.5);

    expect(padded.north).toBeCloseTo(30.05, 6);
    expect(padded.south).toBeCloseTo(29.45, 6);
    expect(padded.east).toBeCloseTo(-95.0, 6);
    expect(padded.west).toBeCloseTo(-95.8, 6);
  });

  it('includes a point just past the edge once padded, and not before', () => {
    const justEast = { latitude: 29.75, longitude: -95.15 };

    expect(inBox(justEast, houston)).toBe(false);
    expect(inBox(justEast, padBox(houston, 0.5))).toBe(true);
  });

  it('leaves out a property in another city', () => {
    expect(inBox(FAR_AWAY, padBox(houston, 0.5))).toBe(false);
  });

  it('never grows past the edge of the world', () => {
    const padded = padBox({ north: 84, south: -84, east: 170, west: -170 }, 0.5);

    expect(padded.north).toBeLessThanOrEqual(90);
    expect(padded.south).toBeGreaterThanOrEqual(-90);
    expect(padded).toMatchObject({ east: 180, west: -180 });
  });

  it('handles a view that spans the date line', () => {
    const pacific = { north: 10, south: -10, east: -170, west: 170 };

    expect(inBox({ latitude: 0, longitude: 175 }, pacific)).toBe(true);
    expect(inBox({ latitude: 0, longitude: -175 }, pacific)).toBe(true);
    expect(inBox({ latitude: 0, longitude: 0 }, pacific)).toBe(false);
  });
});

/**
 * When a geofence is worth drawing.
 *
 * The circle is the number a technician's hours are computed from, so the rule
 * that hides it has to hide it only where it would say nothing. The failure to
 * avoid is silent: 586 sub-pixel circles at city zoom, each a real Google
 * overlay repositioned on every frame, which is the same stutter clustering
 * the pins was introduced to fix.
 */
describe('drawing a geofence to scale', () => {
  const HOUSTON = 29.76;

  it('measures a pixel smaller the further in you zoom', () => {
    expect(metersPerPixel(HOUSTON, 16)).toBeLessThan(metersPerPixel(HOUSTON, 14));
    // Each level halves it, exactly.
    expect(metersPerPixel(HOUSTON, 15) / metersPerPixel(HOUSTON, 16)).toBeCloseTo(2, 6);
  });

  /**
   * Mercator stretches east-west with latitude, so the same zoom covers less
   * ground further from the equator. A rule written off zoom alone would draw
   * a Houston ring at a size it never has on the ground.
   */
  it('measures a pixel as less ground further from the equator', () => {
    expect(metersPerPixel(HOUSTON, 16)).toBeLessThan(metersPerPixel(0, 16));
  });

  it('draws the default radius once somebody has zoomed to a street', () => {
    expect(ringIsLegible(40, HOUSTON, 17)).toBe(true);
  });

  it('draws nothing at the zoom the whole portfolio fits in', () => {
    expect(ringIsLegible(40, HOUSTON, 11)).toBe(false);
  });

  /**
   * Asked about the radius, not the zoom. A 6m geofence and a 100m one become
   * legible at different zooms, and one threshold picked for the default would
   * either hide the small one for good or draw the large one as a smudge.
   */
  it('shows a wide geofence sooner than a tight one', () => {
    const zoom = 14;

    expect(ringIsLegible(150, HOUSTON, zoom)).toBe(true);
    expect(ringIsLegible(6, HOUSTON, zoom)).toBe(false);
    // And the tight one does arrive, further in.
    expect(ringIsLegible(6, HOUSTON, 19)).toBe(true);
  });
});

/**
 * Every property its own marker, even where two share one spot.
 *
 * With no count badges any more (the office, 2026-10-01), two buildings at the
 * same coordinates would be one disc on top of another at every zoom, and the
 * one underneath could never be clicked.
 */
describe('properties that share one spot', () => {
  const at = (id: string, latitude: number, longitude: number) => ({ id, latitude, longitude });

  it('are fanned out, each with a place of its own', () => {
    const offsets = spotOffsets(
      [at('a', 29.81, -95.39), at('b', 29.81, -95.39), at('c', 29.81, -95.39)],
      (item) => item.id,
    );

    expect([...offsets.keys()].sort()).toEqual(['a', 'b', 'c']);
    const places = new Set([...offsets.values()].map(([x, y]) => `${x},${y}`));
    expect(places.size).toBe(3);
  });

  it('leave a property alone at its spot where it is', () => {
    const offsets = spotOffsets([at('a', 29.81, -95.39), at('b', 29.81, -95.39), at('far', 29.7, -95.4)], (item) => item.id);

    expect(offsets.has('far')).toBe(false);
  });

  it('starts the fan at twelve o’clock, a disc’s width apart', () => {
    const offsets = spotOffsets([at('a', 29.81, -95.39), at('b', 29.81, -95.39)], (item) => item.id);

    expect(offsets.get('a')).toEqual([0, -12]);
    expect(offsets.get('b')).toEqual([0, 12]);
  });

  it('treats two spots a few metres apart as two spots', () => {
    // Five decimals is about a metre: neighbours are not merged into one spot.
    expect(spotOffsets([at('a', 29.81, -95.39), at('b', 29.8101, -95.39)], (item) => item.id).size).toBe(0);
  });
});
