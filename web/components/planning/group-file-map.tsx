'use client';

import type { ExpressionSpecification } from 'mapbox-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Layer, Marker, Popup, Source, useMap } from 'react-map-gl/mapbox';

import { ConsoleMap } from '@/components/console-map';
import { fitTo } from '@/components/map-camera';
import { inBox, padBox } from '@/components/map-clusters';
import { useMapStroke } from '@/components/map-colors';
import { GroupDisc, LooseDisc, popupOffsets } from '@/components/map-discs';
import { featureCollection, lineFeature } from '@/components/map-geometry';
import { useSettledView } from '@/components/map-portfolio';
import { ZoneLayers } from '@/components/map-zones';
import { Badge } from '@/components/ui/badge';

import { fanOffsets, legEnds, type FileGroup, type GroupFileRow } from './group-file';
import { GroupBadge } from './group-file-legend';
import {
  formatDrive,
  formatKm,
  legGeometry,
  midpointOf,
  SLOW_LEG_S,
  type LngLat,
  type RoadLeg,
  type RouteView,
} from './road-routes';
import type { ZoneTerritory } from './zone-territories';

/**
 * A groups file on the console's map: every property in its group's colour and
 * numbered in its visiting order, a light outline around each group with the
 * group's number on it, and a thin line through each group's stops in order.
 * A property in no group is a small grey dot.
 *
 * The same map draws manual grouping (`manual`): there a click on a property
 * builds the group rather than opening its details, and hovering says what it
 * is. One map for both, so a group built by hand looks exactly like one read
 * from a file.
 *
 * Drawn on `ConsoleMap`, with the crew, the reader's map type and the grouping
 * radius exactly as on every other map here. The portfolio is left off: the
 * file's rows *are* the properties, and drawing the portfolio as well would put
 * two pins on every address.
 *
 * Must be loaded with `ssr: false`: Mapbox GL touches `window` and measures its
 * container.
 */

/** A group's outline as the map draws it: a shape when it has an inside, a line when it does not. */
type OutlineFeature = {
  type: 'Feature';
  properties: { color: string; dim: number; active: number };
  geometry:
    | { type: 'Polygon'; coordinates: [number, number][][] }
    | { type: 'LineString'; coordinates: [number, number][] };
};

/** What the camera frames, and when: again only when `key` changes. */
export interface MapFrame {
  key: string;
  points: readonly { latitude: number; longitude: number }[];
}

/** Manual grouping, as the map takes part in it. */
export interface ManualMapOptions {
  /** The group being built. */
  activeKey: string | null;
  /** Every other group faded, so what is left ungrouped stands out. */
  dimOthers: boolean;
  /** A property was clicked: the grouping decides what that means. */
  onRowClick: (row: GroupFileRow) => void;
}

const NO_ZONES: readonly ZoneTerritory[] = [];
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * From this zoom in, every group on screen has its legs' drive times written
 * on the map, not only the groups picked. Further out there are too many legs
 * to read: forty groups of ten.
 */
const ALL_LEG_TIMES_FROM_ZOOM = 12;

/** Houston, for the moment before the file has been framed. */
const FALLBACK = { longitude: -95.5, latitude: 29.8, zoom: 8.5 };

/** How far past the edge of the view pins are still drawn, as in the portfolio layer. */
const DRAWN_BEYOND_VIEW = 0.5;

/** How faint a faded group is: still there to steer by, no longer in the way. */
const DIMMED = 0.2;

/** A group as it is named in words: its own name, or its number. */
const groupTitle = (group: FileGroup) => group.name ?? `Group ${group.label}`;

/** The legs before a group's first stop: the one from its origin, when it has one. */
const originLegs = (group: FileGroup) => (group.origin ? 1 : 0);

/** Every leg of a group's drive: one between each two of its stops, and the one from its origin. */
const legCount = (group: FileGroup) => Math.max(0, group.rows.length - 1) + originLegs(group);


