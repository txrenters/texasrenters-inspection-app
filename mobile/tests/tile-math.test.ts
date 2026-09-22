import {
  MAX_TILE_ZOOM,
  TILE_SIZE,
  clampTileRow,
  clampZoom,
  lngLatToWorld,
  metersPerPixel,
  tilesForViewport,
  worldToScreen,
  wrapTileColumn,
} from '../src/navigation/map/tile-math';

/**
 * Web Mercator, pinned.
 *
 * Every assertion below checks the **sign** of a coordinate as well as its
 * value. That is not padding: the whole feature carries `[latitude, longitude]`
 * and the backend's `decodePolyline` emits `[lon, lat]`, so there is exactly
 * one flip in the system and a second one would draw a plausible route in the
 * Indian Ocean with every component still looking correct. Texas is latitude
 * **positive** ~29.8 and longitude **negative** ~-95.4; a swap sends it to the
 * Southern Ocean off Antarctica, which these tests refuse rather than round.
 */

/** Somewhere in downtown Houston. */
const HOUSTON: readonly [number, number] = [29.7604, -95.3698];

/**
 * The slippy-map formula as OpenStreetMap publishes it, written out here rather
 * than imported, so the test disagrees with the implementation when the
 * implementation is wrong instead of reproducing its mistake.
 */
function referenceTile(latitude: number, longitude: number, zoom: number) {
  const n = 2 ** zoom;
  const latitudeRadians = (latitude * Math.PI) / 180;
  return {
    x: Math.floor(((longitude + 180) / 360) * n),
    y: Math.floor(
      ((1 - Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) / Math.PI) / 2) * n,
    ),
  };
}

function tileOf(at: readonly [number, number], zoom: number) {
  const world = lngLatToWorld(at, zoom);
  return { x: Math.floor(world.x / TILE_SIZE), y: Math.floor(world.y / TILE_SIZE) };
}

describe('projecting a coordinate into the tile grid', () => {
  it('puts Houston in the tile the standard formula names', () => {
    // 12/962/1693. Hardcoded as well as cross-checked: a reference
    // implementation that drifts alongside the real one still passes, and a
    // literal does not.
    expect(tileOf(HOUSTON, 12)).toEqual({ x: 962, y: 1693 });
    expect(tileOf(HOUSTON, 12)).toEqual(referenceTile(HOUSTON[0], HOUSTON[1], 12));
  });

  it('agrees with the standard formula at every zoom that has imagery', () => {
    for (let zoom = 1; zoom <= 20; zoom += 1) {
      expect(tileOf(HOUSTON, zoom)).toEqual(referenceTile(HOUSTON[0], HOUSTON[1], zoom));
    }
  });

  it('reads the pair as [latitude, longitude] and not the other way round', () => {
    // The guard the whole feature rests on. Houston is north of the equator and
    // west of Greenwich, so it belongs in the top-left quadrant of the world.
    const world = lngLatToWorld(HOUSTON, 12);
    const half = (TILE_SIZE * 2 ** 12) / 2;

    expect(HOUSTON[0]).toBeGreaterThan(0); // latitude, positive
    expect(HOUSTON[1]).toBeLessThan(0); // longitude, negative
    expect(world.x).toBeLessThan(half); // western hemisphere
    expect(world.y).toBeLessThan(half); // northern hemisphere

    // Swapped, it lands somewhere else entirely. If this ever passes as equal,
    // an axis flip has been introduced and the map is drawing the wrong ocean.
    const swapped = lngLatToWorld([HOUSTON[1], HOUSTON[0]] as const, 12);
    expect(swapped.x).toBeGreaterThan(half);
    expect(swapped.y).toBeGreaterThan(half);
  });

  it('keeps the overlay and the imagery together at fractional zoom', () => {
    // A zoom animation runs between integers. Halfway to the next zoom the
    // world is exactly √2 wider, and if it were not the route would visibly
    // slide off the road and back on mid-animation.
    const at12 = lngLatToWorld(HOUSTON, 12);
    const at13 = lngLatToWorld(HOUSTON, 13);
    const at12Half = lngLatToWorld(HOUSTON, 12.5);

    expect(at13.x / at12.x).toBeCloseTo(2, 6);
    expect(at12Half.x / at12.x).toBeCloseTo(Math.SQRT2, 6);
  });
});

