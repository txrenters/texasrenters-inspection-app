/**
 * Web Mercator, and the only place in the app that knows what it is.
 *
 * Every function here is pure arithmetic over numbers, so the whole of the
 * map's geometry -- which tiles to fetch, where each one sits, where a
 * coordinate lands on screen once the map is rotated -- is testable without a
 * device, a network or a single pixel. The renderer above is a thin thing that
 * positions images and draws paths; it does no projection of its own, and the
 * second renderer (`react-native-maps`, once a store release can carry it) will
 * do none either.
 *
 * ## The axis convention
 *
 * **Every coordinate is `[latitude, longitude]`**, matching
 * `NavigationLeg.polyline`, `TechnicianRoute.geometry` and the rest of
 * `shared/src/contracts`. That makes `lngLatToWorld` a badly-named function and
 * the name is kept anyway, because it is the name the rest of the feature was
 * written against and a rename that leaves one call site behind is worse than a
 * name that reads backwards. The parameter is typed and documented; read the
 * type, not the name.
 *
 * An axis swap here is the single most expensive mistake available: it draws a
 * plausible route in the Indian Ocean while every component looks individually
 * correct. The tests assert the *sign* of each value -- Texas is latitude
 * ~+29.8 and longitude ~-95.4 -- rather than its position in a pair.
 */

import type { LatLng } from './types';

/** Standard slippy-map tile edge, in pixels at integer zoom. */
export const TILE_SIZE = 256;

export const MIN_TILE_ZOOM = 0;

/**
 * The deepest zoom a tile is ever asked for.
 *
 * 22 is the conventional ceiling and is far past anything with imagery, but the
 * clamp is not about imagery -- it is about `2 ** zoom` staying a number the
 * arithmetic below can divide by. A camera handed a runaway zoom by an
 * animation that overshot would otherwise produce `Infinity` tile indices and a
 * loop that never ends.
 */
export const MAX_TILE_ZOOM = 22;

/**
 * How many tile rings to fetch beyond the visible edge.
 *
 * One. The driver is moving, so the tile about to come into view is the one
 * about to be needed, and fetching it a second early is the difference between
 * a map that slides and a map that grows a grey band on its leading edge at
 * every pan. Two rings roughly doubles the request count for a ring nobody
 * reaches before the next fix moves the camera again.
 */
export const TILE_OVERSCAN = 1;

/**
 * The latitude Mercator is truncated at.
 *
 * The projection sends the poles to infinity, so every implementation cuts it
 * somewhere; this value is the one that makes the world square, and it is what
 * every tile server in existence assumes. Clamping here rather than rejecting
 * means a garbage fix at latitude 91 draws at the top of the world instead of
 * producing `NaN` offsets that silently blank the entire tile grid.
 */
export const MERCATOR_MAX_LATITUDE = 85.051_128_779_806_59;

/** A position in map pixels at a given zoom, origin at the north-west corner. */
export interface WorldPoint {
  x: number;
  y: number;
}

/** A position in screen pixels, origin at the top-left of the viewport. */
export interface ScreenPoint {
  x: number;
  y: number;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_TILE_ZOOM;
  return Math.min(MAX_TILE_ZOOM, Math.max(MIN_TILE_ZOOM, zoom));
}

/** Tiles per side at an integer zoom. */
export function tileCount(zoom: number): number {
  return 2 ** Math.round(clampZoom(zoom));
}

/** Map pixels per side at a zoom, which may be fractional. */
export function worldSize(zoom: number): number {
  return TILE_SIZE * 2 ** clampZoom(zoom);
}

/**
 * A `[latitude, longitude]` pair to map pixels.
 *
 * Fractional zoom is supported on purpose. A zoom that animates between two
 * integers is drawn by scaling the tiles of the nearer integer zoom, and every
 * offset on screen has to be computed at the fractional value or the imagery
 * and the overlay drift apart mid-animation -- the route visibly slides off the
 * road and back on.
 */
