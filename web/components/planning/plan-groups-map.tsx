'use client';

import { useMemo, useState } from 'react';

import { MapUnavailable } from '@/components/console-map';
import type { PlanDay } from '@/lib/planning-queries';

import type { GroupOrder } from './group-file';
import { GroupFileLegend, type LegendNoun } from './group-file-legend';
import { GroupFileMap, type MapFrame } from './group-file-map';
import { DEFAULT_MAP_DISPLAY, MapDisplaySwitches, type MapDisplay } from './group-file-view';
import { dayLabels, planDayGroups, type DayStop } from './plan-day-groups';
import { useRoadRoutes, type RouteRequest } from './road-routes';
import { useFillHeight } from './use-fill-height';
import { zoneTerritories } from './zone-territories';

/**
 * A quarter's days, drawn as the Group maker draws a template (the office,
 * 2026-10-01: the Group maker's map is the better one).
 *
 * Each technician-day is a group in its own colour, numbered in the order the
 * quarter is worked -- or, built from a template, as the Days list numbers it:
 * its template group's number, and N1, N2... for a day of none -- with its
 * stops numbered in the order they are driven and
 * the road between them; the list beside it is every day, which is both the
 * legend and the filter. A visit with no day yet is a green dot, as a property
 * in no group is in the Group maker.
 *
 * This replaced one numbered circle per date, sized to reach the day's
 * properties. The circles showed where a day was and how far it spread; this
 * shows the day itself -- which stop comes after which, and how long each
 * drive is -- and it reads the same as the Group maker the office builds
 * templates in.
 *
 * Must be loaded with `ssr: false`: Mapbox GL touches `window` and measures its
 * container.
 */

const DAY_NOUN: LegendNoun = { one: 'day', many: 'days', loose: 'no day yet' };

/** One empty list, so a map given no days is not grouped again on every render. */
const NO_DAYS: readonly Pick<PlanDay, 'date' | 'technicianId' | 'templateGroup'>[] = [];

export function PlanGroupsMap({
  stops,
  days = NO_DAYS,
}: {
  stops: readonly DayStop[];
  /** The server's days, for their template groups' numbers and colours. */
  days?: readonly Pick<PlanDay, 'date' | 'technicianId' | 'templateGroup'>[];
}) {
  const file = useMemo(() => planDayGroups(stops, dayLabels(days)), [days, stops]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [display, setDisplay] = useState<MapDisplay>(DEFAULT_MAP_DISPLAY);
  const [order, setOrder] = useState<GroupOrder>('number');
  /** The map and the list fill the window on a large screen, as in the Group maker. */
  const fill = useFillHeight<HTMLDivElement>();

  const shown = useMemo(
    () => (picked.size ? file.groups.filter((group) => picked.has(group.key)) : file.groups),
    [file.groups, picked],
  );
  /** Every visit's zone, whether it has a day or not: a zone is the tenancy's, not the day's. */
  const zones = useMemo(
    () => (display.zones ? zoneTerritories([...file.groups.flatMap((group) => group.rows), ...file.ungrouped]) : []),
    [display.zones, file],
  );
  /** Each day's road route, for its line on the map and its drive in the list. */
  const requests = useMemo<RouteRequest[]>(
    () =>
      file.groups.map((group) => ({
        id: group.key,
        coordinates: group.rows.map((row) => [row.longitude, row.latitude]),
      })),
    [file.groups],
  );
  const routeViews = useRoadRoutes(requests);

  /**
   * Framed when the days arrive and when the reader picks different ones, and
   * never because anything merely re-rendered.
   */
  const frame = useMemo<MapFrame>(
    () => ({
      key: `${file.groups.length}:${file.placed}:${[...picked].sort().join(',')}`,
      points: [
        ...shown.flatMap((group) => group.outline.map(([longitude, latitude]) => ({ latitude, longitude }))),
        ...(picked.size ? [] : file.ungrouped),
      ],
    }),
    [file.groups.length, file.placed, file.ungrouped, picked, shown],
  );

  const toggle = (key: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (!file.groups.length)
    return (
      <div className="h-80">
        <MapUnavailable>No visit in this quarter has a day yet, so there are no days to draw.</MapUnavailable>
      </div>
    );

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-muted-foreground min-w-0 text-sm">
          {file.placed.toLocaleString()} {file.placed === 1 ? 'visit' : 'visits'} over {file.groups.length.toLocaleString()}{' '}
          {file.groups.length === 1 ? 'day' : 'days'}
          {file.ungrouped.length ? ` · ${file.ungrouped.length.toLocaleString()} with no day yet` : ''}
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <MapDisplaySwitches display={display} onChange={setDisplay} />
        </div>
      </div>

      <div
        className="grid gap-3 lg:h-[36rem] lg:grid-cols-[minmax(0,1fr)_20rem] 2xl:grid-cols-[minmax(0,1fr)_24rem]"
        ref={fill.ref}
        style={fill.height ? { height: fill.height } : undefined}
      >
        <div className="h-80 lg:h-full">
          <GroupFileMap
            frame={frame}
            groups={shown}
            legTimes={display.legTimes ? picked : null}
            lines={display.lines}
            onPickGroup={(key) => setPicked(new Set([key]))}
            road={display.road}
            routeViews={routeViews}
            showOutlines={display.outlines}
            // A drive of 15 minutes or more between two stops, in amber: the leg to look at.
            slowLegs
            ungrouped={picked.size ? [] : file.ungrouped}
            zones={zones}
          />
        </div>
        <GroupFileLegend
          file={file}
          noun={DAY_NOUN}
          onOrder={setOrder}
          onShowAll={() => setPicked(new Set())}
          onToggle={toggle}
          order={order}
          picked={picked}
          routeViews={routeViews}
        />
      </div>
    </div>
  );
}
