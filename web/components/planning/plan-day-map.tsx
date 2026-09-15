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
import type { PlanDayStop } from '@/lib/planning-queries';

/**
 * One planned technician-day on the map: its stops in driving order, and the
 * road between them.
 *
 * Must be loaded with `ssr: false`, like the technician map: the Maps script
 * touches `window` and measures its container.
 */

const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID ?? 'DEMO_MAP_ID';
const FALLBACK_CENTER = { lat: 29.76, lng: -95.37 };

/**
 * A numbered stop, shaped by its kind of visit.
 *
 * An HVAC inspection is a square and an occupied one a circle, in two colours:
 * shape carries it for anyone who cannot tell the colours apart, on a map full
 * of green parks and red roads.
 */
const StopPin = memo(function StopPin({ order, hvac }: { order: number; hvac: boolean }) {
  return (
    <svg aria-hidden height="26" viewBox="0 0 26 26" width="26">
      {hvac ? (
        <rect className="fill-map-property" height="20" rx="4" stroke="#fff" strokeWidth="2" width="20" x="3" y="3" />
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

/** The day's line: a white casing under the route colour, as the technician map draws one. */
function RouteLine({ path, straight }: { path: readonly [number, number][]; straight: boolean }) {
  const map = useMap();

  useEffect(() => {
    if (!map || path.length < 2) return;
    const probe = document.createElement('span');
    probe.className = 'map-route-line';
    probe.style.display = 'none';
    document.body.append(probe);
    const color = strokeFrom(getComputedStyle(probe));
    probe.remove();

    const points = path.map(([lat, lng]) => ({ lat, lng }));
    const casing = new google.maps.Polyline({ map, path: points, strokeColor: '#fff', strokeOpacity: 0.9, strokeWeight: 7, zIndex: 1 });
    const line = new google.maps.Polyline({
      map,
      path: points,
      strokeColor: color,
      // Straight segments are drawn dashed, so nobody reads them as roads.
      strokeOpacity: straight ? 0 : 1,
      strokeWeight: 4,
      zIndex: 2,
      ...(straight
        ? { icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeWeight: 3, scale: 3 }, offset: '0', repeat: '14px' }] }
        : {}),
    });
    return () => {
      casing.setMap(null);
      line.setMap(null);
    };
  }, [map, path, straight]);

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
}: {
  dayKey: string;
  stops: readonly PlanDayStop[];
  /** The road line, `[lat, lng]`; empty draws straight segments between the stops instead. */
  geometry: readonly [number, number][];
}) {
  const { resolvedTheme } = useTheme();
  const placed = useMemo(
    () =>
      stops.filter(
        (stop): stop is PlanDayStop & { latitude: number; longitude: number } =>
          stop.latitude !== null && stop.longitude !== null,
      ),
    [stops],
  );
  const points = useMemo(() => placed.map((stop) => ({ lat: stop.latitude, lng: stop.longitude })), [placed]);
  const straight = geometry.length < 2;
  const path = useMemo<[number, number][]>(
    () => (straight ? placed.map((stop) => [stop.latitude, stop.longitude]) : [...geometry]),
    [geometry, placed, straight],
  );

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
          <RouteLine path={path} straight={straight} />
          {placed.map((stop, index) => (
            <AdvancedMarker
              key={stop.id}
              position={{ lat: stop.latitude, lng: stop.longitude }}
              title={`${index + 1}. ${stop.address ?? 'Unknown address'}`}
              zIndex={10 + index}
            >
              <StopPin hvac={stop.inspectionType === 'HVAC'} order={stop.positionInDay ?? index + 1} />
            </AdvancedMarker>
          ))}
        </GoogleMap>
      </MapOrReason>
    </APIProvider>
  );
}
