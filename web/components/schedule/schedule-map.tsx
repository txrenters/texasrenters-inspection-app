'use client';

import { OFFICE, type PropertyPosition, type TechnicianRoute } from '@texasrenters/shared';
import { BuildingIcon } from 'lucide-react';
import type { ExpressionSpecification } from 'mapbox-gl';
import { memo, useEffect, useMemo, useRef } from 'react';
import { Layer, Marker, Source, useMap } from 'react-map-gl/mapbox';

import { ConsoleMap } from '@/components/console-map';
import { fitTo } from '@/components/map-camera';
import { useMapStroke } from '@/components/map-colors';
import { featureCollection, lineFeature } from '@/components/map-geometry';
import { usePermissions } from '@/lib/auth';
import { visitsByProperty } from '@/lib/day-visits';
import { formatScheduledDate } from '@/lib/format';
import { useMapAssignments, usePropertyLocations, useTechnicianRoutes } from '@/lib/queries';
import { weekdayOf } from '@/lib/schedule-calendar';
import { cn } from '@/lib/utils';

/**
 * A technician's colour on this map, and on the legend under it. The
 * categorical chart tokens, spelled out so Tailwind generates each one.
 */
const RUN_STROKES = ['stroke-chart-1', 'stroke-chart-2', 'stroke-chart-3', 'stroke-chart-4', 'stroke-chart-5'] as const;
const RUN_SWATCHES = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5'] as const;

type Path = [number, number][];

export interface Run {
  technicianId: string;
  name: string;
  tone: number;
  /** The day's stops in order: where the properties are, and the frame. */
  stops: Path;
  /** The drive already made, from the office through the finished stops, along the roads. */
  driven: Path;
  /** The drive still ahead, along the roads. */
  ahead: Path;
  /** Stops joined straight, only where no road route can be shown. */
  straight: Path;
}

const NO_ROUTES: readonly TechnicianRoute[] = [];

/**
 * Each technician's day as the map draws it (the office, 2026-11-05: "group
 * connectors not the actual routes that was already saved").
 *
 * With the route the technician map keeps for the day, the line is that route:
 * the drive done, from the office through the finished stops, and the drive
 * ahead. Without it -- no `technicians:locate`, or the route could not be
 * drawn -- the stops are joined straight, as before. A route still loading
 * draws nothing rather than a straight line that jumps to the roads a moment
 * later.
 */
export function dayRuns(
  day: readonly { technicianId: string; displayName: string; stops: readonly { buildingId?: string | null }[] }[],
  positions: ReadonlyMap<string, PropertyPosition>,
  routes: { allowed: boolean; byTechnician: ReadonlyMap<string, TechnicianRoute> },
): Run[] {
  return day
    .map((entry, index): Run => {
      const stops = entry.stops.flatMap((stop): Path => {
        const place = stop.buildingId ? positions.get(stop.buildingId) : undefined;
        return place ? [[place.latitude, place.longitude]] : [];
      });
      const route = routes.allowed ? routes.byTechnician.get(entry.technicianId) : undefined;
      const driven = route?.history.geometry ?? [];
      const ahead = route?.geometry ?? [];
      const drawn = driven.length > 1 || ahead.length > 1;
      const straight = !routes.allowed || (route && !drawn) ? stops : [];
      return { technicianId: entry.technicianId, name: entry.displayName, tone: index % RUN_STROKES.length, stops, driven, ahead, straight };
    })
    .filter((run) => run.stops.length > 0);
}

/**
 * Jobber's map beside the schedule: the day's properties alone, each
 * technician's day drawn along the roads in their colour.
 *
 * Only the day's properties are drawn (the office, 2026-11-05: "hide those
 * other properties or groups if not shown"); the rest of the portfolio is the
 * technician map's and the Group maker's.
 *
 * **What it costs, per day shown:** one Mapbox map load while "Map" is on, one
 * read of the day's assignments (every five minutes), the property positions
 * (cached thirty minutes, shared with every map), and, with
 * `technicians:locate`, one route read per technician on the day. Those are the
 * technician map's own routes: the server keeps each technician-day's drawn
 * route and redraws it only when that day's stops change, under its daily
 * Mapbox ceiling, so reading them again every minute costs nothing, and a day
 * the office has opened before costs nothing either. A day nobody has opened
 * since the server started is drawn once: one Directions request a technician
 * for the drive already made, and a Matrix and a Directions request for the
 * drive ahead.
 */
