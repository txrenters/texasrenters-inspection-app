import { describe, expect, it } from 'vitest';

import {
  CLUSTER_GRID_PX,
  CLUSTER_MAX_ZOOM,
  clusterByGrid,
  type Clusterable,
  inBox,
  metersPerPixel,
  padBox,
  ringIsLegible,
  zoomToIsolate,
} from './map-clusters';

/**
 * No stand-in any more.
 *
 * This file used to carry four lines of Web Mercator to impersonate Leaflet's
 * `map.project`, which was the tell that the dependency was never real: the
 * grouping rule needs a projection, not a map. `projectToPixels` is now that
 * arithmetic, in the module itself, and these tests exercise the real one.
 */

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
    const clusters = clusterByGrid(HOUSTON_77044, 10);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.members).toHaveLength(3);
  });

  it('separates them again once zoomed in', () => {
    // The whole point of clustering rather than hiding: zooming must reveal
    // what the badge stood for.
    const clusters = clusterByGrid(HOUSTON_77044, 17);
    expect(clusters).toHaveLength(3);
  });

  it('keeps distant properties in their own group', () => {
    const clusters = clusterByGrid([...HOUSTON_77044, FAR_AWAY], 10);
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
      const members = clusterByGrid(many, zoom).flatMap((cluster) => cluster.members);
      expect(members).toHaveLength(570);
      expect(new Set(members.map((member) => member.id)).size).toBe(570);
    }
  });

  it('places a cluster among its members rather than in a grid corner', () => {
    const [cluster] = clusterByGrid(HOUSTON_77044, 10);
    const latitudes = HOUSTON_77044.map((property) => property.latitude);
    expect(cluster?.latitude).toBeGreaterThanOrEqual(Math.min(...latitudes));
    expect(cluster?.latitude).toBeLessThanOrEqual(Math.max(...latitudes));
  });

  it('gives a cluster a key that changes when its membership does', () => {
    // React reuses a marker whose key is unchanged; a cluster that gained a
    // property while keeping its key would keep displaying the old count.
    const [before] = clusterByGrid(HOUSTON_77044, 10);
    const [after] = clusterByGrid(HOUSTON_77044.slice(0, 2), 10);
    expect(before?.key).not.toBe(after?.key);
  });

  it('groups nothing when there is nothing to group', () => {
    expect(clusterByGrid([], 10)).toEqual([]);
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
    const zoom = zoomToIsolate(SAME_STREET, 'western-ridge-8', 15, 19);
    expect(zoom).toBeGreaterThan(15);
    expect(zoom).toBeLessThanOrEqual(19);

    // The point of the exercise: at the zoom it chose, the property really is
    // drawn on its own rather than inside a badge.
    const own = clusterByGrid(SAME_STREET, zoom).find((cluster) =>
      cluster.members.some((member) => member.id === 'western-ridge-8'),
    );
    expect(own?.members).toHaveLength(1);
  });

  it('does not zoom past what is needed', () => {
    // Nothing near it, so the ordinary zoom already shows it alone. Going
    // further would drop somebody onto the rooftops for no reason.
    expect(zoomToIsolate([...HOUSTON_77044, FAR_AWAY], 'woodlands', 15, 19)).toBe(15);
  });

  it('gives up at the ceiling for two records on the same spot', () => {
    // Two units at one address. No zoom separates them, and pretending
    // otherwise would loop or overshoot.
    const twins: Clusterable[] = [
      { id: 'unit-a', latitude: 29.8657, longitude: -95.2028 },
      { id: 'unit-b', latitude: 29.8657, longitude: -95.2028 },
    ];
    expect(zoomToIsolate(twins, 'unit-a', 15, 19)).toBe(19);
  });

  it('never returns below the ceiling it was given', () => {
    expect(zoomToIsolate(HOUSTON_77044, 'copper-hollow', 21, 19)).toBe(19);
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
    expect(clusterByGrid(CUL_DE_SAC, 18).length).toBeLessThan(CUL_DE_SAC.length);
  });

  it('each stand alone once past the clustering ceiling', () => {
    // The fix. Above CLUSTER_MAX_ZOOM nothing is grouped, so every property is
    // reachable — overlapping pins being a far smaller problem than a property
    // that cannot be got at.
    const clusters = clusterByGrid(CUL_DE_SAC, CLUSTER_MAX_ZOOM + 1);
    expect(clusters).toHaveLength(3);
    for (const cluster of clusters) expect(cluster.members).toHaveLength(1);
  });

  it('can be isolated within the map ceiling', () => {
    // The tile layer now allows 21, so `zoomToIsolate` has room to succeed
    // rather than giving up and handing back a badge.
    const zoom = zoomToIsolate(CUL_DE_SAC, 'merrill-1', 15, 21);
    expect(zoom).toBeLessThanOrEqual(21);

    const own = clusterByGrid(CUL_DE_SAC, zoom).find((cluster) =>
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
    expect(clusterByGrid(twins, CLUSTER_MAX_ZOOM + 1)).toHaveLength(2);
  });
});

