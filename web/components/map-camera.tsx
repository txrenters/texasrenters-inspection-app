'use client';

import type { PropertyPosition } from '@texasrenters/shared';
import { useMap } from '@vis.gl/react-google-maps';
import { useCallback, useEffect, useRef, type RefObject } from 'react';

/**
 * Who moves the map: the reader, or the map itself.
 *
 * **The reader, whenever they have touched it.** The map used to fly back to
 * the selected technician at zoom 15 on every position that arrived, and re-fit
 * the whole patch on every refetch when nobody was selected -- so zooming in on
 * a street, or panning to look at a property, lasted a few seconds before the
 * view was pulled away. The effects that did it were keyed on the positions
 * themselves, although their own comments said they must not be.
 *
 * So the camera moves on its own for three reasons only, and never after the
 * reader has taken it until they ask for it back with Re-center:
 *
 * - **Something was picked** -- a technician, a property, a stop. The map goes
 *   there once.
 * - **A followed technician moved.** Picking a technician follows them, the way
 *   a navigation app follows the car, so a drive can be watched without
 *   touching anything.
 * - **Who and what is on the map changed**, with nothing picked -- somebody
 *   came on shift, the properties loaded. Never because anybody moved.
 */

export type CameraFocus =
  | { kind: 'OVERVIEW' }
  | { kind: 'TECHNICIAN'; technicianId: string }
  | { kind: 'PROPERTY'; propertyId: string };

/** Close enough to read the streets around a technician, far enough to see where they are going. */
export const FOLLOW_ZOOM = 15;

/** Past the clustering ceiling, so a picked property is drawn on its own. */
const PROPERTY_ZOOM = 18;

/**
 * A fitted single point zooms to a rooftop with no context, so a fit stops
 * here.
 */
const FIT_MAX_ZOOM = 15;

/**
 * How long after the map moves itself a camera change is still its own.
 *
 * Google animates a pan, and `center_changed` fires on every frame of it. A
 * reader who happens to click during those frames has not moved anything.
 */
const AUTOMATIC_MOVE_MS = 1_500;

/**
 * How long after the reader touches the map a camera change counts as theirs.
 *
 * Long enough to cover a click on Google's own zoom buttons -- the zoom lands on
 * the click, after the pointer is already up -- and a double-click.
 */
const GESTURE_WINDOW_MS = 800;

/**
 * Marks this console's own controls inside the map: Re-center and the panel
 * along the bottom. Touching those is not moving the map.
 */
export const MAP_OVERLAY_ATTRIBUTE = 'data-map-overlay';

export function focusKey(focus: CameraFocus) {
  if (focus.kind === 'TECHNICIAN') return `technician:${focus.technicianId}`;
  if (focus.kind === 'PROPERTY') return `property:${focus.propertyId}`;
  return 'overview';
}

type Point = { latitude: number; longitude: number };

const literal = (point: Point) => ({ lat: point.latitude, lng: point.longitude });

function fitTo(
  map: google.maps.Map,
  points: readonly [number, number][],
  padding: number,
  stillAutomatic: () => void,
) {
  const bounds = new google.maps.LatLngBounds();
  for (const [lat, lng] of points) bounds.extend({ lat, lng });
  map.fitBounds(bounds, padding);
  google.maps.event.addListenerOnce(map, 'idle', () => {
    const zoom = map.getZoom();
    if (zoom === undefined || zoom <= FIT_MAX_ZOOM) return;
    stillAutomatic();
    map.setZoom(FIT_MAX_ZOOM);
  });
}

/**
 * Calls `onReaderMoved` when the reader moves the camera, and not when the map
 * moves itself.
 *
 * Google does not say who moved it, so this watches for the reader's hands:
 *
 * - `dragstart` only ever comes from somebody dragging.
 * - A wheel over the map zooms it (gesture handling is greedy), so the wheel
 *   itself is enough -- waiting for the zoom would miss one that lands while
 *   the map is still animating a move of its own.
 * - Everything else -- Google's zoom and camera buttons, a double-click, a
 *   pinch, the keyboard -- is a pointer, touch or key on the map followed
 *   closely by the camera changing.
 */