export function ScheduleMap({ date }: { date: string }) {
  const { has } = usePermissions();
  const allowed = has('technicians:locate');
  const assignments = useMapAssignments(date);
  const locations = usePropertyLocations();
  const ids = useMemo(() => (assignments.data ?? []).map((entry) => entry.technicianId), [assignments.data]);
  const routes = useTechnicianRoutes(ids, date, allowed && ids.length > 0) ?? NO_ROUTES;

  const { dayProperties, highlighted, visits, runs } = useMemo(() => {
    const positions = new Map<string, PropertyPosition>((locations.data ?? []).map((place) => [place.id, place]));
    const day = assignments.data ?? [];
    const onDay = new Set(day.flatMap((entry) => entry.stops.flatMap((stop) => (stop.buildingId ? [stop.buildingId] : []))));
    return {
      dayProperties: (locations.data ?? []).filter((place) => onDay.has(place.id)),
      highlighted: onDay,
      visits: visitsByProperty(day),
      runs: dayRuns(day, positions, {
        allowed,
        byTechnician: new Map(routes.map((route) => [route.technicianId, route])),
      }),
    };
  }, [allowed, assignments.data, locations.data, routes]);

  const drawsRoutes = runs.some((run) => run.driven.length > 1 || run.ahead.length > 1);

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
        {drawsRoutes ? (
          <span className="text-muted-foreground ml-auto">From the office · solid is done, dashed is ahead</span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        <ConsoleMap
          initialView={{ latitude: OFFICE.latitude, longitude: OFFICE.longitude, zoom: 9 }}
          portfolio={{ properties: dayProperties, highlighted, visits }}
        >
          <RunsLayer runs={runs} />
          {drawsRoutes ? <OfficeMarker /> : null}
          <FrameDay date={date} runs={runs} />
        </ConsoleMap>
      </div>
    </section>
  );
}

/**
 * Frames the day's stops when the day changes or its stops first arrive --
 * and only then, so the map does not jump while somebody is looking at a street.
 */
function FrameDay({ date, runs }: { date: string; runs: readonly Run[] }) {
  const { current: map } = useMap();
  const points = runs.flatMap((run) => run.stops);
  const latest = useRef(points);
  latest.current = points;
  const key = `${date}:${points.length > 0}`;
  useEffect(() => {
    if (!map || !latest.current.length) return;
    fitTo(map, latest.current, 48);
  }, [map, key]);
  return null;
}

/** Where every route starts (routes-start-from-the-office, 2026-10-22). */
function OfficeMarker() {
  return (
    <Marker anchor="center" latitude={OFFICE.latitude} longitude={OFFICE.longitude}>
      <span
        aria-label="The office, where every route starts"
        className="bg-heading text-background grid size-6 place-items-center rounded-md border-2 border-white shadow-md"
        role="img"
        title="Office"
      >
        <BuildingIcon aria-hidden className="size-3.5" />
      </span>
    </Marker>
  );
}

/**
 * Each technician's day in their colour: the drive done solid, the drive ahead
 * dashed, and stops joined straight -- lighter -- only where no road route can
 * be shown.
 */
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
        runs.flatMap((run) =>
          (
            [
              ['driven', run.driven],
              ['ahead', run.ahead],
              ['straight', run.straight],
            ] as const
          )
            .filter(([, path]) => path.length > 1)
            .map(([kind, path]) => lineFeature(path, { tone: run.tone, kind })),
        ),
      ),
    [runs],
  );
  const color: ExpressionSpecification = [
    'match',
    ['get', 'tone'],
    0,
    strokes[0],
    1,
    strokes[1],
    2,
    strokes[2],
    3,
    strokes[3],
    strokes[4],
  ];

  return (
    <Source data={data} id="schedule-runs" type="geojson">
      <Layer
        filter={['==', ['get', 'kind'], 'driven']}
        id="schedule-runs-driven"
        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
        paint={{ 'line-color': color, 'line-width': 3.5, 'line-opacity': 0.9 }}
        type="line"
      />
      <Layer
        filter={['==', ['get', 'kind'], 'ahead']}
        id="schedule-runs-ahead"
        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
        paint={{ 'line-color': color, 'line-width': 3, 'line-opacity': 0.85, 'line-dasharray': [2, 1.5] }}
        type="line"
      />
      <Layer
        filter={['==', ['get', 'kind'], 'straight']}
        id="schedule-runs-straight"
        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
        paint={{ 'line-color': color, 'line-width': 2, 'line-opacity': 0.6, 'line-dasharray': [1, 2] }}
        type="line"
      />
    </Source>
  );
});
