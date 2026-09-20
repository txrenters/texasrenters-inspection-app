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

import { attentionText, type AttentionKind } from '@/lib/planning';

/**
 * Every visit still waiting for something, laid out on one map.
 *
 * The office (2026-09-20), looking at Jobber's unscheduled appointments beside
 * its map: "kaning naka needs attention pwede nato ni ma latag tanan sa map para
 * makita ni sila asa dapita?" -- so the visits with no day and no technician are
 * pins of their own, and the days already planned are behind them in grey, to
 * see which day each one is near. A pin opens the visit, where the day and the
 * technician are set.
 *
 * Must be loaded with `ssr: false`, like the day's map: the Maps script touches
 * `window` and measures its container.
 */

const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID ?? 'DEMO_MAP_ID';
const FALLBACK_CENTER = { lat: 29.76, lng: -95.37 };

/** A visit on the map: one waiting for something, or one already planned. */
export interface AttentionMapStop {
  id: string;
  address: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  /** What it is waiting for; null for a visit that has its day and technician. */
  attention: AttentionKind | null;
}

type Placed = AttentionMapStop & { latitude: number; longitude: number };

const placedOnly = (stops: readonly AttentionMapStop[]) =>
  stops.filter((stop): stop is Placed => stop.latitude !== null && stop.longitude !== null);

/**
 * A pin, shaped by what the visit is waiting for.
 *
 * A visit with no day is a ring, one with no technician a ring with a bar
 * across, and anything else a square: shape carries it for anyone who cannot
 * tell the colours apart, on a map full of green parks and red roads.
 */
const NeedsPin = memo(function NeedsPin({ kind }: { kind: AttentionKind }) {
  return (
    <svg aria-hidden className="cursor-pointer drop-shadow-sm" height="22" viewBox="0 0 22 22" width="22">
      {kind === 'NO_DAY' || kind === 'NO_TECHNICIAN' ? (
        <>
          <circle className="fill-warning" cx="11" cy="11" r="9" stroke="#fff" strokeWidth="2" />
          {kind === 'NO_TECHNICIAN' ? <rect fill="#fff" height="2.5" rx="1.25" width="10" x="6" y="9.75" /> : null}
        </>
      ) : (
        <rect className="fill-destructive" height="16" rx="3" stroke="#fff" strokeWidth="2" width="16" x="3" y="3" />
      )}
    </svg>
  );
});

/** A visit that already has its day: where the plan is, behind the ones that need attention. */
const PlannedDot = memo(function PlannedDot() {
  return (
    <svg aria-hidden height="10" viewBox="0 0 10 10" width="10">
      <circle className="fill-muted-foreground" cx="5" cy="5" opacity="0.65" r="4" />
    </svg>
  );
});

/** Frames every pin whenever the set of them changes. */
function FitAll({ points }: { points: readonly { lat: number; lng: number }[] }) {
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
  }, [map, points]);

  return null;
}

function Unavailable({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card text-muted-foreground flex h-full w-full items-center justify-center rounded-lg border p-6 text-center text-sm">
      <p>{children}</p>
    </div>
  );
}

/** The map, or the reason there is not one -- a rejected key must not take the list with it. */
function MapOrReason({ children }: { children: React.ReactNode }) {
  const status = useApiLoadingStatus();
  if (status === APILoadingStatus.AUTH_FAILURE)
    return <Unavailable>Google rejected this key for this site, so the map cannot be drawn.</Unavailable>;
  if (status === APILoadingStatus.FAILED)
    return <Unavailable>Google Maps could not be loaded. Reloading usually clears it.</Unavailable>;
  return <>{children}</>;
}

export function PlanAttentionMap({
  stops,
  planned = [],
  onSelectStop,
}: {
  /** The visits waiting for something. */
  stops: readonly AttentionMapStop[];
  /** The visits that already have a day, drawn behind them. */
  planned?: readonly AttentionMapStop[];
  onSelectStop?: (stopId: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  const needing = useMemo(() => placedOnly(stops), [stops]);
  const behind = useMemo(() => placedOnly(planned), [planned]);
  // The frame follows the visits that need attention: the plan behind them is
  // context, and a day at the other end of the patch must not shrink them away.
  const points = useMemo(() => needing.map((stop) => ({ lat: stop.latitude, lng: stop.longitude })), [needing]);

  if (!API_KEY) return <Unavailable>The map needs a Google Maps browser key (NEXT_PUBLIC_GOOGLE_MAPS_API_KEY).</Unavailable>;

  return (
    <APIProvider apiKey={API_KEY}>
      <MapOrReason>
        <GoogleMap
          className="h-full w-full rounded-lg"
          colorScheme={resolvedTheme === 'dark' ? ColorScheme.DARK : ColorScheme.LIGHT}
          defaultCenter={FALLBACK_CENTER}
          defaultZoom={9}
          gestureHandling="greedy"
          mapId={MAP_ID}
          mapTypeControl={false}
          streetViewControl={false}
        >
          <FitAll points={points} />
          {behind.map((stop) => (
            <AdvancedMarker
              clickable={false}
              key={stop.id}
              position={{ lat: stop.latitude, lng: stop.longitude }}
              title={`${stop.address ?? 'Unknown address'} · planned`}
              zIndex={1}
            >
              <PlannedDot />
            </AdvancedMarker>
          ))}
          {needing.map((stop, index) => (
            <AdvancedMarker
              clickable={Boolean(onSelectStop)}
              key={stop.id}
              onClick={onSelectStop ? () => onSelectStop(stop.id) : undefined}
              position={{ lat: stop.latitude, lng: stop.longitude }}
              title={`${stop.address ?? 'Unknown address'}${stop.city ? `, ${stop.city}` : ''} · ${attentionText(
                stop.attention ?? 'NO_DAY',
              )}${onSelectStop ? ' (open its details)' : ''}`}
              zIndex={10 + index}
            >
              <NeedsPin kind={stop.attention ?? 'NO_DAY'} />
            </AdvancedMarker>
          ))}
        </GoogleMap>
      </MapOrReason>
    </APIProvider>
  );
}
