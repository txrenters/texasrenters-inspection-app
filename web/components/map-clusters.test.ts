import { describe, expect, it } from 'vitest';

import { CLUSTER_GRID_PX, clusterByGrid, type Clusterable } from './map-clusters';

/**
 * A stand-in for Leaflet's projection.
 *
 * Web Mercator scaled by zoom, which is what `map.project` does. Real enough
 * that grid arithmetic behaves the way it will on the map, without needing a
 * DOM or a rendered container.
 */
const map = {
  project(latlng: [number, number] | { lat: number; lng: number }, zoom: number) {
    const [lat, lng] = Array.isArray(latlng) ? latlng : [latlng.lat, latlng.lng];
    const scale = 256 * 2 ** (zoom ?? 0);
    const x = ((lng + 180) / 360) * scale;
    const sin = Math.sin((lat * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
    return { x, y };
  },
} as unknown as Parameters<typeof clusterByGrid>[0];

/** The three real 77044 properties that drew as one pin. */
const HOUSTON_77044: Clusterable[] = [
  { id: 'copper-hollow', latitude: 29.8657, longitude: -95.2028 },
  { id: 'mariposa-green', latitude: 29.8663, longitude: -95.2009 },
  { id: 'solitude-way', latitude: 29.8685, longitude: -95.2043 },
];

const FAR_AWAY: Clusterable = { id: 'woodlands', latitude: 30.1716, longitude: -95.5871 };

describe('clusterByGrid', () => {
  it('merges neighbours that would overlap at metropolitan zoom', () => {
    // Zoom 10 is roughly the framing in the report: three properties within
    // 250m occupying about one pixel.
    const clusters = clusterByGrid(map, HOUSTON_77044, 10);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.members).toHaveLength(3);
  });

  it('separates them again once zoomed in', () => {
    // The whole point of clustering rather than hiding: zooming must reveal
    // what the badge stood for.
    const clusters = clusterByGrid(map, HOUSTON_77044, 17);
    expect(clusters).toHaveLength(3);
  });

  it('keeps distant properties in their own group', () => {
    const clusters = clusterByGrid(map, [...HOUSTON_77044, FAR_AWAY], 10);
    expect(clusters).toHaveLength(2);
    expect(clusters.flatMap((cluster) => cluster.members)).toHaveLength(4);
  });

  it('never loses or duplicates a property', () => {
    // The failure that would matter most: a map that quietly under-reports the
    // portfolio is worse than one that draws it badly.
    const many: Clusterable[] = Array.from({ length: 570 }, (_, index) => ({
      id: `property-${index}`,
      latitude: 29.6 + (index % 30) * 0.02,
      longitude: -95.6 + Math.floor(index / 30) * 0.02,
    }));

    for (const zoom of [8, 10, 12, 14, 17]) {
      const members = clusterByGrid(map, many, zoom).flatMap((cluster) => cluster.members);
      expect(members).toHaveLength(570);
      expect(new Set(members.map((member) => member.id)).size).toBe(570);
    }
  });

  it('places a cluster among its members rather than in a grid corner', () => {
    const [cluster] = clusterByGrid(map, HOUSTON_77044, 10);
    const latitudes = HOUSTON_77044.map((property) => property.latitude);
    expect(cluster?.latitude).toBeGreaterThanOrEqual(Math.min(...latitudes));
    expect(cluster?.latitude).toBeLessThanOrEqual(Math.max(...latitudes));
  });

  it('gives a cluster a key that changes when its membership does', () => {
    // React reuses a marker whose key is unchanged; a cluster that gained a
    // property while keeping its key would keep displaying the old count.
    const [before] = clusterByGrid(map, HOUSTON_77044, 10);
    const [after] = clusterByGrid(map, HOUSTON_77044.slice(0, 2), 10);
    expect(before?.key).not.toBe(after?.key);
  });

  it('groups nothing when there is nothing to group', () => {
    expect(clusterByGrid(map, [], 10)).toEqual([]);
  });

  it('uses a grid wide enough to matter', () => {
    // Guards the constant itself: a grid smaller than a marker would cluster
    // nothing and quietly restore the original problem.
    expect(CLUSTER_GRID_PX).toBeGreaterThan(24);
  });
});
