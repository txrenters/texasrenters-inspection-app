'use client';

import { OFFICE, type PropertyPosition } from '@texasrenters/shared';
import { memo, useMemo } from 'react';
import { Layer, Source } from 'react-map-gl/mapbox';

import { ConsoleMap } from '@/components/console-map';
import { useMapStroke } from '@/components/map-colors';
import { featureCollection, lineFeature } from '@/components/map-geometry';
import { visitsByProperty } from '@/lib/day-visits';
import { formatScheduledDate } from '@/lib/format';
import { useMapAssignments, usePropertyLocations } from '@/lib/queries';
import { weekdayOf } from '@/lib/schedule-calendar';
import { cn } from '@/lib/utils';

/**
 * A technician's colour on this map, and on the legend under it. The
 * categorical chart tokens, spelled out so Tailwind generates each one.
 */
const RUN_STROKES = ['stroke-chart-1', 'stroke-chart-2', 'stroke-chart-3', 'stroke-chart-4', 'stroke-chart-5'] as const;
const RUN_SWATCHES = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5'] as const;

interface Run {
  technicianId: string;
  name: string;
  tone: number;
  path: [number, number][];
}

/**
 * Jobber's map beside the schedule: the day's properties standing out from the
 * rest, each technician's stops joined in the order they are planned.
 *
 * **What it costs, per opening:** one Mapbox map load, one read of the day's
 * assignments (re-read every five minutes, as on the technician map), and the
 * property positions, cached for thirty minutes and shared with every other
 * map. The lines are straight, drawn here, so no Directions or Matrix request
 * is ever made -- they show the order of the day, not the roads. The map is
 * only mounted while "Map" is on.
 */
export function ScheduleMap({ date }: { date: string }) {
  const assignments = useMapAssignments(date);
  const locations = usePropertyLocations();

  const { highlighted, visits, runs } = useMemo(() => {
    const positions = new Map<string, PropertyPosition>((locations.data ?? []).map((place) => [place.id, place]));
    const day = assignments.data ?? [];
    return {
      highlighted: new Set(day.flatMap((entry) => entry.stops.flatMap((stop) => (stop.buildingId ? [stop.buildingId] : [])))),
      visits: visitsByProperty(day),
      runs: day
        .map(
          (entry, index): Run => ({
            technicianId: entry.technicianId,
            name: entry.displayName,
            tone: index % RUN_STROKES.length,
            path: entry.stops.flatMap((stop): [number, number][] => {
              const place = stop.buildingId ? positions.get(stop.buildingId) : undefined;
              return place ? [[place.latitude, place.longitude]] : [];
            }),
          }),
        )
        .filter((run) => run.path.length > 0),
    };
  }, [assignments.data, locations.data]);

  return (
    <section
      aria-label={`Map of ${weekdayOf(date)}, ${formatScheduledDate(date)}`}
      className="bg-card flex h-[28rem] flex-col overflow-hidden rounded-xl border lg:sticky lg:top-[calc(var(--app-header-height)+1rem)] lg:h-[calc(100svh-var(--app-header-height)-2rem)]"
    >
      {/* The day and whose line is whose, above the map: below it, the panel's
          foot sits past the bottom of the screen until the page is scrolled. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-3 py-2 text-xs">
        <span className="text-heading font-semibold">
          {weekdayOf(date)}, {formatScheduledDate(date)}
        </span>
        {runs.length ? (
          runs.map((run) => (
            <span className="flex items-center gap-1.5" key={run.technicianId}>
              <span aria-hidden className={cn('size-2 rounded-full', RUN_SWATCHES[run.tone])} />
              {run.name}
            </span>
          ))
        ) : (
          <span className="text-muted-foreground">
            {assignments.isLoading ? 'Loading the day…' : 'Nobody has a stop with a place on the map.'}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <ConsoleMap
          initialView={{ latitude: OFFICE.latitude, longitude: OFFICE.longitude, zoom: 9 }}
          portfolio={{ properties: locations.data, highlighted, visits }}
        >
          <RunsLayer runs={runs} />
        </ConsoleMap>
      </div>
    </section>
  );
}

/** Each technician's stops joined in order, in their colour: straight lines, no routing. */
const RunsLayer = memo(function RunsLayer({ runs }: { runs: readonly Run[] }) {
  // A fixed number of hook calls: one per colour, whatever the day holds.
  const strokes = [
    useMapStroke(RUN_STROKES[0]),
    useMapStroke(RUN_STROKES[1]),
    useMapStroke(RUN_STROKES[2]),
    useMapStroke(RUN_STROKES[3]),
    useMapStroke(RUN_STROKES[4]),
  ];
  const data = useMemo(
    () =>
      featureCollection(
        runs.filter((run) => run.path.length > 1).map((run) => lineFeature(run.path, { tone: run.tone })),
      ),
    [runs],
  );

  return (
    <Source data={data} id="schedule-runs" type="geojson">
      <Layer
        id="schedule-runs-line"
        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
        paint={{
          'line-color': ['match', ['get', 'tone'], 0, strokes[0], 1, strokes[1], 2, strokes[2], 3, strokes[3], strokes[4]],
          'line-width': 2.5,
          'line-opacity': 0.85,
          'line-dasharray': [2, 1.5],
        }}
        type="line"
      />
    </Source>
  );
});
