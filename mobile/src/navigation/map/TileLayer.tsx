import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Image, StyleSheet, View } from 'react-native';

import { lngLatToWorld, tileUrl, tilesForViewport, type VisibleTile } from './tile-math';
import type { NavMapCamera } from './types';

/**
 * The raster map, as a grid of plain `<Image>` elements.
 *
 * There is no native map view in this build and there cannot be one: the app's
 * `runtimeVersion` follows its version, so an `eas update` that imports a
 * native module the installed binary lacks crashes on import rather than
 * degrading. `<Image>`, `Animated` and `View` are core React Native, so this
 * whole layer ships over the air.
 *
 * Nothing here holds a key. `urlTemplate` addresses our own backend, which
 * signs the upstream request; an OTA bundle is a zip file anybody can download,
 * and a provider key inside one is a published key.
 */

/**
 * How many tiles stay mounted, visible or not.
 *
 * Unmounting a tile throws away a decoded bitmap, and remounting it two seconds
 * later re-requests it. On a phone driving through a suburb that is the same
 * forty tiles fetched over and over, with the grid flashing grey each time the
 * camera comes back. Keeping a pool of recently-shown tiles mounted costs a few
 * megabytes of bitmap and removes the flashing outright.
 *
 * 64 is about twice a rotated portrait viewport's worth at this tile size,
 * which covers a turn and the pan that follows it.
 */
const TILE_POOL_SIZE = 64;

/**
 * How long a tile takes to fade in once it has decoded.
 *
 * Tiles arrive out of order and at wildly different times over a phone network.
 * Popping each one in the instant it lands makes the map twitch, and the twitch
 * is what draws the eye -- which is a problem when the eye is supposed to be on
 * the road. A short fade lets the grid assemble itself unnoticed.
 */
const TILE_FADE_MS = 160;

/**
 * A mounted tile's identity, with no position in it.
 *
 * The position deliberately does not live here. A pooled tile's offset is stale
 * the instant the camera moves, and a tile that scrolled off the top of the
 * screen is exactly the tile whose stored offset is most wrong; storing one
 * would draw the pool in the places the map used to be. Offsets are recomputed
 * from `column`/`y` during render, every frame, from the current centre.
 */
interface TileIdentity {
  key: string;
  z: number;
  x: number;
  y: number;
  column: number;
}

function identityOf(tile: VisibleTile): TileIdentity {
  return { key: tile.key, z: tile.z, x: tile.x, y: tile.y, column: tile.column };
}

function sameTiles(a: readonly TileIdentity[], b: readonly TileIdentity[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((tile, index) => b[index]?.key === tile.key);
}

function TileImage({
  left,
  size,
  top,
  url,
  headers,
}: {
  left: number;
  size: number;
  top: number;
  url: string;
  headers?: Readonly<Record<string, string>>;
}) {
  // One value per mounted tile, held across renders. React reconciles these by
  // key, so a tile that leaves the viewport and comes back is the same instance
  // and keeps its faded-in state instead of replaying the fade on an image that
  // never went away.
  const opacity = useRef(new Animated.Value(0)).current;

  return (
    <Animated.View
      pointerEvents="none"
      style={{ position: 'absolute', left, top, width: size, height: size, opacity }}
    >
      <Image
        // A tile that fails to load stays transparent. There is no error state
        // worth drawing here: the overlay above is what the driver steers by, so
        // missing imagery has to degrade to a route on a plain surface rather
        // than to forty broken-image glyphs across the screen.
        onLoad={() => {
          Animated.timing(opacity, {
            toValue: 1,
            duration: TILE_FADE_MS,
            useNativeDriver: true,
          }).start();
        }}
        // The tiles come from OUR backend, behind the technician guard, so a
        // bare `uri` is an unauthenticated request: every tile answers 401 and
        // the map renders as an empty grid with a route floating on it. React
        // Native's `ImageURISource` takes request headers, which is the only
        // reason the proxy can hold the API key instead of the bundle.
        source={headers ? { uri: url, headers } : { uri: url }}
        // `size + 1` closes the hairline seam between neighbours. Offsets are
        // fractional at fractional zoom, and rounding two adjacent tiles in
        // opposite directions leaves a one-pixel gap that reads as a grid drawn
        // over the map.
        style={{ width: size + 1, height: size + 1 }}
      />
    </Animated.View>
  );
}

export function TileLayer({
  camera,
  width,
  height,
  urlTemplate,
  headers,
}: {
  camera: NavMapCamera;
  width: number;
  height: number;
  urlTemplate: string | null;
  headers?: Readonly<Record<string, string>>;
}) {
  const { z, tileSize, frameSize, tiles } = useMemo(
    () => tilesForViewport(camera.center, camera.zoom, width, height, camera.bearingDegrees),
    [camera.center, camera.zoom, camera.bearingDegrees, width, height],
  );

  // Ordered least-recently-visible first, which is what makes the eviction below
  // an LRU rather than an arbitrary cull.
  const [mounted, setMounted] = useState<readonly TileIdentity[]>([]);

  useEffect(() => {
    setMounted((previous) => {
      const visibleKeys = new Set(tiles.map((tile) => tile.key));

      // A tile from another zoom is not a cheaper version of this one: it is the
      // wrong size over the wrong ground. Real maps keep the old zoom as a
      // second layer with its own transform; one flat list cannot, and would
      // draw quarter-scale imagery at full-scale offsets, which is worse than a
      // grey square.
      const retained = previous.filter((tile) => tile.z === z && !visibleKeys.has(tile.key));
      const room = Math.max(0, TILE_POOL_SIZE - tiles.length);

      const next = [
        ...retained.slice(Math.max(0, retained.length - room)),
        ...tiles.map(identityOf),
      ];

      // A pan that keeps the same tile set must not re-set state: the offsets it
      // changed are computed during render, not stored, so there is nothing here
      // to update and re-rendering on every fix would undo the point of the pool.
      return sameTiles(next, previous) ? previous : next;
    });
  }, [tiles, z]);

  if (!urlTemplate || frameSize <= 0) return null;

  const frameCenter = frameSize / 2;
  const centerWorld = lngLatToWorld(camera.center, camera.zoom);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: width / 2 - frameCenter,
          top: height / 2 - frameCenter,
          width: frameSize,
          height: frameSize,
          // One transform for the whole grid, about its own centre, which the
          // layout above has put on the viewport centre. Rotating each tile
          // instead would spin every tile's imagery in place and leave the grid
          // itself pointing north.
          transform: [{ rotate: `${camera.bearingDegrees}deg` }],
        }}
      >
        {mounted.map((tile) => (
          <TileImage
            key={tile.key}
            left={frameCenter + tile.column * tileSize - centerWorld.x}
            size={tileSize}
            top={frameCenter + tile.y * tileSize - centerWorld.y}
            headers={headers}
            url={tileUrl(urlTemplate, tile)}
          />
        ))}
      </View>
    </View>
  );
}
