import { decimatePath } from '@texasrenters/shared';
import { useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, G, Path, Rect, Text as SvgText } from 'react-native-svg';

import { useThemeColors } from '@/src/lib/theme-colors';

import { MapAttribution } from './MapAttribution';
import { TileLayer } from './TileLayer';
import { lngLatToWorld, metersPerPixel, worldToScreen, type ScreenPoint } from './tile-math';
import type { LatLng, NavMapLine, NavMapPin, NavMapProps } from './types';

/**
 * The over-the-air map: raster tiles under a `react-native-svg` overlay.
 *
 * One implementation of the `NavMapProps` seam, not the only one it will ever
 * have. It exists in this form because `mobile/app.config.ts` pins
 * `runtimeVersion` to the app version, so an `eas update` importing a native
 * module the installed binary lacks crashes on import; `react-native-svg` is
 * already in the binary and `<Image>` is core, so all of this ships over the
 * air. When a store release can carry `react-native-maps`, a second renderer
 * takes the same props and neither the engine nor the HUD changes.
 *
 * The map decides nothing. It draws what it is handed, reports that the reader
 * touched it, and holds no state but the viewport it measured.
 */

/**
 * The colours of map chrome, which cannot come from the theme.
 *
 * `GuidedCaptureOverlay` is the precedent and the reasoning is the same one:
 * what sits behind these marks is not a surface the palette controls. Here it
 * is arbitrary imagery -- a black asphalt interchange, a white concrete car
 * park, a green field, all within one screen and all changing as the vehicle
 * moves.
 *
 * `--card` and `--primary` are the two that look most tempting and are the two
 * that fail hardest. Light `--primary` is a deep teal that disappears against
 * dark road surfaces, which is exactly where a route line spends its time; dark
 * `--primary` blows out against a bright tile. Worse, both of them *flip with
 * the app's theme*, so the route would change colour at dusk when the phone
 * switches scheme -- while the imagery underneath does not.
 *
 * So these are fixed, chosen against imagery rather than against the palette,
 * and every one of them is paired with either a dark casing or a shadow so it
 * survives the worst background it can land on. The one thing that *is* themed
 * is the surface behind the tiles, because that is the app showing through and
 * not the map: see `backdrop` in the component below.
 *
 * Exported so the HUD can match a legend swatch to a line without restating a
 * literal. Adding a colour anywhere else in this feature is the bug this map is
 * guarding against.
 */
export const NAV_MAP_CHROME = {
  /** Under every route line, so a bright line survives a white car park. */
  routeCasing: '#0B5F55',
  /**
   * The leg being driven.
   *
   * The approved design's teal, and deliberately the SAME value on the day and
   * the night basemap. It was checked against both: bright enough to hold on a
   * dark night tile, dark enough to hold on white concrete under its casing.
   * A route that changed colour at dusk would be the only thing on the screen
   * doing so, because the imagery underneath does not.
   */
  routeActive: '#12A594',
  /** The rest of the day. Same hue, dimmed and dotted: context, not instruction. */
  routeLater: '#12A594',
  /** Road already behind the technician. Warm grey, so it recedes. */
  routeDriven: '#A8A199',
  /** The stop being driven to: the casing colour, under the active teal. */
  pinTarget: '#12A594',
  /** Still to come. Hollow, so an ordinal reads inside it. */
  pinLater: '#FFFFFF',
  /** Finished. The same warm grey the driven road uses. */
  pinDone: '#A8A199',
  pinHome: '#FFFFFF',
  /** Every pin and the puck are outlined in this, which is what makes them read. */
  outline: '#0B5F55',
  label: '#FFFFFF',
  labelBackdrop: 'rgba(11, 95, 85, 0.82)',
  puckRing: '#FFFFFF',
  puckCore: '#0F766E',
} as const;

/**
 * How coarsely a path may be thinned before drawing, in screen pixels.
 *
 * `decimatePath` wants a tolerance in metres, and the honest unit for "close
 * enough that nobody can tell" is pixels -- so the pixel figure is converted at
 * the current latitude and zoom. A little over one pixel: at that tolerance
 * every corner the screen can resolve survives and the thousands of points a
 * five-stop day carries do not.
 *
 * This is for **drawing only**. Progress, distance to the maneuver and
 * off-route all run against the full-resolution path in
 * `shared/src/contracts/nav-progress.ts`, because a simplified line moves the
 * road by the tolerance and that is the same order of magnitude as
 * `NAV_OFF_ROUTE_M`.
 */
const DECIMATION_PIXELS = 1.2;

const LINE_WIDTH: Record<NavMapLine['kind'], number> = {
  DRIVEN: 6,
  ACTIVE: 7,
  LATER: 5,
};

/** Drawn last, so the target is never underneath a stop nobody is driving to. */
const PIN_ORDER: Record<NavMapPin['kind'], number> = {
  DONE: 0,
  LATER: 1,
  HOME: 2,
  TARGET: 3,
};

