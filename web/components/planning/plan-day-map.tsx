'use client';

import { memo, useEffect, useMemo } from 'react';
import { Layer, Marker, Source, useMap, type LayerProps } from 'react-map-gl/mapbox';

import { ConsoleMap } from '@/components/console-map';
import { useMapStroke } from '@/components/map-colors';
import { featureCollection, lineFeature } from '@/components/map-geometry';

/** A stop on the day's map: a visit, or a move-out or move-in the day is built around. */
export interface DayMapStop {
  id: string;
  /** The building, so the portfolio can show this day's properties at full strength. */
  buildingId?: string | null;
  positionInDay: number | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  kind: 'HVAC' | 'OCCUPIED' | 'MOVE_OUT' | 'MOVE_IN';
}

/** A move-out or move-in: its own inspection, booked already, not one of the plan's visits. */
const isBooked = (kind: DayMapStop['kind']) => kind === 'MOVE_OUT' || kind === 'MOVE_IN';

/**
 * One planned technician-day on the map: the technician's home, the day's stops
 * in driving order, and the road between them.
 *
 * Drawn on `ConsoleMap` with the portfolio and the crew turned on, so this is
 * the technician map with a planned day on top of it: the same properties at
 * the same positions, the same people, and the same grouping radius drawn
 * around the same portfolio -- the reader's map type and 3D tilt with them. The office asked for that specifically: the radius was built
 * on the technician map and they went looking for it here, on the plan they
 * actually rebuild a quarter against, and it did not exist.
 *
 * Must be loaded with `ssr: false`: Mapbox GL touches `window` and measures its
 * container, neither of which exists on a server.
 */

/** Houston, for the moment before a day has been framed. */
const FALLBACK_VIEW = { longitude: -95.37, latitude: 29.76, zoom: 10 };

/** A fitted day stops here, so a single stop does not dive to the rooftops. */
const FIT_MAX_ZOOM = 15;

type LatLng = readonly [number, number];

/**
 * A numbered stop, shaped by its kind.
 *
 * An HVAC inspection is a square, an occupied one a circle, and a move-out or
 * move-in the day is built around a diamond, each in its own colour: shape carries it for
 * anyone who cannot tell the colours apart, on a map full of green parks and
 * red roads.
 */
const StopPin = memo(function StopPin({ order, kind }: { order: number; kind: DayMapStop['kind'] }) {
  return (
    <svg aria-hidden className={isBooked(kind) ? undefined : 'cursor-pointer'} height="26" viewBox="0 0 26 26" width="26">
      {kind === 'HVAC' ? (
        <rect className="fill-map-property" height="20" rx="4" stroke="#fff" strokeWidth="2" width="20" x="3" y="3" />
      ) : isBooked(kind) ? (
        <polygon className="fill-warning" points="13,1 25,13 13,25 1,13" stroke="#fff" strokeWidth="2" />
      ) : (
        <circle className="fill-map-route" cx="13" cy="13" r="10" stroke="#fff" strokeWidth="2" />
      )}
      <text
        dominantBaseline="central"
        fill="#fff"
        fontFamily="system-ui, sans-serif"
        fontSize="11"
        fontWeight="700"
        textAnchor="middle"
        x="50%"
        y="50%"
      >
        {order}
      </text>
    </svg>
  );
});

/** Where the day starts: the technician's home, labelled "From" as the office calls it. */
const HomePin = memo(function HomePin() {
  return (
    <svg aria-hidden className="drop-shadow-sm" height="28" viewBox="0 0 66 28" width="66">
      <rect className="fill-map-technician" height="24" rx="12" stroke="#fff" strokeWidth="2" width="62" x="2" y="2" />
      <path d="M9.5 13.5 15 9l5.5 4.5V19a.5.5 0 0 1-.5.5h-3.25v-3.5h-3.5v3.5H10a.5.5 0 0 1-.5-.5z" fill="#fff" />
      <text
        dominantBaseline="central"
        fill="#fff"
        fontFamily="system-ui, sans-serif"
        fontSize="12"
        fontWeight="700"
        x="25"
        y="14"
      >
        From
      </text>
    </svg>
  );
});

/**
 * Frames the day whenever a different day is shown.
 *
 * Under Google this was two steps — fit, then wait for the map to settle and
 * pull the zoom back if it had dived too far. Mapbox takes `maxZoom` with the
 * fit, so the second step and the listener it needed are gone.
 */
function FitStops({ dayKey, points }: { dayKey: string; points: readonly LatLng[] }) {
  const { current: map } = useMap();

  useEffect(() => {
    if (!map || !points.length) return;
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
      { padding: 56, maxZoom: FIT_MAX_ZOOM, duration: 0 },
    );
    // The points are memoised on the day's stops, so this re-frames when a
    // different day is shown or the day's stops change -- not on every render.
  }, [map, dayKey, points]);

  return null;
}