/** Whether a group's drive into this row is the one from its origin: the first stop of a group that has one. */
const fromOrigin = (row: GroupFileRow, group: FileGroup | null) =>
  Boolean(group?.origin) && group!.rows[0]?.rowNumber === row.rowNumber;

/** What a pin says when it is clicked. */
/** "From stop 2: 8 min · 5.1 km", the drive into this stop along the roads -- or "From home" into a day's first. */
function LegInto({ row, leg, fromHome = false }: { row: GroupFileRow; leg: RoadLeg | null; fromHome?: boolean }) {
  if (!leg || row.stop === null) return null;
  // The drive from home is not held to the 15 minutes: it is not the day's driving.
  const slow = !fromHome && leg.durationS >= SLOW_LEG_S;
  return (
    <p className={slow ? 'text-warning font-medium' : undefined}>
      {fromHome ? 'From home' : `From stop ${row.stop - 1}`}: {formatDrive(leg.durationS)} ·{' '}
      <span className="text-road-distance font-medium">{formatKm(leg.distanceM)}</span>
      {slow ? ' · long leg' : null}
    </p>
  );
}

/** Where a planned day starts: the technician's home, labelled "From" as the office calls it. */
function HomePin() {
  return (
    <svg aria-hidden className="drop-shadow-sm" height="28" viewBox="0 0 66 28" width="66">
      <rect className="fill-map-technician" height="24" rx="12" stroke="#fff" strokeWidth="2" width="62" x="2" y="2" />
      <path d="M9.5 13.5 15 9l5.5 4.5V19a.5.5 0 0 1-.5.5h-3.25v-3.5h-3.5v3.5H10a.5.5 0 0 1-.5-.5z" fill="#fff" />
      <text dominantBaseline="central" fill="#fff" fontFamily="system-ui, sans-serif" fontSize="12" fontWeight="700" x="25" y="14">
        From
      </text>
    </svg>
  );
}

