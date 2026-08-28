import { describe, expect, it } from 'vitest';

import {
  CLUSTER_GRID_PX,
  CLUSTER_MAX_ZOOM,
  clusterByGrid,
  type Clusterable,
  zoomToIsolate,
} from './map-clusters';

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

/**
 * Zooming until the chosen property is actually on the map.
 *
 * The reported case: selecting from the list flew to a fixed zoom and left two
 * neighbours drawn as a badge reading "2". The thing just chosen was not
 * visible, and only manual zooming revealed it.
 */
describe('zoomToIsolate', () => {
  // Two houses on the same street, about thirty metres apart -- roughly seven
  // pixels at zoom 15, so well inside one grid cell. This is the reported case;
  // the 77044 properties above are 200m apart and already separate at 15.
  const SAME_STREET: Clusterable[] = [
    { id: 'western-ridge-8', latitude: 30.1502, longitude: -95.4721 },
    { id: 'western-ridge-10', latitude: 30.1504, longitude: -95.4723 },
  ];

  it('goes past the default zoom when a neighbour is too close', () => {
    const zoom = zoomToIsolate(map, SAME_STREET, 'western-ridge-8', 15, 19);
    expect(zoom).toBeGreaterThan(15);
    expect(zoom).toBeLessThanOrEqual(19);

    // The point of the exercise: at the zoom it chose, the property really is
    // drawn on its own rather than inside a badge.
    const own = clusterByGrid(map, SAME_STREET, zoom).find((cluster) =>
      cluster.members.some((member) => member.id === 'western-ridge-8'),
    );
    expect(own?.members).toHaveLength(1);
  });

  it('does not zoom past what is needed', () => {
    // Nothing near it, so the ordinary zoom already shows it alone. Going
    // further would drop somebody onto the rooftops for no reason.
    expect(zoomToIsolate(map, [...HOUSTON_77044, FAR_AWAY], 'woodlands', 15, 19)).toBe(15);
  });

  it('gives up at the ceiling for two records on the same spot', () => {
    // Two units at one address. No zoom separates them, and pretending
    // otherwise would loop or overshoot.
    const twins: Clusterable[] = [
      { id: 'unit-a', latitude: 29.8657, longitude: -95.2028 },
      { id: 'unit-b', latitude: 29.8657, longitude: -95.2028 },
    ];
    expect(zoomToIsolate(map, twins, 'unit-a', 15, 19)).toBe(19);
  });

  it('never returns below the ceiling it was given', () => {
    expect(zoomToIsolate(map, HOUSTON_77044, 'copper-hollow', 21, 19)).toBe(19);
  });
});

/**
 * The cul-de-sac that could not be opened.
 *
 * Three properties on one close, reported as a badge reading "3" that no amount
 * of zooming would separate. The cluster grid is a fixed number of *pixels*, so
 * below the old ceiling of 18 it was about thirty metres wide on the ground —
 * wider than the close itself. Zooming could never win, and the popup told
 * people to zoom.
 */
describe('properties closer together than the grid', () => {
  // Three houses around a cul-de-sac, roughly ten metres apart.
  const CUL_DE_SAC: Clusterable[] = [
    { id: 'merrill-1', latitude: 30.1401, longitude: -95.4602 },
    { id: 'merrill-2', latitude: 30.14019, longitude: -95.46011 },
    { id: 'merrill-3', latitude: 30.14011, longitude: -95.46029 },
  ];

  it('are still grouped at street zoom, which is the reported symptom', () => {
    // Fewer clusters than properties, not an exact count: whether three points
    // land in one cell or two depends on where the grid boundaries happen to
    // fall, which is the same straddling that makes distance a bad proxy for
    // grouping. The claim worth pinning is that zooming to 18 does not show
    // them all.
    expect(clusterByGrid(map, CUL_DE_SAC, 18).length).toBeLessThan(CUL_DE_SAC.length);
  });

  it('each stand alone once past the clustering ceiling', () => {
    // The fix. Above CLUSTER_MAX_ZOOM nothing is grouped, so every property is
    // reachable — overlapping pins being a far smaller problem than a property
    // that cannot be got at.
    const clusters = clusterByGrid(map, CUL_DE_SAC, CLUSTER_MAX_ZOOM + 1);
    expect(clusters).toHaveLength(3);
    for (const cluster of clusters) expect(cluster.members).toHaveLength(1);
  });

  it('can be isolated within the map ceiling', () => {
    // The tile layer now allows 21, so `zoomToIsolate` has room to succeed
    // rather than giving up and handing back a badge.
    const zoom = zoomToIsolate(map, CUL_DE_SAC, 'merrill-1', 15, 21);
    expect(zoom).toBeLessThanOrEqual(21);

    const own = clusterByGrid(map, CUL_DE_SAC, zoom).find((cluster) =>
      cluster.members.some((member) => member.id === 'merrill-1'),
    );
    expect(own?.members).toHaveLength(1);
  });

  it('separates even two records on the very same spot', () => {
    // Two units at one address. Previously unresolvable at any zoom; now they
    // are separate markers that happen to overlap, so the selected one's popup
    // can open.
    const twins: Clusterable[] = [
      { id: 'unit-a', latitude: 30.1401, longitude: -95.4602 },
      { id: 'unit-b', latitude: 30.1401, longitude: -95.4602 },
    ];
    expect(clusterByGrid(map, twins, CLUSTER_MAX_ZOOM + 1)).toHaveLength(2);
  });
});
