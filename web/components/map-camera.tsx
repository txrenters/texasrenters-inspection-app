'use client';

import type { PropertyPosition } from '@texasrenters/shared';
import { useMap } from 'react-map-gl/mapbox';
import type { MapRef } from 'react-map-gl/mapbox';
import { useCallback, useEffect, useRef } from 'react';

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
export const PROPERTY_ZOOM = 18;

/**
 * A fitted single point zooms to a rooftop with no context, so a fit stops
 * here.
 */
const FIT_MAX_ZOOM = 15;

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

/** Mapbox takes a centre as [longitude, latitude], the other way round from Google. */
const literal = (point: Point): [number, number] => [point.longitude, point.latitude];

/**
 * Frame these points, without diving to the rooftops for one of them.
 *
 * Under Google this took two steps: fit, then wait for the map to settle and
 * pull the zoom back if it had gone too far, marking the correction automatic
 * so it did not read as the reader moving. Mapbox takes `maxZoom` with the fit,
 * so the second step and the race it carried are gone.
 */
export function fitTo(
  map: MapRef,
  points: readonly [number, number][],
  /** Pixels clear of each edge; per edge where something sits over the map there. */
  padding: number | { top: number; bottom: number; left: number; right: number },
) {
  let west = points[0]![1];
  let east = points[0]![1];
  let south = points[0]![0];
  let north = points[0]![0];
  for (const [lat, lng] of points) {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  map.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    { padding, maxZoom: FIT_MAX_ZOOM, duration: 0 },
  );
}

/**
 * Calls `onReaderMoved` when the reader moves the camera, and not when the map
 * moves itself.
 *
 * This used to be guesswork. Google does not say who moved the camera, so it
 * watched for the reader's hands -- a pointer, touch, wheel or key on the
 * container, then a camera change closely enough behind it -- with a
 * gesture window and a second clock marking the map's own moves so they were
 * not mistaken for somebody dragging.
 *
 * Mapbox says. Every camera event carries `originalEvent` when a person caused
 * it and nothing when the map moved itself, so the question is answered rather
 * than inferred — and the gesture window, the arming, and the clock that marked
 * the map's own moves are all gone with it. A fly-to can no longer be mistaken
 * for a drag, and a reader who clicks during one no longer loses their view.
 */
export function useReaderMovesCamera(
  map: MapRef | null | undefined,
  onReaderMoved: () => void,
) {
  useEffect(() => {
    if (!map) return;
    const moved = (event: { originalEvent?: unknown; target?: unknown }) => {
      // No original event means the map moved itself -- a fit, a follow, a
      // re-center -- which is not the reader taking over.
      if (!event.originalEvent) return;
      // Our own controls sit inside the map's container; touching Re-center is
      // not moving the map.
      const target = (event.originalEvent as Event | undefined)?.target ?? null;
      if (target instanceof Element && target.closest(`[${MAP_OVERLAY_ATTRIBUTE}]`)) return;
      onReaderMoved();
    };

    map.on('dragstart', moved);
    map.on('zoomstart', moved);
    map.on('rotatestart', moved);
    map.on('pitchstart', moved);

    return () => {
      map.off('dragstart', moved);
      map.off('zoomstart', moved);
      map.off('rotatestart', moved);
      map.off('pitchstart', moved);
    };
  }, [map, onReaderMoved]);
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
  /**
   * `useMap` hands back every map on the page, keyed; `current` is the one
   * this director is inside. Reaching for the collection itself type-checks
   * against its index signature and then fails at runtime, which is a poor
   * trade.
   */
  const { current: map } = useMap();
  const readerHasMoved = useRef(readerMoved);
  readerHasMoved.current = readerMoved;
  const latest = useRef({ fallback, fitKey, followed, points, properties });
  latest.current = { fallback, fitKey, followed, points, properties };
  /** The `fitKey` the overview was last framed for. */
  const framedFor = useRef<string | null>(null);

  useReaderMovesCamera(map, onReaderMoved);

  const frameOverview = useCallback(() => {
    const { fitKey: key, points: framed } = latest.current;
    if (!map || !framed.length) return;
    framedFor.current = key;
    fitTo(map, framed, 48);
  }, [map]);

  const key = focusKey(focus);

  // To the focus: when it changes, and again on every Re-center.
  useEffect(() => {
    if (!map) return;
    const { fallback: stops, followed: position, properties: buildings } = latest.current;

    if (focus.kind === 'TECHNICIAN') {
      if (position) {
        map.easeTo({ center: literal(position), zoom: FOLLOW_ZOOM });
      } else if (stops.length) {
        // Not reporting yet, but they have work: framing it answers "where is
        // this person working" when "where are they" has no answer.
        fitTo(map, stops, 64);
      }
      return;
    }

    if (focus.kind === 'PROPERTY') {
      const building = buildings.find((entry) => entry.id === focus.propertyId);
      if (!building) return;
      map.easeTo({ center: literal(building), zoom: PROPERTY_ZOOM });
      return;
    }

    // Back to the overview. Letting go of a technician is not a request to
    // throw away a view the reader chose for themselves.
    if (!readerHasMoved.current) frameOverview();
    // `focus` itself is a new object on every selection render; `key` is its
    // identity, and the honest trigger.
  }, [map, key, recenterRequest, frameOverview]);

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
    // Pans without touching the zoom, which is the reader's.
    map.easeTo({ center: literal(position) });
    // On where they are, as a string: the position object is rebuilt on every
    // refetch whether or not the technician moved.
  }, [map, followedAt]);

  return null;
}