const PIN_FILL: Record<NavMapPin['kind'], string> = {
  TARGET: NAV_MAP_CHROME.pinTarget,
  LATER: NAV_MAP_CHROME.pinLater,
  DONE: NAV_MAP_CHROME.pinDone,
  HOME: NAV_MAP_CHROME.pinHome,
};

const LABEL_FONT_SIZE = 11;

/**
 * There is no way to measure text inside an SVG on React Native -- no layout
 * pass runs in there -- so a label's backdrop is sized from its character
 * count. 0.58em per character is a little generous for the app's face, which
 * is the right direction to be wrong in: a plate slightly too wide looks
 * deliberate, one slightly too narrow looks broken.
 */
const LABEL_CHARACTER_WIDTH = LABEL_FONT_SIZE * 0.58;
const LABEL_MAX_CHARACTERS = 14;

function shortLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length <= LABEL_MAX_CHARACTERS) return trimmed;
  return `${trimmed.slice(0, LABEL_MAX_CHARACTERS - 1)}…`;
}

function pathData(points: readonly ScreenPoint[]): string {
  let data = '';
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!point) continue;
    // One decimal is well under what a phone can resolve and roughly halves the
    // length of the string handed across the bridge on every frame.
    data += `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
  }
  return data;
}

export function NavMap({
  camera,
  lines,
  pins,
  puck,
  tileUrlTemplate,
  tileHeaders,
  attribution,
  onGesture,
}: NavMapProps) {
  const theme = useThemeColors();
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewport((previous) =>
      previous.width === width && previous.height === height ? previous : { width, height },
    );
  };

  /**
   * Quantised so the memo below has something stable to key on.
   *
   * The true tolerance changes with every metre of latitude, which would make
   * it a fresh number on every fix and the memo a no-op -- the exact failure it
   * exists to prevent. Rounded to a tenth of a metre it changes only when the
   * camera meaningfully zooms.
   */
  const tolerance =
    Math.round(metersPerPixel(camera.center[0], camera.zoom) * DECIMATION_PIXELS * 10) / 10;

  /**
   * Thinned per *path*, not per render and not per `lines` array.
   *
   * This is the performance of the whole screen. A five-stop Houston day is
   * several thousand points; running Ramer-Douglas-Peucker over them on every
   * position update drops the frame rate into single digits precisely when the
   * driver is approaching a turn and the map matters most.
   *
   * A `useMemo` on `lines` alone would not have prevented that. The caller
   * re-splits the active leg into a driven part and a remaining part on every
   * fix, so it hands down a **new array every fix** even though the rest of the
   * day inside it has not moved -- and the rest of the day is the expensive
   * part. Keying the cache on each path array instead means the one line that
   * genuinely changed is re-thinned and the other two are free.
   *
   * A `WeakMap` so a path the caller has dropped does not pin several thousand
   * coordinate pairs in memory for the rest of the shift.
   */
  const cache = useRef(new WeakMap<object, { tolerance: number; path: readonly LatLng[] }>())
    .current;

  const decimated = useMemo(
    () =>
      lines
        .filter((line) => line.path.length >= 2)
        .map((line) => {
          const key = line.path as unknown as object;
          const hit = cache.get(key);
          if (hit && hit.tolerance === tolerance) return { kind: line.kind, path: hit.path };

          const path = decimatePath(line.path, tolerance) as readonly LatLng[];
          cache.set(key, { tolerance, path });
          return { kind: line.kind, path };
        }),
    [lines, tolerance, cache],
  );

  const project = useMemo(() => {
    const center = lngLatToWorld(camera.center, camera.zoom);
    return (at: LatLng): ScreenPoint =>
      worldToScreen(lngLatToWorld(at, camera.zoom), center, viewport, camera.bearingDegrees);
  }, [camera.center, camera.zoom, camera.bearingDegrees, viewport]);

  const drawn = useMemo(() => {
    const byKind = (kind: NavMapLine['kind']) =>
      decimated
        .filter((line) => line.kind === kind)
        .map((line) => pathData(line.path.map(project)))
        .filter((data) => data.length > 0);

    return { driven: byKind('DRIVEN'), later: byKind('LATER'), active: byKind('ACTIVE') };
  }, [decimated, project]);

  const placedPins = useMemo(
    () =>
      [...pins]
        .sort((a, b) => PIN_ORDER[a.kind] - PIN_ORDER[b.kind])
        .map((pin, index) => ({ pin, at: project(pin.at), index })),
    [pins, project],
  );

  const puckAt = puck ? project(puck.at) : null;
  /**
   * The puck turns by the difference, not by the heading.
   *
   * The imagery is already rotated to `bearingDegrees`, so a puck drawn at the
   * raw heading on a course-up map points up *twice* and ends up sideways. On a
   * course-up drive this difference is near zero and the arrow sits upright,
   * which is the whole point of course-up.
   */
  const puckRotation =
    puck && puck.headingDegrees !== null ? puck.headingDegrees - camera.bearingDegrees : null;

  return (
    <View
      // The surface behind the tiles is the one colour here that *is* themed:
      // it is the app showing through before imagery loads and past the edge of
      // the world, not chrome sitting over a photograph.
      onLayout={onLayout}
      onTouchStart={onGesture}
      style={[styles.container, { backgroundColor: theme.muted }]}
    >
      <TileLayer
        camera={camera}
        height={viewport.height}
        headers={tileHeaders}
        urlTemplate={tileUrlTemplate}
        width={viewport.width}
      />

      {viewport.width > 0 && viewport.height > 0 ? (
        <Svg
          height={viewport.height}
          // Touches belong to the container, which reports them to the caller.
          // An SVG that swallowed them would make the map un-pannable the day
          // somebody adds panning.
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
          width={viewport.width}
        >
          {/* Order is the whole of the visual hierarchy: what the driver has
              already covered, then the rest of the day as context, then the leg
              being driven on top of both, then the stops, then the driver. */}
          {drawn.driven.map((data, index) => (
            <Path
              d={data}
              key={`driven-${index}`}
              stroke={NAV_MAP_CHROME.routeDriven}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeOpacity={0.85}
              strokeWidth={LINE_WIDTH.DRIVEN}
            />
          ))}

          {drawn.later.map((data, index) => (
            <Path
              d={data}
              key={`later-${index}`}
              stroke={NAV_MAP_CHROME.routeLater}
              // Dots rather than dashes: at this width a dashed line at a
              // junction reads as a lane marking on the imagery underneath.
              strokeDasharray="1 9"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeOpacity={0.7}
              strokeWidth={LINE_WIDTH.LATER}
            />
          ))}

          {drawn.active.map((data, index) => (
            <G key={`active-${index}`}>
              {/* The casing is not decoration. A single bright line vanishes
                  where it crosses a white car park or a pale concrete bridge,
                  and those are junctions. The dark border underneath is what
                  keeps the line readable over every surface. */}
              <Path
                d={data}
                stroke={NAV_MAP_CHROME.routeCasing}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={LINE_WIDTH.ACTIVE + 4}
              />
              <Path
                d={data}
                stroke={NAV_MAP_CHROME.routeActive}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={LINE_WIDTH.ACTIVE}
              />
            </G>
          ))}

          {placedPins.map(({ pin, at, index }) => {
            const label = shortLabel(pin.label);
            const plateWidth = Math.max(18, label.length * LABEL_CHARACTER_WIDTH + 10);

            return (
              <G key={`pin-${index}-${pin.kind}`} transform={`translate(${at.x}, ${at.y})`}>
                {/* Drawn as a stem and a head rather than a teardrop path: the
                    anchor is the point of the stem, so the pin marks the
                    doorway rather than hovering with its centre over it. */}
                <Path
                  d="M0 0 L-4 -11 L4 -11 Z"
                  fill={PIN_FILL[pin.kind]}
                  stroke={NAV_MAP_CHROME.outline}
                  strokeWidth={1.5}
                />
                <Circle
                  cy={-17}
                  fill={PIN_FILL[pin.kind]}
                  r={8}
                  stroke={NAV_MAP_CHROME.outline}
                  strokeWidth={1.5}
                />

                {label ? (
                  <G transform="translate(12, -24)">
                    <Rect
                      fill={NAV_MAP_CHROME.labelBackdrop}
                      height={16}
                      rx={8}
                      width={plateWidth}
                      x={0}
                      y={0}
                    />
                    <SvgText
                      fill={NAV_MAP_CHROME.label}
                      fontSize={LABEL_FONT_SIZE}
                      fontWeight="700"
                      x={plateWidth / 2}
                      y={12}
                      textAnchor="middle"
                    >
                      {label}
                    </SvgText>
                  </G>
                ) : null}
              </G>
            );
          })}

          {puckAt ? (
            <G transform={`translate(${puckAt.x}, ${puckAt.y})`}>
              {puckRotation !== null ? (
                <G transform={`rotate(${puckRotation})`}>
                  <Path
                    d="M0 -19 L7 -7 L-7 -7 Z"
                    fill={NAV_MAP_CHROME.puckCore}
                    stroke={NAV_MAP_CHROME.puckRing}
                    strokeWidth={1.5}
                  />
                </G>
              ) : null}
              <Circle fill={NAV_MAP_CHROME.puckRing} r={11} />
              <Circle fill={NAV_MAP_CHROME.puckCore} r={7.5} />
            </G>
          ) : null}
        </Svg>
      ) : null}

      {/* Rendered here, not passed in. Google's terms require their logo and
          their data attribution wherever their imagery is shown, so it must not
          be possible to mount this map without them -- see MapAttribution. */}
      <MapAttribution text={attribution} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    // The tile grid is deliberately larger than the viewport so a rotated map
    // has corners; without this it spills over whatever the map is laid into.
    overflow: 'hidden',
  },
});
