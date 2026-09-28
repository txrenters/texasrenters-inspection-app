'use client';

import 'mapbox-gl/dist/mapbox-gl.css';

import { useMemo } from 'react';
import Map, { Layer, Marker, Source, type LayerProps } from 'react-map-gl/mapbox';
import { useTheme } from 'next-themes';

import { circlePolygon, planGroups, type GroupableStop } from './plan-groups';

/**
 * A quarter's days, drawn as the office sketched them.
 *
 * One circle per day, sized to reach that day's properties, numbered in the
 * order the quarter is worked — a blanket of numbered circles over the patch,
 * low numbers around the outside. Where a circle is large, that day is spread
 * across the county; where two overlap, those days are covering the same
 * ground and could be one.
 *
 * Mapbox rather than Google, and that is not only a preference: the console's
 * Google maps go blank the moment that account's billing lapses, which is the
 * state they were in when this was written.
 */

/**
 * The browser token.
 *
 * Public by design, like every `pk.` token: it ships inside the bundle and
 * anyone reading the page can see it. Mapbox's answer is a URL restriction on
 * the token, not secrecy. Inlined at build time like every NEXT_PUBLIC_* value,
 * so it is a property of the image rather than something a restart can change.
 */
const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';

/** Houston, for the moment before the plan has been measured. */
const FALLBACK = { longitude: -95.5, latitude: 29.8, zoom: 8.5 };

function Unavailable({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card text-muted-foreground flex h-full w-full items-center justify-center rounded-lg border p-6 text-center text-sm">
      <p>{children}</p>
    </div>
  );
}

export function PlanGroupsMap({
  stops,
  onSelectDay,
  selectedDate,
}: {
  stops: readonly GroupableStop[];
  onSelectDay?: (date: string) => void;
  /** The day being read, drawn stronger than the rest. */
  selectedDate?: string | null;
}) {
  const { resolvedTheme } = useTheme();
  const groups = useMemo(() => planGroups(stops), [stops]);

  /**
   * Every circle in one source rather than one source each.
   *
   * A quarter is thirty-odd days and Mapbox re-evaluates a layer per source on
   * every frame of a zoom; thirty sources is the stutter the technician map
   * had to fix by grouping its pins.
   */
  const circles = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: groups.map((group) => ({
        type: 'Feature' as const,
        properties: {
          date: group.date,
          number: group.number,
          visits: group.stops.length,
          // Painted from the feature rather than by swapping layers, so
          // selecting a day costs a repaint and not a re-render.
          selected: group.date === selectedDate ? 1 : 0,
        },
        geometry: { type: 'Polygon' as const, coordinates: [circlePolygon(group)] },
      })),
    }),
    [groups, selectedDate],
  );

  const properties = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: groups.flatMap((group) =>
        group.stops.map((stop) => ({
          type: 'Feature' as const,
          properties: {},
          geometry: { type: 'Point' as const, coordinates: [stop.longitude, stop.latitude] },
        })),
      ),
    }),
    [groups],
  );

  if (!TOKEN)
    return <Unavailable>The map needs a Mapbox token (NEXT_PUBLIC_MAPBOX_TOKEN).</Unavailable>;
  if (!groups.length)
    return <Unavailable>No visit in this quarter has a day yet, so there are no groups to draw.</Unavailable>;

  const dark = resolvedTheme === 'dark';
  const fill: LayerProps = {
    id: 'group-fill',
    type: 'fill',
    paint: {
      'fill-color': dark ? '#4ade80' : '#16a34a',
      // Faint, because the reading is in the overlaps: two circles over the
      // same ground make a darker patch, and that is the signal.
      'fill-opacity': ['case', ['==', ['get', 'selected'], 1], 0.35, 0.12],
    },
  };
  const outline: LayerProps = {
    id: 'group-outline',
    type: 'line',
    paint: {
      'line-color': dark ? '#4ade80' : '#15803d',
      'line-width': ['case', ['==', ['get', 'selected'], 1], 3, 1.5],
      'line-opacity': 0.9,
    },
  };

  return (
    <Map
      initialViewState={FALLBACK}
      mapStyle={dark ? 'mapbox://styles/mapbox/dark-v11' : 'mapbox://styles/mapbox/streets-v12'}
      mapboxAccessToken={TOKEN}
      style={{ width: '100%', height: '100%', borderRadius: '0.5rem' }}
    >
      <Source data={circles} id="groups" type="geojson">
        <Layer {...fill} />
        <Layer {...outline} />
      </Source>

      {/* The properties themselves, small: the circles are the subject here. */}
      <Source data={properties} id="properties" type="geojson">
        <Layer
          id="property-dots"
          paint={{
            'circle-color': dark ? '#e5e7eb' : '#1f2937',
            'circle-radius': 2.5,
            'circle-opacity': 0.7,
          }}
          type="circle"
        />
      </Source>

      {/*
        The number, as a real element rather than a Mapbox symbol layer: it is
        the thing the office reads off this map, and a symbol layer hides a
        label the moment two collide — which is exactly where the circles
        overlap and the reading matters most.
      */}
      {groups.map((group) => (
        <Marker
          key={group.date}
          latitude={group.latitude}
          longitude={group.longitude}
          onClick={onSelectDay ? () => onSelectDay(group.date) : undefined}
        >
          <span
            className={[
              'flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-full border px-1.5 text-xs font-semibold shadow-sm',
              group.date === selectedDate
                ? 'border-success bg-success text-success-foreground'
                : 'border-border bg-card text-foreground',
            ].join(' ')}
            title={`Day ${group.number} · ${group.date} · ${group.stops.length} visits`}
          >
            {group.number}
          </span>
        </Marker>
      ))}
    </Map>
  );
}