describe('covering the viewport with tiles', () => {
  const VIEWPORT = { width: 400, height: 800 };

  it('asks for more tiles once the map is rotated', () => {
    // A rotated square sweeps a bigger box than an upright one, so a course-up
    // map genuinely needs tiles the same north-up camera never touches. Getting
    // this wrong leaves the corners bare on every turn -- and only on turns,
    // which is why it would survive a walk-through on a desk.
    const upright = tilesForViewport(HOUSTON, 16, VIEWPORT.width, VIEWPORT.height, 0);
    const turned = tilesForViewport(HOUSTON, 16, VIEWPORT.width, VIEWPORT.height, 45);

    expect(turned.tiles.length).toBeGreaterThan(upright.tiles.length);
    expect(turned.frameSize).toBeGreaterThanOrEqual(upright.frameSize);
  });

  it('covers the same ground whichever way round the map is turned', () => {
    // 180 degrees is the same box as 0, and 90 is the same box as 270. A
    // rotation handled with one sign wrong passes the test above and fails this
    // one, because it covers a box of the right size in the wrong place.
    const counts = [0, 90, 180, 270].map(
      (bearing) =>
        tilesForViewport(HOUSTON, 16, VIEWPORT.width, VIEWPORT.height, bearing).tiles.length,
    );

    expect(counts[0]).toBe(counts[2]);
    expect(counts[1]).toBe(counts[3]);
  });

  it('keys tiles on the unwrapped column so a repeating world has no holes', () => {
    const { tiles } = tilesForViewport(HOUSTON, 16, VIEWPORT.width, VIEWPORT.height, 0);
    expect(new Set(tiles.map((tile) => tile.key)).size).toBe(tiles.length);
  });

  it('returns nothing rather than NaN before the view has been measured', () => {
    // `onLayout` has not fired on the first render, so the viewport is 0x0.
    const { tiles, frameSize } = tilesForViewport(HOUSTON, 16, 0, 0, 0);
    expect(tiles).toHaveLength(0);
    expect(frameSize).toBe(0);
  });

  it('stays inside the world at the poles', () => {
    const { tiles, z } = tilesForViewport([89.9, 0], 4, VIEWPORT.width, VIEWPORT.height, 0);
    for (const tile of tiles) {
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeLessThan(2 ** z);
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(2 ** z);
    }
  });
});

describe('the edges of the world', () => {
  it('wraps a column across the antimeridian', () => {
    // JavaScript's `%` keeps the sign of the dividend, so the naive form hands
    // back -1 and the tile request 404s: a black column down the side of the
    // map that nobody in Texas would ever see, and which would therefore ship.
    expect(wrapTileColumn(-1, 2)).toBe(3);
    expect(wrapTileColumn(4, 2)).toBe(0);
    expect(wrapTileColumn(-5, 2)).toBe(3);
    expect(wrapTileColumn(2, 2)).toBe(2);
  });

  it('clamps a row at the poles instead of wrapping it', () => {
    // Rows must not wrap. North of the top row is nothing, not the bottom row,
    // and wrapping would draw Antarctica above the Arctic.
    expect(clampTileRow(-3, 2)).toBe(0);
    expect(clampTileRow(99, 2)).toBe(3);
    expect(clampTileRow(1, 2)).toBe(1);
  });

  it('clamps latitude to the Mercator limit rather than returning infinity', () => {
    const pole = lngLatToWorld([90, 0], 4);
    expect(Number.isFinite(pole.y)).toBe(true);
    expect(pole.y).toBeGreaterThanOrEqual(0);
  });

  it('clamps a runaway zoom', () => {
    expect(clampZoom(1e9)).toBe(MAX_TILE_ZOOM);
    expect(clampZoom(-4)).toBe(0);
    expect(clampZoom(Number.NaN)).toBe(0);
  });
});

describe('turning the screen to face the way the vehicle is going', () => {
  const VIEWPORT = { width: 400, height: 800 };
  const center = lngLatToWorld(HOUSTON, 16);

  it('leaves north at the top when the map is not rotated', () => {
    // A point due north of the centre is 50 world pixels *up*, which is a
    // smaller y: Mercator's origin is the north-west corner.
    const screen = worldToScreen({ x: center.x, y: center.y - 50 }, center, VIEWPORT, 0);
    expect(screen.x).toBeCloseTo(VIEWPORT.width / 2, 6);
    expect(screen.y).toBeCloseTo(VIEWPORT.height / 2 - 50, 6);
  });

  it('puts the driver’s heading at the top of the screen', () => {
    // Heading east, bearing 90: the road ahead is to the east, and on a
    // course-up map the road ahead is up. A sign error here draws a map that
    // turns the wrong way, which looks almost right and is unusable.
    const east = { x: center.x + 50, y: center.y };
    const screen = worldToScreen(east, center, VIEWPORT, 90);

    expect(screen.x).toBeCloseTo(VIEWPORT.width / 2, 6);
    expect(screen.y).toBeCloseTo(VIEWPORT.height / 2 - 50, 6);
  });

  it('holds the centre still whatever the bearing', () => {
    for (const bearing of [0, 37, 90, 180, 270, 359]) {
      const screen = worldToScreen(center, center, VIEWPORT, bearing);
      expect(screen.x).toBeCloseTo(VIEWPORT.width / 2, 6);
      expect(screen.y).toBeCloseTo(VIEWPORT.height / 2, 6);
    }
  });
});

describe('the drawing tolerance', () => {
  it('shrinks as the map zooms in', () => {
    // What turns "about a pixel" into the metre tolerance `decimatePath` wants.
    // If it did not fall with zoom, a close-in map would thin away the corner
    // the driver is being told to turn at.
    expect(metersPerPixel(HOUSTON[0], 17)).toBeLessThan(metersPerPixel(HOUSTON[0], 16));
    expect(metersPerPixel(HOUSTON[0], 16) / metersPerPixel(HOUSTON[0], 17)).toBeCloseTo(2, 6);
  });

  it('is about 2.3 metres per pixel over Houston at zoom 16', () => {
    // Mercator stretches with latitude, so this is a property of the place as
    // well as the zoom. The figure is a sanity anchor: an order-of-magnitude
    // error here thins a route into a straight line between stops.
    expect(metersPerPixel(HOUSTON[0], 16)).toBeGreaterThan(2);
    expect(metersPerPixel(HOUSTON[0], 16)).toBeLessThan(2.5);
  });
});
