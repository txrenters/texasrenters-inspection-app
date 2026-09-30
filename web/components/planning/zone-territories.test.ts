import { describe, expect, it } from 'vitest';

import { traceFence, zoneColor, zoneTerritories, type ZonePoint } from './zone-territories';

/**
 * The zones as fenced areas, drawn from where their properties are.
 *
 * Every property here is invented.
 */

/** Whether a point is inside a closed ring, by ray casting. */
function insideRing(ring: [number, number][], longitude: number, latitude: number): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [x1, y1] = ring[index]!;
    const [x2, y2] = ring[previous]!;
    if (y1 > latitude !== y2 > latitude && longitude < ((x2 - x1) * (latitude - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

/** Twice the signed area of a ring: negative when it runs clockwise. */
const signedArea = (ring: [number, number][]) =>
  ring.reduce((sum, [x1, y1], index) => {
    const [x2, y2] = ring[(index + 1) % ring.length]!;
    return sum + x1 * y2 - x2 * y1;
  }, 0);

const at = (zone: string | null, latitude: number, longitude: number): ZonePoint => ({ zone, latitude, longitude });

describe('zone territories', () => {
  /** Two zones a town apart: each fenced around its own properties, and holding none of the other's. */
  const west = [at('1', 29.8, -95.8), at('1', 29.81, -95.79), at('1', 29.79, -95.81)];
  const east = [at('Zone 2', 29.8, -95.5), at('2', 29.82, -95.52)];
  const territories = zoneTerritories([...west, ...east, at('Not Set', 29.9, -95.6), at(null, 29.9, -95.6)]);

  it('fences each numbered zone, and ignores a property with none', () => {
    expect(territories.map((territory) => [territory.zone, territory.count])).toEqual([
      ['1', 3],
      ['2', 2],
    ]);
  });

  it('holds every property of the zone inside its fence, and none of the other zone', () => {
    const [one, two] = territories as [(typeof territories)[number], (typeof territories)[number]];
    const inFence = (territory: typeof one, point: ZonePoint) =>
      territory.fence.some((ring) => insideRing(ring, point.longitude, point.latitude));
    for (const point of west) {
      expect(inFence(one, point)).toBe(true);
      expect(inFence(two, point)).toBe(false);
    }
    for (const point of east) expect(inFence(two, point)).toBe(true);
  });

  it('reaches about three kilometres past its properties, not across the map', () => {
    const [one] = territories;
    const longitudes = one!.fence.flat().map(([longitude]) => longitude);
    // Three km is about 0.031 degrees of longitude here; a cell or two more at most.
    expect(Math.max(...longitudes)).toBeLessThan(-95.79 + 0.04);
    expect(Math.min(...longitudes)).toBeGreaterThan(-95.81 - 0.04);
  });

  /** Where two zones' properties sit close, the fence runs between them: no overlap, no gap. */
  it('splits the ground between two close zones at the midway line', () => {
    const [one, two] = zoneTerritories([at('1', 29.8, -95.6), at('2', 29.8, -95.58)]) as [
      ReturnType<typeof zoneTerritories>[number],
      ReturnType<typeof zoneTerritories>[number],
    ];
    const midway = -95.59;
    const inFence = (territory: typeof one, longitude: number) =>
      territory.fence.some((ring) => insideRing(ring, longitude, 29.8));
    expect(inFence(one, midway - 0.003)).toBe(true);
    expect(inFence(two, midway - 0.003)).toBe(false);
    expect(inFence(two, midway + 0.003)).toBe(true);
    expect(inFence(one, midway + 0.003)).toBe(false);
  });

  it('stands its label on one of its own properties, and gives each zone its own colour', () => {
    expect(west).toContainEqual(expect.objectContaining(territories[0]!.labelAt));
    expect(new Set(['1', '2', '3', '4', '5'].map(zoneColor)).size).toBe(5);
  });

  it('works out the office’s whole portfolio quickly', () => {
    const many = Array.from({ length: 400 }, (_, index) =>
      at(String((index % 4) + 1), 29.4 + ((index * 37) % 100) / 100, -95.9 + ((index * 53) % 100) / 100),
    );
    const started = performance.now();
    const result = zoneTerritories(many);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(result).toHaveLength(4);
  });
});

describe('tracing a fence', () => {
  it('closes a ring around a block of squares, running clockwise with the zone on its right', () => {
    // 3 x 3 squares, the middle one zone 0.
    const label = new Int16Array(9).fill(-1);
    label[4] = 0;
    const rings = traceFence(label, 3, 3, 0);
    expect(rings).toHaveLength(1);
    const ring = rings[0]!;
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(signedArea(ring)).toBeLessThan(0);
    expect(insideRing(ring, 1, 1)).toBe(true);
  });

  it('draws a hole as its own ring, the other way round', () => {
    // 5 x 5, zone 0 everywhere but the centre.
    const label = new Int16Array(25).fill(0);
    label[12] = -1;
    const rings = traceFence(label, 5, 5, 0);
    expect(rings).toHaveLength(2);
    expect(rings.map((ring) => Math.sign(signedArea(ring))).sort()).toEqual([-1, 1]);
  });
});
