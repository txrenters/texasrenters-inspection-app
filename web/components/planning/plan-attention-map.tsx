'use client';

import { memo, useEffect, useMemo } from 'react';
import { Marker, useMap } from 'react-map-gl/mapbox';

import { ConsoleMap } from '@/components/console-map';
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
 * Drawn on `ConsoleMap` with the portfolio and the crew turned on, so these
 * pins sit on the same map as everywhere else -- and the grouping radius,
 * drawn around the whole portfolio, answers the question these pins raise:
 * which properties each of them is near enough to join.
 *
 * Must be loaded with `ssr: false`, like the day's map: Mapbox GL touches
 * `window` and measures its container.
 */

/** Houston, for the moment before the pins have been framed. */
const FALLBACK_VIEW = { longitude: -95.37, latitude: 29.76, zoom: 9 };

/** A fitted set stops here, so one lone visit does not dive to the rooftops. */
const FIT_MAX_ZOOM = 15;

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

/**
 * Frames every pin whenever the set of them changes.
 *
 * Mapbox takes `maxZoom` with the fit, so the follow-up listener Google needed
 * to pull an over-eager zoom back is gone.
 */
function FitAll({ points }: { points: readonly (readonly [number, number])[] }) {
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
  }, [map, points]);

  return null;
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
  const needing = useMemo(() => placedOnly(stops), [stops]);
  const behind = useMemo(() => placedOnly(planned), [planned]);
  // The frame follows the visits that need attention: the plan behind them is
  // context, and a day at the other end of the patch must not shrink them away.
  const points = useMemo(
    () => needing.map((stop) => [stop.latitude, stop.longitude] as const),
    [needing],
  );

  return (
    <ConsoleMap crew initialView={FALLBACK_VIEW} portfolio>
      <FitAll points={points} />
      {behind.map((stop) => (
        <Marker
          anchor="center"
          key={stop.id}
          latitude={stop.latitude}
          longitude={stop.longitude}
          style={{ zIndex: 150 }}
        >
          <span title={`${stop.address ?? 'Unknown address'} · planned`}>
            <PlannedDot />
          </span>
        </Marker>
      ))}
      {needing.map((stop, index) => (
        <Marker
          anchor="bottom"
          key={stop.id}
          latitude={stop.latitude}
          longitude={stop.longitude}
          onClick={
            onSelectStop
              ? (event) => {
                  event.originalEvent.stopPropagation();
                  onSelectStop(stop.id);
                }
              : undefined
          }
          style={{ zIndex: 800 + index }}
        >
          <span
            title={`${stop.address ?? 'Unknown address'}${stop.city ? `, ${stop.city}` : ''} · ${attentionText(
              stop.attention ?? 'NO_DAY',
            )}${onSelectStop ? ' (open its details)' : ''}`}
          >
            <NeedsPin kind={stop.attention ?? 'NO_DAY'} />
          </span>
        </Marker>
      ))}
    </ConsoleMap>
  );
}