/**
 * Zooming in and out stuttered, and froze for up to a second.
 *
 * At street level every property stood alone, so all 586 were markers at once,
 * nearly all of them off-screen; and every lone property was keyed by its grid
 * cell, which changes at every zoom, so each settle threw them all away and
 * drew them again. Measured on a production build: 9 to 11 long tasks, 675 to
 * 841 ms of blocked main thread, over two zoom-out/zoom-in cycles. After: none.
 */
describe('keeping markers across zoom levels', () => {
  it('keys a lone property by itself, whatever the zoom', () => {
    const keysAt = (zoom: number) =>
      clusterByGrid(HOUSTON_77044, zoom)
        .filter((cluster) => cluster.members.length === 1)
        .map((cluster) => cluster.key)
        .sort();

    expect(keysAt(17)).toEqual(['copper-hollow', 'mariposa-green', 'solitude-way']);
    expect(keysAt(18)).toEqual(keysAt(17));
    expect(keysAt(CLUSTER_MAX_ZOOM + 1)).toEqual(keysAt(17));
  });

  it('never gives a group the key of a lone property', () => {
    const group = clusterByGrid(HOUSTON_77044, 10).find((cluster) => cluster.members.length > 1);

    expect(group).toBeDefined();
    expect(HOUSTON_77044.map((property) => property.id)).not.toContain(group?.key);
  });
});

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
 * A marker stands on a building.
 *
 * The office, reading satellite imagery (2026-09-28): "every time I zoom in and
 * zoom out the markers reposition, it doesn't stay on the exact address".
 *
 * Both halves were true, and the cause was one line. A badge was drawn at the
 * *mean* of its members' coordinates. The grid is in screen pixels, so zooming
 * regroups the members; a different set of members is a different mean; and the
 * mean of several addresses is in general no address at all.
 */
describe('where a badge stands', () => {
  it('is on one of its own properties, never between them', () => {
    const [cluster] = clusterByGrid(HOUSTON_77044, 10);

    expect(
      HOUSTON_77044.some(
        (property) =>
          property.latitude === cluster?.latitude && property.longitude === cluster?.longitude,
      ),
    ).toBe(true);
  });

  /**
   * The one nearest the middle of the group, so the badge still reads as
   * theirs rather than as an arbitrary pick. Copper Hollow sits closest to the
   * mean of the three; Solitude Way is the far corner.
   */
  it('is the property nearest the middle of the group', () => {
    const [cluster] = clusterByGrid(HOUSTON_77044, 10);

    expect(cluster?.latitude).toBe(29.8657);
    expect(cluster?.longitude).toBe(-95.2028);
  });

  it('is exactly the property itself when it stands alone', () => {
    const [cluster] = clusterByGrid([HOUSTON_77044[0]!], 10);

    expect(cluster?.latitude).toBe(29.8657);
    expect(cluster?.longitude).toBe(-95.2028);
  });

  /**
   * The reported symptom, as arithmetic: whatever the zoom, and however the
   * members regroup, every badge sits on a real address.
   */
  it('stays on a real address at every zoom', () => {
    const exact = new Set(
      HOUSTON_77044.map((property) => `${property.latitude},${property.longitude}`),
    );

    for (const zoom of [8, 10, 12, 14, 16, 18, 20]) {
      for (const cluster of clusterByGrid(HOUSTON_77044, zoom)) {
        expect(exact.has(`${cluster.latitude},${cluster.longitude}`)).toBe(true);
      }
    }
  });
});
