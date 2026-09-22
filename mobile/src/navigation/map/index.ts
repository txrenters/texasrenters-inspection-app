/**
 * The map, as the rest of navigation is allowed to see it.
 *
 * Import the seam (`NavMapProps` and friends) rather than the implementation
 * wherever you can: the engine and the HUD should compile unchanged the day a
 * `react-native-maps` renderer replaces `NavMap`, and the only way to keep that
 * true is for nothing outside this directory to name a tile, a world pixel or
 * an SVG.
 */

export { MapAttribution } from './MapAttribution';
export { NAV_MAP_CHROME, NavMap } from './NavMap';
export { TileLayer } from './TileLayer';
export type {
  LatLng,
  NavMapCamera,
  NavMapLine,
  NavMapPin,
  NavMapProps,
  NavMapPuck,
} from './types';

export {
  MAX_TILE_ZOOM,
  MERCATOR_MAX_LATITUDE,
  MIN_TILE_ZOOM,
  TILE_OVERSCAN,
  TILE_SIZE,
  clampTileRow,
  clampZoom,
  lngLatToWorld,
  metersPerPixel,
  tileCount,
  tileUrl,
  tilesForViewport,
  worldSize,
  worldToScreen,
  wrapTileColumn,
  type ScreenPoint,
  type ViewportTiles,
  type VisibleTile,
  type WorldPoint,
} from './tile-math';