export function lngLatToWorld(at: LatLng, zoom: number): WorldPoint {
  const scale = worldSize(zoom);
  const latitude = Math.min(MERCATOR_MAX_LATITUDE, Math.max(-MERCATOR_MAX_LATITUDE, at[0]));
  const longitude = at[1];

  const sinLatitude = Math.sin((latitude * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) * scale;

  return {
    x: ((longitude + 180) / 360) * scale,
    // Clamped again, in pixels, because the latitude clamp above is not enough.
    // `MERCATOR_MAX_LATITUDE` is the decimal expansion of an irrational bound,
    // so at the exact pole the logarithm lands a few femtometres *past* zero --
    // y came out as -3.2e-12. That is indistinguishable from zero everywhere
    // except in `Math.floor(y / TILE_SIZE)`, which reads it as row -1, and a
    // viewport enumerating rows drops -1 as out of world. The result is a
    // missing strip along the top of the map at zoom 0-2, visible only to
    // somebody who panned to the Arctic. Only y is clamped: x beyond the range
    // is a real longitude across the antimeridian, and `wrapTileColumn` is what
    // deals with that.
    y: Math.min(scale, Math.max(0, y)),
  };
}

/**
 * Ground metres covered by one screen pixel.
 *
 * Mercator stretches with latitude, so this is not a property of the zoom
 * alone. It is what turns a drawing tolerance in pixels into the metre
 * tolerance `decimatePath` wants: thinning a path by "half a pixel" is a
 * statement about the screen, and thinning it by "four metres" is a statement
 * about Houston, and only one of those stays right as the camera zooms.
 */
export function metersPerPixel(latitude: number, zoom: number): number {
  const clamped = Math.min(MERCATOR_MAX_LATITUDE, Math.max(-MERCATOR_MAX_LATITUDE, latitude));
  // Earth's circumference divided by the pixel width of the world at zoom 0.
  return (156_543.033_928_041 * Math.cos((clamped * Math.PI) / 180)) / 2 ** clampZoom(zoom);
}

/**
 * Brings a tile column back inside the world, wrapping at the antimeridian.
 *
 * The world repeats east-west, so column -1 at zoom 2 is column 3: the same
 * tile, and a real one. JavaScript's `%` keeps the sign of the dividend, so the
 * naive form returns -1 and the request 404s -- a black column down the left of
 * the map, which nobody in Texas would ever see and which would therefore ship.
 */
export function wrapTileColumn(column: number, zoom: number): number {
  const count = tileCount(zoom);
  return ((Math.trunc(column) % count) + count) % count;
}

/**
 * Brings a tile row inside the world, clamping at the poles.
 *
 * Rows do *not* wrap. North of the top row is not the bottom row, it is
 * nothing, and wrapping would draw Antarctica above the Arctic. Callers that
 * are enumerating a viewport drop out-of-range rows instead of clamping them,
 * because clamping there would repeat the polar tile down the edge of the
 * screen; this exists for the callers that genuinely want a valid row back.
 */
export function clampTileRow(row: number, zoom: number): number {
  const count = tileCount(zoom);
  return Math.min(count - 1, Math.max(0, Math.trunc(row)));
}

/**
 * Map pixels to screen pixels, applying the camera's rotation.
 *
 * The rotation is the part worth stating. `bearingDegrees` is clockwise from
 * north and describes where the *map* is pointing, so a course-up map with the
 * driver heading east has bearing 90 and must put east at the top of the
 * screen. Screen y runs downward, which flips the sense of every rotation
 * matrix anyone reaches for from memory; the form below is the one that sends a
 * unit vector of bearing `b` to straight up, and it was derived rather than
 * guessed because the guess is off by a sign and looks almost right.
 */
export function worldToScreen(
  world: WorldPoint,
  center: WorldPoint,
  viewport: { width: number; height: number },
  bearingDegrees: number,
): ScreenPoint {
  const dx = world.x - center.x;
  const dy = world.y - center.y;

  const radians = ((Number.isFinite(bearingDegrees) ? bearingDegrees : 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return {
    x: dx * cos + dy * sin + viewport.width / 2,
    y: -dx * sin + dy * cos + viewport.height / 2,
  };
}

/** One tile to mount, and where it belongs in the unrotated map frame. */
export interface VisibleTile {
  /**
   * React key and LRU key.
   *
   * Built from the *unwrapped* column, not the wrapped one. Zoomed far enough
   * out that the world repeats across the viewport, two visible tiles share a
   * wrapped `x` while sitting at different offsets; keyed on the wrapped value
   * React would see one key twice, keep one of them, and leave a hole.
   */
  key: string;
  z: number;
  /** The wrapped column, which is what goes in the URL. */
  x: number;
  y: number;
  /**
   * The unwrapped column, which is what places the tile.
   *
   * Carried separately from `x` because the two stop agreeing the moment the
   * world repeats across the viewport: the tile fetched is `x`, the position it
   * is drawn at comes from `column`, and a renderer that keeps a tile mounted
   * after it scrolls out of view has to recompute that position from `column`
   * on every frame rather than remember an offset the camera has since moved.
   */
  column: number;
  /** Pixels east of the viewport centre, before the map is rotated. */
  offsetX: number;
  /** Pixels south of the viewport centre, before the map is rotated. */
  offsetY: number;
}

export interface ViewportTiles {
  /** The integer zoom the tiles were requested at. */
  z: number;
  /**
   * Edge length to draw each tile at.
   *
   * Equal to `TILE_SIZE` only at integer zoom. At zoom 14.4 the tiles come from
   * zoom 14 and are drawn slightly larger, which is how a zoom animation stays
   * continuous without refetching a grid per frame.
   */
  tileSize: number;
  /**
   * Side of the square container these offsets are measured from the centre of.
   *
   * The tile grid is rotated as one container rather than per tile, so the
   * container has to be big enough to hold the tiles that a rotated viewport
   * pulls in from beyond its corners. Computed from the tiles actually returned
   * rather than estimated, because an underestimate clips the grid on Android,
   * where a child outside its parent's bounds is simply not drawn.
   */
  frameSize: number;
  tiles: readonly VisibleTile[];
}

/**
 * Every tile a rotated viewport can see, with its place in the map frame.
 *
 * A rotated square does not cover the same ground as an upright one: turning a
 * 400x800 viewport by 45 degrees sweeps a box about 850 on a side, so a
 * course-up map genuinely needs more tiles than a north-up one at the same
 * zoom. The four viewport corners are un-rotated back into map space and their
 * bounding box is what gets enumerated -- which asks for some tiles the driver
 * cannot see, and is still far cheaper than the alternative of rotating each
 * tile individually and letting the corners go bare on every turn.
 *
 * Offsets are returned relative to the **viewport centre, unrotated**, because
 * the renderer applies one `rotate` transform to the whole grid about that same
 * centre. Baking the rotation into each tile's offset would place the tiles
 * correctly and leave each one's imagery pointing north.
 */
export function tilesForViewport(
  center: LatLng,
  zoom: number,
  width: number,
  height: number,
  bearingDegrees: number,
): ViewportTiles {
  const safeZoom = clampZoom(zoom);
  const z = Math.round(safeZoom);
  const count = tileCount(z);
  const tileSize = TILE_SIZE * 2 ** (safeZoom - z);

  if (!(width > 0) || !(height > 0) || !(tileSize > 0)) {
    return { z, tileSize, frameSize: 0, tiles: [] };
  }

  const centerWorld = lngLatToWorld(center, safeZoom);

  // Un-rotate the viewport's corners into map space. Rotating a corner back is
  // the transpose of `worldToScreen`'s matrix, which for a rotation is its
  // inverse; written out rather than called so the two stay legible side by side.
  const radians = ((Number.isFinite(bearingDegrees) ? bearingDegrees : 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const halfWidth = width / 2;
  const halfHeight = height / 2;

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const [sx, sy] of [
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
  ] as const) {
    const wx = centerWorld.x + sx * cos - sy * sin;
    const wy = centerWorld.y + sx * sin + sy * cos;
    minX = Math.min(minX, wx);
    maxX = Math.max(maxX, wx);
    minY = Math.min(minY, wy);
    maxY = Math.max(maxY, wy);
  }

  const firstColumn = Math.floor(minX / tileSize) - TILE_OVERSCAN;
  const lastColumn = Math.floor(maxX / tileSize) + TILE_OVERSCAN;
  const firstRow = Math.floor(minY / tileSize) - TILE_OVERSCAN;
  const lastRow = Math.floor(maxY / tileSize) + TILE_OVERSCAN;

  const tiles: VisibleTile[] = [];
  let reach = 0;

  for (let row = firstRow; row <= lastRow; row += 1) {
    // Rows off the top or bottom of the world are dropped, not clamped: there
    // is no imagery past the poles, and clamping would repeat the last row down
    // the edge of the screen as if there were.
    if (row < 0 || row >= count) continue;

    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const offsetX = column * tileSize - centerWorld.x;
      const offsetY = row * tileSize - centerWorld.y;

      tiles.push({
        key: `${z}/${column}/${row}`,
        z,
        x: wrapTileColumn(column, z),
        y: row,
        column,
        offsetX,
        offsetY,
      });

      reach = Math.max(
        reach,
        Math.abs(offsetX),
        Math.abs(offsetX + tileSize),
        Math.abs(offsetY),
        Math.abs(offsetY + tileSize),
      );
    }
  }

  // The container must also cover the viewport itself, for the case where the
  // world is smaller than the screen (zoomed all the way out) and no tile
  // reaches the corners.
  const frameSize = Math.ceil(Math.max(reach * 2, Math.hypot(width, height)));

  return { z, tileSize, frameSize, tiles };
}

/**
 * Fills a `{z}/{x}/{y}` template.
 *
 * Deliberately dumb, and deliberately here rather than in the component: it is
 * the one step between a tile's identity and a network request, and it belongs
 * next to the arithmetic that produced the identity. No key is interpolated and
 * none is available to interpolate -- the template addresses our own backend,
 * which signs the upstream request, because an OTA bundle is a zip file anybody
 * can download.
 */
export function tileUrl(template: string, tile: { z: number; x: number; y: number }): string {
  return template
    .replace(/\{z\}/g, String(tile.z))
    .replace(/\{x\}/g, String(tile.x))
    .replace(/\{y\}/g, String(tile.y));
}
