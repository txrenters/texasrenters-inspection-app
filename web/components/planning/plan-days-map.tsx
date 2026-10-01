'use client';

import { useMemo } from 'react';

import type { FileGroup, GroupFileRow } from './group-file';
import { GroupFileMap, type MapFrame } from './group-file-map';
import type { MapDisplay } from './group-file-view';
import type { RouteView } from './road-routes';
import type { ZoneTerritory } from './zone-territories';

/**
 * The Days view's map: the Group maker's, with the quarter's days as its groups
 * (the office, 2026-10-02).
 *
 * The day picked in the list is the group being built: drawn from the
 * technician's home along the road, each leg's drive written on it, and every
 * other day faded when asked. A click on a property is the office's to decide
 * -- it joins the day picked, or opens the day's own visit -- so the map runs
 * in the Group maker's manual mode, which hands every click back.
 *
 * Must be loaded with `ssr: false`: Mapbox GL touches `window` and measures its
 * container.
 */
export function PlanDaysMap({
  groups,
  ungrouped,
  activeKey,
  origin,
  route,
  display,
  fadeOthers,
  zones,
  frame,
  onRowClick,
  onPickDay,
}: {
  groups: readonly FileGroup[];
  /** Visits with no day yet. */
  ungrouped: readonly GroupFileRow[];
  /** The day picked in the list. */
  activeKey: string | null;
  /** Where the day picked starts: the technician's home, when the day is routed from it. */
  origin: FileGroup['origin'];
  /** The day picked's road. */
  route: RouteView | undefined;
  display: MapDisplay;
  fadeOthers: boolean;
  zones: readonly ZoneTerritory[];
  frame: MapFrame;
  onRowClick: (row: GroupFileRow) => void;
  onPickDay: (key: string) => void;
}) {
  // Only the day picked starts at home: the others are drawn as the Group maker draws a group.
  const drawn = useMemo(
    () => (origin ? groups.map((group) => (group.key === activeKey ? { ...group, origin } : group)) : groups),
    [activeKey, groups, origin],
  );
  const routeViews = useMemo(
    () => new Map<string, RouteView>(activeKey && route ? [[activeKey, route]] : []),
    [activeKey, route],
  );
  const legTimes = useMemo(
    () => (display.legTimes ? new Set(activeKey ? [activeKey] : []) : null),
    [activeKey, display.legTimes],
  );

  return (
    <GroupFileMap
      frame={frame}
      groups={drawn}
      legTimes={legTimes}
      lines={display.lines}
      manual={{ activeKey, dimOthers: fadeOthers, onRowClick }}
      onPickGroup={onPickDay}
      road={display.road}
      routeViews={routeViews}
      showOutlines={display.outlines}
      // A drive of 15 minutes or more between two stops, in amber: the leg to look at.
      slowLegs
      ungrouped={ungrouped}
      zones={zones}
    />
  );
}
