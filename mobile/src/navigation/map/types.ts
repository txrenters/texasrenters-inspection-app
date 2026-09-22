/**
 * The seam between navigation and whatever is drawing the map.
 *
 * There are two renderers in this feature's future and only one of them ships
 * today. `NavMap` draws raster tiles under a `react-native-svg` overlay, which
 * is the only thing that can be shipped over the air: `mobile/app.config.ts`
 * pins `runtimeVersion` to the app version, so an `eas update` importing a
 * native module the installed binary does not contain crashes on import rather
 * than degrading. A `react-native-maps` renderer is better in every way that is
 * not that, and wants a store release to arrive.
 *
 * So this file, and not `NavMap.tsx`, is what the engine and the UI import. A
 * renderer is anything that takes `NavMapProps` and puts pixels on the screen.
 * Swapping one for the other must not touch a line of the engine or the HUD.
 *
 * The rule that keeps the seam honest: **anything the UI needs beyond these
 * props belongs in the UI, not in the map.** A re-centre button, a speed
 * readout, a "signal is poor" notice and the instruction banner all sit *over*
 * the map as ordinary views. The moment one of them is passed through here it
 * has to be reimplemented in the second renderer too, and the swap stops being
 * free.
 *
 * ## The axis convention, restated because this is an import boundary
 *
 * **Every coordinate here is `[latitude, longitude]`**, the same as
 * `TechnicianRoute.geometry`, `NavigationLeg.polyline` and everything in
 * `shared/src/contracts/nav-progress.ts`. The backend's `decodePolyline` emits
 * `[lon, lat]` and `toLatLngPath` flips it once at the edge; nothing downstream
 * flips again. An axis swap does not fail loudly -- it draws a perfectly
 * plausible route in the Indian Ocean while every component looks individually
 * correct.
 */

/** `[latitude, longitude]`. Not the other way round. See the note above. */
export type LatLng = readonly [number, number];

/**
 * Where the map is looking.
 *
 * `bearingDegrees` is clockwise from true north and is what the *map* is
 * rotated to, not what the driver is doing. Course-up navigation sets it from a
 * smoothed heading; north-up overview sets it to 0; a reader who has panned the
 * map keeps whatever it had. The map does not know which of those is happening
 * and must not try to guess -- see `onGesture`.
 *
 * `zoom` is standard Web Mercator and may be fractional, so a zoom animation
 * driven by the engine does not have to land on integers.
 */
export interface NavMapCamera {
  center: LatLng;
  zoom: number;
  bearingDegrees: number;
}

/**
 * One drawn line, and how far along the day it is.
 *
 * Split by the caller rather than here. `DRIVEN` is the part of the active leg
 * already behind the technician -- `splitRouteAtPosition` in `live-route.ts`
 * makes the same cut for the console, and consuming the road behind the
 * technician is what landed in #294. `ACTIVE` is the rest of the leg being
 * driven. `LATER` is the remainder of the day, which is drawn from the day
 * route's own geometry and is a different, coarser line entirely.
 *
 * There is deliberately no `id`: `reconcileMobileState` treats any object with
 * a string `id` as a revisioned entity and can resurrect one the server has
 * removed, which for a map line would mean a stale leg drawn under a fresh one.
 */
export interface NavMapLine {
  path: readonly LatLng[];
  kind: 'DRIVEN' | 'ACTIVE' | 'LATER';
}

/**
 * A stop, drawn.
 *
 * `label` is short by contract -- a stop number, a house number, "Home". The
 * renderer has no way to measure text (there is no layout pass inside an SVG on
 * React Native), so it estimates a width from the character count and truncates.
 * Passing a full address here produces an ellipsis, not a wider pin.
 */
export interface NavMapPin {
  at: LatLng;
  label: string;
  kind: 'TARGET' | 'LATER' | 'DONE' | 'HOME';
}

/**
 * The technician, or null when there is no fix worth drawing.
 *
 * Null is a real state and not an oversight: `isUsableNavFix` refuses a fix
 * worse than `NAV_MAX_ACCURACY_M`, and navigation holds its last good position
 * rather than snapping the puck to the wrong street. Whether that shows the old
 * puck or no puck is the caller's decision, made once, rather than the map's.
 */
export interface NavMapPuck {
  at: LatLng;
  /** Degrees clockwise from true north, or null when the phone is not moving. */
  headingDegrees: number | null;
}

export interface NavMapProps {
  camera: NavMapCamera;
  lines: readonly NavMapLine[];
  pins: readonly NavMapPin[];
  puck: NavMapPuck | null;
  /**
   * A `{z}/{x}/{y}` template pointing at **our** backend, never at a provider.
   *
   * The phone holds no map key. The tile route on the server signs the upstream
   * request, which is what keeps the key out of an OTA bundle that anybody can
   * download and unzip. Null means no imagery is available -- the overlay still
   * draws, over a plain surface, which is the right behaviour on a dead network
   * rather than a blank screen.
   */
  tileUrlTemplate: string | null;
  /**
   * Sent with every tile request.
   *
   * The tile proxy sits behind the technician guard, so the map cannot fetch
   * anything without the caller's bearer token. The token lives here rather
   * than in the URL because a query-string credential ends up in logs, in
   * the image cache key, and in any crash report that captures a URL.
   */
  tileHeaders?: Readonly<Record<string, string>>;
  /** The provider's required data-attribution line, e.g. "Map data ©2026 Google". */
  attribution: string | null;
  /**
   * The reader touched the map.
   *
   * The map does not decide what that means. It cannot: it does not know
   * whether the camera is following a drive, sitting north-up over the day, or
   * already handed over. It reports the touch and the caller stops driving the
   * camera until the reader presses re-centre. Putting that rule in here would
   * bake a policy into the renderer that the second renderer would then have to
   * reproduce exactly.
   */
  onGesture?: () => void;
}