export function useReaderMovesCamera(
  map: google.maps.Map | null,
  onReaderMoved: () => void,
  automaticUntil: RefObject<number>,
) {
  useEffect(() => {
    if (!map) return;
    const container = map.getDiv();
    let armedUntil = 0;

    const ours = (target: EventTarget | null) =>
      target instanceof Element && target.closest(`[${MAP_OVERLAY_ATTRIBUTE}]`) !== null;
    const arm = (event: Event) => {
      if (!ours(event.target)) armedUntil = Date.now() + GESTURE_WINDOW_MS;
    };
    const wheel = (event: Event) => {
      if (!ours(event.target)) onReaderMoved();
    };
    const cameraChanged = () => {
      const now = Date.now();
      if (now <= armedUntil && now > automaticUntil.current) onReaderMoved();
    };

    container.addEventListener('pointerdown', arm, true);
    container.addEventListener('touchstart', arm, { capture: true, passive: true });
    container.addEventListener('keydown', arm, true);
    container.addEventListener('wheel', wheel, { capture: true, passive: true });
    const listeners = [
      map.addListener('dragstart', onReaderMoved),
      map.addListener('zoom_changed', cameraChanged),
      map.addListener('center_changed', cameraChanged),
    ];

    return () => {
      container.removeEventListener('pointerdown', arm, true);
      container.removeEventListener('touchstart', arm, true);
      container.removeEventListener('keydown', arm, true);
      container.removeEventListener('wheel', wheel, true);
      for (const listener of listeners) listener.remove();
    };
  }, [map, onReaderMoved, automaticUntil]);
}

/**
 * Moves the camera for the map, and only when it should. Renders nothing.
 *
 * Everything that changes on every socket frame -- positions, points, the
 * property list -- is read through a ref, never depended on. The effects run
 * on intent: the focus, a Re-center, who is on the map, and where the one
 * followed technician is.
 */
export function CameraDirector({
  fallback,
  fitKey,
  focus,
  followed,
  onReaderMoved,
  points,
  properties,
  readerMoved,
  recenterRequest,
}: {
  /** The followed technician's stops, framed when they have no position yet. */
  fallback: readonly [number, number][];
  /** Who and what is on the map, not where. */
  fitKey: string;
  focus: CameraFocus;
  /** The focused technician's newest position, if they have one. */
  followed: Point | null;
  onReaderMoved: () => void;
  /** Everything the overview frames. */
  points: readonly [number, number][];
  properties: readonly PropertyPosition[];
  /** The reader has moved the map since the map last moved on its own. */
  readerMoved: boolean;
  /** Increments on every Re-center. */
  recenterRequest: number;
}) {
  const map = useMap();
  const automaticUntil = useRef(0);
  const readerHasMoved = useRef(readerMoved);
  readerHasMoved.current = readerMoved;
  const latest = useRef({ fallback, fitKey, followed, points, properties });
  latest.current = { fallback, fitKey, followed, points, properties };
  /** The `fitKey` the overview was last framed for. */
  const framedFor = useRef<string | null>(null);

  const markAutomatic = useCallback(() => {
    automaticUntil.current = Date.now() + AUTOMATIC_MOVE_MS;
  }, []);

  useReaderMovesCamera(map, onReaderMoved, automaticUntil);

  const frameOverview = useCallback(() => {
    const { fitKey: key, points: framed } = latest.current;
    if (!map || !framed.length) return;
    framedFor.current = key;
    markAutomatic();
    fitTo(map, framed, 48, markAutomatic);
  }, [map, markAutomatic]);

  const key = focusKey(focus);

  // To the focus: when it changes, and again on every Re-center.
  useEffect(() => {
    if (!map) return;
    const { fallback: stops, followed: position, properties: buildings } = latest.current;

    if (focus.kind === 'TECHNICIAN') {
      if (position) {
        markAutomatic();
        map.panTo(literal(position));
        map.setZoom(FOLLOW_ZOOM);
      } else if (stops.length) {
        // Not reporting yet, but they have work: framing it answers "where is
        // this person working" when "where are they" has no answer.
        markAutomatic();
        fitTo(map, stops, 64, markAutomatic);
      }
      return;
    }

    if (focus.kind === 'PROPERTY') {
      const building = buildings.find((entry) => entry.id === focus.propertyId);
      if (!building) return;
      markAutomatic();
      map.panTo(literal(building));
      map.setZoom(PROPERTY_ZOOM);
      return;
    }

    // Back to the overview. Letting go of a technician is not a request to
    // throw away a view the reader chose for themselves.
    if (!readerHasMoved.current) frameOverview();
    // `focus` itself is a new object on every selection render; `key` is its
    // identity, and the honest trigger.
  }, [map, key, recenterRequest, markAutomatic, frameOverview]);

  // The overview again when who or what is on the map changes -- somebody came
  // on shift, the properties arrived -- and never when anybody merely moved.
  useEffect(() => {
    if (focus.kind !== 'OVERVIEW' || readerHasMoved.current) return;
    if (framedFor.current === fitKey) return;
    frameOverview();
  }, [fitKey, focus.kind, frameOverview]);

  // Follow: the followed technician stays in the middle as their fixes arrive.
  // Pans without touching the zoom, which is the reader's.
  const followedAt = followed ? `${followed.latitude},${followed.longitude}` : null;
  useEffect(() => {
    const position = latest.current.followed;
    if (!map || focus.kind !== 'TECHNICIAN' || readerHasMoved.current || !position) return;
    markAutomatic();
    map.panTo(literal(position));
    // On where they are, as a string: the position object is rebuilt on every
    // refetch whether or not the technician moved.
  }, [map, followedAt, markAutomatic]);

  return null;
}