export function PlanDayMap({
  dayKey,
  stops,
  geometry,
  home = null,
  homeGeometry = [],
  onSelectStop,
}: {
  dayKey: string;
  stops: readonly DayMapStop[];
  /** The road line between the stops, `[lat, lng]`; empty draws straight segments instead. */
  geometry: readonly LatLng[];
  /** The technician's home, where the day starts. */
  home?: { latitude: number; longitude: number; address?: string | null } | null;
  /** The road from home to the first stop; empty draws a straight dashed segment. */
  homeGeometry?: readonly LatLng[];
  /** A stop's pin was clicked: open its details. */
  onSelectStop?: (stopId: string) => void;
}) {
  const routeColor = useMapStroke('map-route-line');
  const doneColor = useMapStroke('map-route-done-line');
  const casingColor = useMapStroke('map-route-casing');

  const placed = useMemo(
    () =>
      stops.filter(
        (stop): stop is DayMapStop & { latitude: number; longitude: number } =>
          stop.latitude !== null && stop.longitude !== null,
      ),
    [stops],
  );
  // Home in the frame too: the drive from it is part of the day as driven.
  const points = useMemo<LatLng[]>(
    () => [
      ...(home ? [[home.latitude, home.longitude] as LatLng] : []),
      ...placed.map((stop) => [stop.latitude, stop.longitude] as LatLng),
    ],
    [home, placed],
  );
  /**
   * The day's properties, picked out of the whole portfolio.
   *
   * The portfolio is drawn here exactly as on the technician map -- every
   * property, the same pins, the same positions, the same grouping radius --
   * and everything that is not this day recedes rather than disappearing,
   * because what is near the day is what somebody is weighing up. Null rather
   * than an empty set when no stop knows its building, or the whole portfolio
   * would be dimmed with nothing to stand out from it.
   */
  const dayBuildings = useMemo(() => {
    const ids = new Set(placed.flatMap((stop) => (stop.buildingId ? [stop.buildingId] : [])));
    return ids.size ? ids : null;
  }, [placed]);

  const straight = geometry.length < 2;
  const path = useMemo<LatLng[]>(
    () => (straight ? placed.map((stop) => [stop.latitude, stop.longitude] as const) : [...geometry]),
    [geometry, placed, straight],
  );
  const homeStraight = homeGeometry.length < 2;
  const homePath = useMemo<LatLng[]>(() => {
    if (!home || !placed.length) return [];
    return homeStraight ? [[home.latitude, home.longitude], [placed[0]!.latitude, placed[0]!.longitude]] : [...homeGeometry];
  }, [home, homeGeometry, homeStraight, placed]);

  /**
   * Both lines in one source.
   *
   * Mapbox draws layers in the order they were added, so two separately mounted
   * lines would stack by whichever happened to mount first. One source with a
   * casing layer under a colour layer is the road-map idiom these were always
   * drawn in, and it makes the order a fact rather than an accident.
   *
   * The drive from home is shown apart from the day's driving between its
   * properties, so it is drawn in the grey of a finished leg.
   */
  const lines = useMemo(
    () =>
      featureCollection([
        ...(homePath.length > 1
          ? [lineFeature(homePath, { tone: 'done', w: 3, dash: homeStraight ? 1 : 0 })]
          : []),
        ...(path.length > 1 ? [lineFeature(path, { tone: 'route', w: 4, dash: straight ? 1 : 0 })] : []),
      ]),
    [homePath, homeStraight, path, straight],
  );

  const color: LayerProps['paint'] = {
    'line-color': ['case', ['==', ['get', 'tone'], 'done'], doneColor, routeColor],
    'line-width': ['get', 'w'],
  };

  return (
    <ConsoleMap crew initialView={FALLBACK_VIEW} portfolio={{ highlighted: dayBuildings }}>
      <FitStops dayKey={dayKey} points={points} />

      <Source data={lines} id="day-route" type="geojson">
        {/* A pale casing under the colour: a single stroke the width of a
            street vanishes into the street it follows. */}
        <Layer
          id="day-route-casing"
          layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          paint={{
            'line-color': casingColor,
            'line-width': ['+', ['get', 'w'], 3],
            'line-opacity': 0.9,
          }}
          type="line"
        />
        {/* Straight segments are dashed, so nobody reads them as roads. Two
            layers rather than one, because `line-dasharray` is a property of
            the layer and cannot be read from the shape being drawn. */}
        <Layer
          filter={['==', ['get', 'dash'], 0]}
          id="day-route-line"
          layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          paint={color}
          type="line"
        />
        <Layer
          filter={['==', ['get', 'dash'], 1]}
          id="day-route-straight"
          layout={{ 'line-cap': 'butt', 'line-join': 'round' }}
          paint={{ ...color, 'line-dasharray': [1.4, 1.2] }}
          type="line"
        />
      </Source>

      {home ? (
        <Marker anchor="bottom" latitude={home.latitude} longitude={home.longitude} style={{ zIndex: 750 }}>
          <span title={`From: ${home.address ?? 'the technician’s home'}`}>
            <HomePin />
          </span>
        </Marker>
      ) : null}

      {placed.map((stop, index) => {
        // A move-out or move-in is its own inspection, not one of the plan's visits: nothing to open here.
        const opens = Boolean(onSelectStop) && !isBooked(stop.kind);
        return (
          <Marker
            anchor="bottom"
            key={stop.id}
            latitude={stop.latitude}
            longitude={stop.longitude}
            onClick={
              opens
                ? (event) => {
                    event.originalEvent.stopPropagation();
                    onSelectStop?.(stop.id);
                  }
                : undefined
            }
            style={{ zIndex: 800 + index }}
          >
            <span
              title={`${stop.positionInDay ?? index + 1}. ${stop.kind === 'MOVE_OUT' ? 'Move-out: ' : stop.kind === 'MOVE_IN' ? 'Move-in: ' : ''}${stop.address ?? 'Unknown address'}${opens ? ' (open its details)' : ''}`}
            >
              <StopPin kind={stop.kind} order={stop.positionInDay ?? index + 1} />
            </span>
          </Marker>
        );
      })}
    </ConsoleMap>
  );
}
