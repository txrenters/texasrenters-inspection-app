'use client';

import { useMemo } from 'react';
import { Layer, Marker, Source, type LayerProps } from 'react-map-gl/mapbox';
import { useTheme } from 'next-themes';

import { ConsoleMap } from '@/components/console-map';

import { circlePolygon, planGroups, type GroupableStop } from './plan-groups';
import { presenceOf, type TechnicianPosition } from '@texasrenters/shared';

/**
 * A quarter's days, drawn as the office sketched them.
 *
 * One circle per day, sized to reach that day's properties, numbered in the
 * order the quarter is worked — a blanket of numbered circles over the patch,
 * low numbers around the outside. Where a circle is large, that day is spread
 * across the county; where two overlap, those days are covering the same
 * ground and could be one.
 *
 * Drawn on `ConsoleMap`, like every other map here, so the reader's map type,
 * the tilt and the grouping radius come with it. The radius is worth having on
 * this page above all others: these circles are one per *day*, and the radius
 * is one per *property*, so the two together show both how a day is spread and
 * which properties were close enough to have shared one.
 */

/** Houston, for the moment before the plan has been measured. */
const FALLBACK = { longitude: -95.5, latitude: 29.8, zoom: 8.5 };

export function PlanGroupsMap({
  stops,
  onSelectDay,
  selectedDate,
  technicians = [],
}: {
  stops: readonly GroupableStop[];
  onSelectDay?: (date: string) => void;
  /** The day being read, drawn stronger than the rest. */
  selectedDate?: string | null;
  /**
   * Where the crew are right now, over the plan they are working.
   *
   * The office asked for one map rather than two: the technician map and the
   * quarter's map showed different worlds, so seeing whether anybody is near
   * today's group meant opening another page and holding both in your head.
   * Empty by default, because a quarter three months out has nobody on it.
   */
  technicians?: readonly TechnicianPosition[];
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

  /**
   * What the shared grouping-radius overlay draws around.
   *
   * The day circles above are one per day; these are one per property. Read
   * together they answer the question the office actually asks of this page --
   * whether two days that look separate were ever close enough to be one.
   */
  const radiusPoints = useMemo(
    () => groups.flatMap((group) => group.stops.map((stop) => ({ latitude: stop.latitude, longitude: stop.longitude }))),
    [groups],
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
    <ConsoleMap
      initialView={FALLBACK}
      radiusPoints={radiusPoints}
      unavailable={
        groups.length
          ? undefined
          : 'No visit in this quarter has a day yet, so there are no groups to draw.'
      }
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
      {/*
        The crew, over the plan. Drawn after the circles so a person is never
        underneath one, and in the technician green the rest of the console
        uses for a person rather than a place.
      */}
      {technicians.map((position) => (
        <Marker
          key={position.technicianId}
          latitude={position.latitude}
          longitude={position.longitude}
        >
          <span
            className={[
              'flex h-5 w-5 items-center justify-center rounded-full border-2 border-white text-[10px] font-semibold text-white shadow',
              /**
               * The console's one answer to "is this person out there now".
               *
               * `presenceOf` rather than the timestamp: it also counts the app
               * being open, because location recording stops on its own often
               * enough -- the phone kills the task, a permission changes -- and
               * a technician visibly working is not offline because of it.
               */
              presenceOf(position) === 'ONLINE' ? 'bg-map-technician' : 'bg-map-technician-stale',
            ].join(' ')}
            title={`${position.technician?.displayName ?? 'Technician'} · ${
              presenceOf(position) === 'ONLINE'
                ? 'reporting now'
                : `last seen ${new Date(position.recordedAt).toLocaleString()}`
            }`}
          >
            {(position.technician?.displayName ?? '?').slice(0, 1).toUpperCase()}
          </span>
        </Marker>
      ))}

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
    </ConsoleMap>
  );
}