function RowDetails({ row, group, leg }: { row: GroupFileRow; group: FileGroup | null; leg: RoadLeg | null }) {
  const facts: [string, string | null][] = [
    ['Lease', row.lease],
    ['HVAC plan', row.hvacPlan],
    ['Zone', row.zone],
  ];
  return (
    <div className="grid max-w-64 gap-1 text-sm">
      <div>
        <p className="font-medium">
          {row.address || 'No address in the file'}
          {row.unit ? `, unit ${row.unit}` : null}
        </p>
        {row.city || row.zip ? <p>{[row.city, row.zip].filter(Boolean).join(' ')}</p> : null}
      </div>
      {group ? (
        <>
          <p className="flex items-center gap-1.5">
            <GroupBadge className="h-5 min-w-5 text-[11px]" group={group} />
            <span>
              {groupTitle(group)}
              {group.area ? ` · ${group.area}` : null}
            </span>
          </p>
          {row.stop === null ? null : (
            <p className="font-medium">
              Stop {row.stop} of {group.size}
            </p>
          )}
          <LegInto fromHome={fromOrigin(row, group)} leg={leg} row={row} />
        </>
      ) : (
        <p className="text-muted-foreground">In no group</p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs">
        {facts.map(([label, value]) =>
          value ? (
            <div className="contents" key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd>{value}</dd>
            </div>
          ) : null,
        )}
      </dl>
      {row.approximate ? (
        <Badge className="justify-self-start" variant="warning">
          Approximate location{row.geocodeSource ? ` (${row.geocodeSource})` : ''}
        </Badge>
      ) : null}
    </div>
  );
}

/**
 * What hovering over a pin says while groups are being built: where it is, and
 * whose. Short, because it follows the pointer across the map.
 */
function HoverDetails({ row, group, leg }: { row: GroupFileRow; group: FileGroup | null; leg: RoadLeg | null }) {
  return (
    <div className="grid max-w-60 gap-0.5 text-xs">
      <p className="text-sm font-medium">
        {row.address || 'No address in the file'}
        {row.unit ? `, unit ${row.unit}` : null}
      </p>
      {row.city ? <p>{row.city}</p> : null}
      {row.lease ? <p>Lease: {row.lease}</p> : null}
      {row.hvacPlan ? <p>HVAC plan: {row.hvacPlan}</p> : null}
      {row.zone ? <p>Zone: {row.zone}</p> : null}
      <p className="text-muted-foreground">
        {group ? `${groupTitle(group)} · stop ${row.stop}` : 'In no group'}
        {row.approximate ? ' · approximate location' : ''}
      </p>
      <LegInto fromHome={fromOrigin(row, group)} leg={leg} row={row} />
    </div>
  );
}

/**
 * Frames what it is given, whenever its key changes -- and only then.
 *
 * The key says why: the file arriving, groups ticked or unticked, a group
 * picked to build. Building a group changes the groups on every click, and
 * a map that re-framed itself each time would jump away from the next
 * property the reader was reaching for.
 *
 * 48px to spare: enough for a group's number standing above its top pin.
 */
function Frame({ frame }: { frame: MapFrame }) {
  const { current: map } = useMap();
  const points = useRef(frame.points);
  points.current = frame.points;
  useEffect(() => {
    const framed = points.current.map((point) => [point.latitude, point.longitude] as [number, number]);
    if (!map || !framed.length) return;
    fitTo(map, framed, 48);
  }, [map, frame.key]);
  return null;
}

/** Everything drawn for the file. Inside the map, because it reads the map's view. */
function GroupFileLayers({
  groups,
  ungrouped,
  lines,
  road,
  showOutlines,
  zones = NO_ZONES,
  legTimes = NO_KEYS,
  routeViews,
  slowLegs,
  frame,
  manual,
  onPickGroup,
}: {
  groups: readonly FileGroup[];
  ungrouped: readonly GroupFileRow[];
  lines: boolean;
  road: boolean;
  showOutlines: boolean;
  zones?: readonly ZoneTerritory[];
  /** Groups whose leg times show at any zoom; null for no leg times at all. */
  legTimes?: ReadonlySet<string> | null;
  routeViews?: ReadonlyMap<string, RouteView>;
  slowLegs: boolean;
  frame: MapFrame;
  manual?: ManualMapOptions;
  onPickGroup?: (key: string) => void;
}) {
  const { box, zoom } = useSettledView();
  const casing = useMapStroke('map-route-casing');
  /** The drive from home, in the grey of a finished leg: shown apart from the day's driving, as on every day map. */
  const homeColor = useMapStroke('map-route-done-line');
  const warning = useMapStroke('text-destructive');
  const amber = useMapStroke('text-warning');
  /** The road itself, in the purple-blue every road distance is written in (the office, 2026-09-30). */
  const roadColor = useMapStroke('text-road-distance');
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [hoverRow, setHoverRow] = useState<number | null>(null);

  const rows = useMemo(
    () => [
      ...groups.flatMap((group) => group.rows.map((row) => ({ row, group: group as FileGroup | null }))),
      ...ungrouped.map((row) => ({ row, group: null })),
    ],
    [groups, ungrouped],
  );
  const offsets = useMemo(() => fanOffsets(rows.map(({ row }) => row)), [rows]);
  const open = manual ? null : (rows.find(({ row }) => row.rowNumber === openRow) ?? null);
  const hovered = manual ? (rows.find(({ row }) => row.rowNumber === hoverRow) ?? null) : null;

  /** A group's road route, when it is a route of these very stops -- and from its origin, when it has one. */
  const routeOf = (group: FileGroup) => {
    const view = routeViews?.get(group.key);
    return view?.status === 'ok' && view.route.legs.length === legCount(group) ? view.route : null;
  };
  /** The drive into a stop from the one before it, or from the group's origin into its first. */
  const legInto = (row: GroupFileRow, group: FileGroup | null): RoadLeg | null => {
    if (!group || row.stop === null) return null;
    const leg = group.rows.findIndex((one) => one.rowNumber === row.rowNumber) - 1 + originLegs(group);
    return leg < 0 ? null : (routeOf(group)?.legs[leg] ?? null);
  };

  /**
   * Each leg's drive time, written halfway along it (the office, 2026-09-30:
   * "the drive time from property 1 to property 2, property 2 to property 3").
   * For the groups picked -- or being built -- always; for every group on
   * screen once zoomed in far enough to read them.
   */
  const legLabels = useMemo(() => {
    if (!lines || legTimes === null) return [];
    const everyGroup = zoom >= ALL_LEG_TIMES_FROM_ZOOM;
    const reach = box ? padBox(box, 0.1) : null;
    return groups.flatMap((group) => {
      if (!legTimes.has(group.key) && !everyGroup) return [];
      const view = routeViews?.get(group.key);
      const route = view?.status === 'ok' && view.route.legs.length === legCount(group) ? view.route : null;
      if (!route) return [];
      return route.legs.flatMap((leg, index) => {
        const { from, to, fromStop, toStop } = legEnds(group, index);
        const [longitude, latitude] =
          road ? midpointOf(legGeometry(route, index)) : [(from.longitude + to.longitude) / 2, (from.latitude + to.latitude) / 2];
        if (!legTimes.has(group.key) && reach && !inBox({ latitude, longitude }, reach)) return [];
        return [
          {
            key: `${group.key}:${index}`,
            latitude,
            longitude,
            from: fromStop,
            to: toStop,
            leg,
            home: fromStop === 'Home',
            color: group.color.fill,
            faded: Boolean(manual?.dimOthers && group.key !== manual.activeKey),
          },
        ];
      });
    });
  }, [box, groups, legTimes, lines, manual?.activeKey, manual?.dimOthers, road, routeViews, zoom]);
  /** Faded, when every group but the one being built is faded. */
  const faded = (group: FileGroup | null) => Boolean(manual?.dimOthers && group && group.key !== manual.activeKey);

  /**
   * Only the pins on or near the screen, as the portfolio layer does it.
   *
   * Four hundred pins are four hundred elements the map moves on every frame of
   * a zoom. The open pin stays drawn when panned away, so its window does not
   * close under the reader.
   */
  const drawn = useMemo(() => {
    if (!box) return rows;
    const reach = padBox(box, DRAWN_BEYOND_VIEW);
    return rows.filter(({ row }) => row.rowNumber === openRow || inBox(row, reach));
  }, [box, openRow, rows]);

  /**
   * Outlines and routes each in one source, painted from each shape's own
   * colour: a source per group would be forty-odd layers re-evaluated on
   * every frame of a zoom.
   */
  const dimOthers = manual?.dimOthers ?? false;
  const activeKey = manual?.activeKey ?? null;
  const outlines = useMemo(
    () =>
      featureCollection(
        groups.flatMap((group): OutlineFeature[] => {
          const ring = group.outline;
          const properties = {
            color: group.color.fill,
            dim: dimOthers && group.key !== activeKey ? 1 : 0,
            active: group.key === activeKey ? 1 : 0,
          };
          // A closed ring has an inside and is a shape. Properties all in a row
          // are a line, which the fill layer skips and the outline layer draws;
          // all at one spot, there is nothing to outline but the pins.
          if (ring.length >= 4)
            return [{ type: 'Feature' as const, properties, geometry: { type: 'Polygon' as const, coordinates: [ring] } }];
          if (ring.length === 2)
            return [{ type: 'Feature' as const, properties, geometry: { type: 'LineString' as const, coordinates: ring } }];
          return [];
        }),
      ),
    [activeKey, dimOthers, groups],
  );
  /**
   * Each group's drive in stop order, exactly as given: along the roads when
   * Mapbox has routed it and road routes are chosen, as straight dashed lines
   * otherwise -- while its route is on its way, or when it could not be had.
   *
   * On top of that, in one source so they always draw over the route they
   * belong to: the file's long hop in red, and while groups are built by hand
   * every leg of 15 minutes or more in amber. Both follow the road when the
   * road is drawn.
   */
  const routes = useMemo(() => {
    const onRoad = (points: readonly LngLat[]) => points.map(([longitude, latitude]) => [latitude, longitude] as const);
    return featureCollection(
      groups.flatMap((group) => {
        const before = originLegs(group);
        if (group.rows.length + before < 2) return [];
        const properties = { color: group.color.fill, dim: dimOthers && group.key !== activeKey ? 1 : 0 };
        const view = routeViews?.get(group.key);
        const route = view?.status === 'ok' && view.route.legs.length === legCount(group) ? view.route : null;
        const drawRoad = road && route !== null;
        /** One leg's line: along the road when the road is drawn, straight when it is not. Leg 0 is from the origin when there is one. */
        const leg = (index: number) => {
          if (drawRoad) return onRoad(legGeometry(route, index));
          const { from, to } = legEnds(group, index);
          return [
            [from.latitude, from.longitude],
            [to.latitude, to.longitude],
          ] as const;
        };

        const features = [
          // The drive from home, apart from the day's own driving.
          ...(before ? [lineFeature(leg(0), { ...properties, kind: drawRoad ? 'home' : 'home-straight' })] : []),
          ...(group.rows.length < 2
            ? []
            : [
                drawRoad
                  ? lineFeature(onRoad(route.geometry.slice(route.splits[before] ?? 0)), { ...properties, kind: 'road' })
                  : lineFeature(
                      group.rows.map((row) => [row.latitude, row.longitude] as const),
                      { ...properties, kind: 'route' },
                    ),
              ]),
        ];
        // The file's long hop. With the road's own leg times it is the longest
        // of them; without, the longest straight step, as before.
        if (group.longHop !== null) {
          const hop = route
            ? route.legs.reduce(
                (longest, entry, index) =>
                  index >= before && (longest < before || entry.durationS > route.legs[longest]!.durationS) ? index : longest,
                before,
              )
            : group.longHop + before;
          features.push(lineFeature(leg(hop), { ...properties, kind: 'hop' }));
        }
        // The drive from home is not the day's driving, and is not held to the 15 minutes.
        if (slowLegs && route)
          route.legs.forEach((entry, index) => {
            if (index >= before && entry.durationS >= SLOW_LEG_S)
              features.push(lineFeature(leg(index), { ...properties, kind: 'slow' }));
          });
        return features;
      }),
    );
  }, [activeKey, dimOthers, groups, road, routeViews, slowLegs]);

  // Hidden rather than unmounted, so switching them back on does not re-add
  // the layers on top of everything mounted since. Layer order is mount order.
  const visibility = lines ? 'visible' : 'none';
  const dimmed = (full: number): ExpressionSpecification => ['case', ['==', ['get', 'dim'], 1], full * DIMMED, full];

  return (
    <>
      <Frame frame={frame} />

      {/* The zones first, so they lie under everything else. */}
      <ZoneLayers zones={zones} />

      <Source data={outlines} id="group-file-outlines" type="geojson">
        {/* Hidden rather than unmounted, like the routes: layer order is mount
            order, and an outline re-added later would draw over the routes. */}
        <Layer
          id="group-file-outline-fill"
          layout={{ visibility: showOutlines ? 'visible' : 'none' }}
          // Faint: the outline says where a group is, and the pins inside are what is read.
          paint={{ 'fill-color': ['get', 'color'], 'fill-opacity': dimmed(0.08) }}
          type="fill"
        />
        <Layer
          id="group-file-outline-line"
          layout={{ visibility: showOutlines ? 'visible' : 'none' }}
          paint={{
            'line-color': ['get', 'color'],
            'line-opacity': dimmed(0.85),
            // The group being built, a touch firmer than the rest.
            'line-width': ['case', ['==', ['get', 'active'], 1], 2.5, 1.5],
          }}
          type="line"
        />
      </Source>

      <Source data={routes} id="group-file-routes" type="geojson">
        {/* A pale casing under the colour, as every route here has: a thin line
            on its own disappears into the roads it crosses. */}
        <Layer
          filter={['in', ['get', 'kind'], ['literal', ['route', 'road', 'home', 'home-straight']]]}
          id="group-file-route-casing"
          layout={{ visibility, 'line-cap': 'round', 'line-join': 'round' }}
          paint={{
            'line-color': casing,
            'line-opacity': dimmed(0.7),
            'line-width': ['case', ['==', ['get', 'kind'], 'road'], 5.5, 4],
          }}
          type="line"
        />
        {/* Dashed, because these are straight lines from stop to stop and not
            the roads between them -- the day map's rule for a straight segment. */}
        <Layer
          filter={['==', ['get', 'kind'], 'route']}
          id="group-file-route-line"
          layout={{ visibility, 'line-join': 'round' }}
          paint={{
            'line-color': ['get', 'color'],
            'line-dasharray': [2, 1.5],
            'line-opacity': dimmed(1),
            'line-width': 2,
          }}
          type="line"
        />
        {/* The drive from a planned day's home to its first stop, in grey: part
            of the day as driven, and not the day's driving the figures count.
            Dashed when it is a straight line rather than the road. */}
        <Layer
          filter={['==', ['get', 'kind'], 'home']}
          id="group-file-home-line"
          layout={{ visibility, 'line-cap': 'round', 'line-join': 'round' }}
          paint={{ 'line-color': homeColor, 'line-opacity': dimmed(1), 'line-width': 3 }}
          type="line"
        />
        <Layer
          filter={['==', ['get', 'kind'], 'home-straight']}
          id="group-file-home-straight"
          layout={{ visibility, 'line-join': 'round' }}
          paint={{ 'line-color': homeColor, 'line-dasharray': [2, 1.5], 'line-opacity': dimmed(1), 'line-width': 2 }}
          type="line"
        />
        {/* The road itself: solid, and purple-blue whatever the group -- the
            drive as it will be driven, told apart at a glance from the
            straight dashed lines and the outlines in the group's colour.
            The group is still its pins and its outline. */}
        <Layer
          filter={['==', ['get', 'kind'], 'road']}
          id="group-file-road-line"
          layout={{ visibility, 'line-cap': 'round', 'line-join': 'round' }}
          paint={{ 'line-color': roadColor, 'line-opacity': dimmed(1), 'line-width': 3 }}
          type="line"
        />
        {/* The long hop: solid, thicker and red over the dashed route, so it is
            told apart by weight and pattern as well as colour -- some group
            colours are reds too. Part of the route line, so it hides with it. */}
        <Layer
          filter={['==', ['get', 'kind'], 'hop']}
          id="group-file-hop-casing"
          layout={{ visibility, 'line-cap': 'round', 'line-join': 'round' }}
          paint={{ 'line-color': casing, 'line-opacity': dimmed(0.9), 'line-width': 8 }}
          type="line"
        />
        <Layer
          filter={['==', ['get', 'kind'], 'hop']}
          id="group-file-hop-line"
          layout={{ visibility, 'line-cap': 'round', 'line-join': 'round' }}
          paint={{ 'line-color': warning, 'line-opacity': dimmed(1), 'line-width': 4 }}
          type="line"
        />
        {/* A leg of 15 minutes or more while building by hand: amber, heavier
            than the route, so the leg to rethink shows at a glance. */}
        <Layer
          filter={['==', ['get', 'kind'], 'slow']}
          id="group-file-slow-casing"
          layout={{ visibility, 'line-cap': 'round', 'line-join': 'round' }}
          paint={{ 'line-color': casing, 'line-opacity': dimmed(0.9), 'line-width': 8 }}
          type="line"
        />
        <Layer
          filter={['==', ['get', 'kind'], 'slow']}
          id="group-file-slow-line"
          layout={{ visibility, 'line-cap': 'round', 'line-join': 'round' }}
          paint={{ 'line-color': amber, 'line-opacity': dimmed(1), 'line-width': 4.5 }}
          type="line"
        />
      </Source>

      {drawn.map(({ row, group }) => (
        <Marker
          anchor="center"
          key={row.rowNumber}
          latitude={row.latitude}
          longitude={row.longitude}
          offset={offsets.get(row.rowNumber)}
          onClick={(event) => {
            event.originalEvent.stopPropagation();
            if (manual) manual.onRowClick(row);
            else setOpenRow(row.rowNumber);
          }}
          // Grouped over ungrouped, so a numbered stop is never under a grey dot.
          style={{ zIndex: row.rowNumber === openRow ? 820 : group ? 800 : 790 }}
        >
          <span
            onMouseEnter={manual ? () => setHoverRow(row.rowNumber) : undefined}
            onMouseLeave={manual ? () => setHoverRow((current) => (current === row.rowNumber ? null : current)) : undefined}
            style={faded(group) ? { opacity: DIMMED } : undefined}
            title={
              manual
                ? undefined
                : `${row.address} · ${group ? `${groupTitle(group)}${row.stop === null ? '' : `, stop ${row.stop}`}` : 'in no group'}`
            }
          >
            {group ? (
              <GroupDisc approximate={row.approximate} fill={group.color.fill} ink={group.color.ink} label={row.stop ?? '·'} />
            ) : (
              <LooseDisc approximate={row.approximate} />
            )}
          </span>
        </Marker>
      ))}

      {/* Where a planned day starts: under the stops, so a stop at the
          technician's own door is still the one clicked. */}
      {groups.flatMap((group) =>
        group.origin
          ? [
              <Marker
                anchor="bottom"
                key={`origin-${group.key}`}
                latitude={group.origin.latitude}
                longitude={group.origin.longitude}
                style={{ zIndex: 780 }}
              >
                <span style={faded(group) ? { opacity: DIMMED } : undefined} title={group.origin.title}>
                  <HomePin />
                </span>
              </Marker>,
            ]
          : [],
      )}

      {/* Over the pins, standing on the outline's top corner -- its
          northernmost property -- and lifted clear of that pin (11px from its
          centre), so a group's number never covers one of its own properties. */}
      {groups.map((group) => (
        <Marker
          anchor="bottom"
          key={`group-${group.key}`}
          latitude={group.labelAt.latitude}
          longitude={group.labelAt.longitude}
          offset={[0, -14]}
          onClick={
            onPickGroup
              ? (event) => {
                  event.originalEvent.stopPropagation();
                  onPickGroup(group.key);
                }
              : undefined
          }
          style={{ zIndex: 850 }}
        >
          <span
            className={onPickGroup ? 'cursor-pointer' : undefined}
            style={faded(group) ? { opacity: DIMMED } : undefined}
            title={`${groupTitle(group)}${group.area ? ` · ${group.area}` : ''} · ${group.rows.length} properties${
              onPickGroup ? (manual ? ' (build this group)' : ' (show only this group)') : ''
            }`}
          >
            <GroupBadge group={group} />
          </span>
        </Marker>
      ))}

      {/* Each leg's drive time, halfway along it: over the lines and the pins,
          and letting every click through to what is under it. Amber from 15
          minutes, as the leg itself is. */}
      {legLabels.map((label) => {
        const slow = !label.home && label.leg.durationS >= SLOW_LEG_S;
        return (
          <Marker
            anchor="center"
            key={label.key}
            latitude={label.latitude}
            longitude={label.longitude}
            style={{ zIndex: 805, pointerEvents: 'none', opacity: label.faded ? DIMMED : 1 }}
          >
            <span
              className={`bg-card/95 rounded-full border-2 px-1.5 py-px text-[10px] leading-tight font-semibold whitespace-nowrap shadow-sm ${
                slow
                  ? 'border-warning text-warning'
                  : label.home
                    ? 'border-muted-foreground/60 text-muted-foreground'
                    : 'border-road-distance text-foreground'
              }`}
            >
              {/* Whose leg, when several groups are on screen: the group's own colour, as its pins are. */}
              <span
                aria-hidden
                className="mr-1 inline-block size-2 rounded-full align-[-0.5px]"
                style={{ backgroundColor: label.color }}
              />
              {label.from}→{label.to} · {formatDrive(label.leg.durationS)} · {formatKm(label.leg.distanceM)}
            </span>
          </Marker>
        );
      })}

      {open ? (
        <Popup
          // No fixed side: Mapbox opens it wherever there is room, so a pin near
          // the top of the map does not have its window cut off by the edge.
          closeOnClick={false}
          latitude={open.row.latitude}
          longitude={open.row.longitude}
          offset={popupOffsets(offsets.get(open.row.rowNumber) ?? [0, 0])}
          onClose={() => setOpenRow(null)}
          // Over the group numbers, which stand over every pin.
          style={{ zIndex: 900 }}
        >
          <RowDetails group={open.group} leg={legInto(open.row, open.group)} row={open.row} />
        </Popup>
      ) : null}

      {hovered ? (
        <Popup
          className="pointer-events-none"
          closeButton={false}
          closeOnClick={false}
          latitude={hovered.row.latitude}
          longitude={hovered.row.longitude}
          offset={popupOffsets(offsets.get(hovered.row.rowNumber) ?? [0, 0])}
          style={{ zIndex: 900 }}
        >
          <HoverDetails group={hovered.group} leg={legInto(hovered.row, hovered.group)} row={hovered.row} />
        </Popup>
      ) : null}
    </>
  );
}

export function GroupFileMap({
  groups,
  ungrouped = [],
  lines,
  road = false,
  showOutlines = true,
  zones,
  legTimes,
  routeViews,
  slowLegs = false,
  frame,
  manual,
  onPickGroup,
}: {
  /** The groups to draw: every group in the file, the ones picked, or the ones being built. */
  groups: readonly FileGroup[];
  /** Properties in no group: green dots. */
  ungrouped?: readonly GroupFileRow[];
  /** Whether each group's stops are joined in order. */
  lines: boolean;
  /** Along the roads where a group has been routed, rather than straight from stop to stop. */
  road?: boolean;
  /**
   * The straight-edged outline around each group, in its colour. Off by the
   * office's choice once the routes drew along the roads (2026-09-30): the pins
   * already carry the group's colour, and the edges crossed the routes.
   */
  showOutlines?: boolean;
  /** Each zone's ground and fence, when the zones are shown. */
  zones?: readonly ZoneTerritory[];
  /** Groups whose legs' drive times are written on the map at any zoom; null for none anywhere. */
  legTimes?: ReadonlySet<string> | null;
  /** Each group's road route, by group key. */
  routeViews?: ReadonlyMap<string, RouteView>;
  /** Legs of 15 minutes or more in amber. */
  slowLegs?: boolean;
  /** What to frame, and when. */
  frame: MapFrame;
  /** Present while groups are being built by hand. */
  manual?: ManualMapOptions;
  /** A group's number was clicked on the map. */
  onPickGroup?: (key: string) => void;
}) {
  // The grouping radius, when the reader turns it on, around the properties shown.
  const radiusPoints = useMemo(() => [...groups.flatMap((group) => group.rows), ...ungrouped], [groups, ungrouped]);

  return (
    <ConsoleMap crew initialView={FALLBACK} radiusPoints={radiusPoints}>
      <GroupFileLayers
        frame={frame}
        groups={groups}
        lines={lines}
        manual={manual}
        onPickGroup={onPickGroup}
        road={road}
        routeViews={routeViews}
        showOutlines={showOutlines}
        slowLegs={slowLegs}
        zones={zones}
        legTimes={legTimes}
        ungrouped={ungrouped}
      />
    </ConsoleMap>
  );
}
