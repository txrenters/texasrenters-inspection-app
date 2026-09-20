'use client';

import {
  AdvancedMarker,
  APIProvider,
  APILoadingStatus,
  ColorScheme,
  Map as GoogleMap,
  useApiLoadingStatus,
  useMap,
} from '@vis.gl/react-google-maps';
import { useTheme } from 'next-themes';
import { memo, useEffect, useMemo } from 'react';

import { strokeFrom } from '@/components/technician-map';

/** A stop on the day's map: a visit, or a move-out or move-in the day is built around. */
export interface DayMapStop {
  id: string;
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
 * Must be loaded with `ssr: false`, like the technician map: the Maps script
 * touches `window` and measures its container.
 */

const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID ?? 'DEMO_MAP_ID';
const FALLBACK_CENTER = { lat: 29.76, lng: -95.37 };

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

/** A colour a CSS rule gives, read once: Google takes a colour string, not a `var()`. */
function strokeOf(className: string) {
  const probe = document.createElement('span');
  probe.className = className;
  probe.style.display = 'none';
  document.body.append(probe);
  const color = strokeFrom(getComputedStyle(probe));
  probe.remove();
  return color;
}

/**
 * A line on the map: a white casing under the colour, as the technician map
 * draws a route. Straight segments are dashed, so nobody reads them as roads.
 */
function RouteLine({
  path,
  straight,
  colorClass = 'map-route-line',
  weight = 4,
}: {
  path: readonly LatLng[];
  straight: boolean;
  colorClass?: string;
  weight?: number;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map || path.length < 2) return;
    const color = strokeOf(colorClass);
    const points = path.map(([lat, lng]) => ({ lat, lng }));
    const casing = new google.maps.Polyline({ map, path: points, strokeColor: '#fff', strokeOpacity: 0.9, strokeWeight: weight + 3, zIndex: 1 });
    const line = new google.maps.Polyline({
      map,
      path: points,
      strokeColor: color,
      strokeOpacity: straight ? 0 : 1,
      strokeWeight: weight,
      zIndex: 2,
      ...(straight
        ? { icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeWeight: 3, scale: 3 }, offset: '0', repeat: '14px' }] }
        : {}),
    });
    return () => {
      casing.setMap(null);
      line.setMap(null);
    };
  }, [map, path, straight, colorClass, weight]);

  return null;
}

/** Frames the day whenever a different day is shown. */
function FitStops({ dayKey, points }: { dayKey: string; points: readonly { lat: number; lng: number }[] }) {
  const map = useMap();

  useEffect(() => {
    if (!map || !points.length) return;
    const bounds = new google.maps.LatLngBounds();
    for (const point of points) bounds.extend(point);
    map.fitBounds(bounds, 56);
    const listener = google.maps.event.addListenerOnce(map, 'idle', () => {
      const zoom = map.getZoom();
      if (zoom !== undefined && zoom > 15) map.setZoom(15);
    });
    return () => listener.remove();
    // The points are memoised on the day's stops, so this re-frames when a
    // different day is shown or the day's stops change -- not on every render.
  }, [map, dayKey, points]);

  return null;
}

function Unavailable({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card text-muted-foreground flex h-full w-full items-center justify-center rounded-lg border p-6 text-center text-sm">
      <p>{children}</p>
    </div>
  );
}

/** The map, or the reason there is not one -- a rejected key must not take the day's list with it. */
function MapOrReason({ children }: { children: React.ReactNode }) {
  const status = useApiLoadingStatus();
  if (status === APILoadingStatus.AUTH_FAILURE)
    return <Unavailable>Google rejected this key for this site, so the map cannot be drawn.</Unavailable>;
  if (status === APILoadingStatus.FAILED)
    return <Unavailable>Google Maps could not be loaded. Reloading usually clears it.</Unavailable>;
  return <>{children}</>;
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
  const { resolvedTheme } = useTheme();
  const placed = useMemo(
    () =>
      stops.filter(
        (stop): stop is DayMapStop & { latitude: number; longitude: number } =>
          stop.latitude !== null && stop.longitude !== null,
      ),
    [stops],
  );
  // Home in the frame too: the drive from it is part of the day as driven.
  const points = useMemo(
    () => [
      ...(home ? [{ lat: home.latitude, lng: home.longitude }] : []),
      ...placed.map((stop) => ({ lat: stop.latitude, lng: stop.longitude })),
    ],
    [home, placed],
  );
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

  if (!API_KEY) return <Unavailable>The map needs a Google Maps browser key (NEXT_PUBLIC_GOOGLE_MAPS_API_KEY).</Unavailable>;

  return (
    <APIProvider apiKey={API_KEY}>
      <MapOrReason>
        <GoogleMap
          className="h-full w-full rounded-lg"
          colorScheme={resolvedTheme === 'dark' ? ColorScheme.DARK : ColorScheme.LIGHT}
          defaultCenter={FALLBACK_CENTER}
          defaultZoom={10}
          gestureHandling="greedy"
          mapId={MAP_ID}
          mapTypeControl={false}
          streetViewControl={false}
        >
          <FitStops dayKey={dayKey} points={points} />
          {/* The drive from home is shown apart from the day's driving between
              its properties, so it is drawn in the grey of a finished leg, from
              the "From" pin to the first property, under the day's route. */}
          <RouteLine colorClass="map-route-done-line" path={homePath} straight={homeStraight} weight={3} />
          <RouteLine path={path} straight={straight} />
          {home ? (
            <AdvancedMarker
              position={{ lat: home.latitude, lng: home.longitude }}
              title={`From: ${home.address ?? 'the technician’s home'}`}
              zIndex={5}
            >
              <HomePin />
            </AdvancedMarker>
          ) : null}
          {placed.map((stop, index) => {
            // A move-out or move-in is its own inspection, not one of the plan's visits: nothing to open here.
            const opens = Boolean(onSelectStop) && !isBooked(stop.kind);
            return (
              <AdvancedMarker
                clickable={opens}
                key={stop.id}
                onClick={opens ? () => onSelectStop?.(stop.id) : undefined}
                position={{ lat: stop.latitude, lng: stop.longitude }}
                title={`${stop.positionInDay ?? index + 1}. ${stop.kind === 'MOVE_OUT' ? 'Move-out: ' : stop.kind === 'MOVE_IN' ? 'Move-in: ' : ''}${stop.address ?? 'Unknown address'}${opens ? ' (open its details)' : ''}`}
                zIndex={10 + index}
              >
                <StopPin kind={stop.kind} order={stop.positionInDay ?? index + 1} />
              </AdvancedMarker>
            );
          })}
        </GoogleMap>
      </MapOrReason>
    </APIProvider>
  );
}
