'use client';

import { useMemo } from 'react';
import { Layer, Marker, Source, type LayerProps } from 'react-map-gl/mapbox';
import { useTheme } from 'next-themes';

import { ConsoleMap } from '@/components/console-map';

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
 * Drawn on `ConsoleMap` with the portfolio and the crew turned on, so the
 * quarter's days sit on the same map as everything else: the same pins, the
 * same people, and the grouping radius around the same portfolio. The radius
 * is worth having here above all: these circles are one per *day* and the
 * radius is one per *property*, so together they show both how a day is
 * spread and which properties were close enough to have shared one.
 *
 * It used to draw its own crew as letters in green circles and its own
 * properties as grey dots, which is exactly how the console came to have
 * "two different maps".
 */

/** Houston, for the moment before the plan has been measured. */
const FALLBACK = { longitude: -95.5, latitude: 29.8, zoom: 8.5 };

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
      crew
      initialView={FALLBACK}
      portfolio
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
          // Over the portfolio's pins and the crew: the day's number is what
          // this page is read by.
          style={{ zIndex: 800 }}
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
