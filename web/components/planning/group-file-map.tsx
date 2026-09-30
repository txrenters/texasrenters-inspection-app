'use client';

import type { ExpressionSpecification } from 'mapbox-gl';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Layer, Marker, Popup, Source, useMap } from 'react-map-gl/mapbox';

import { ConsoleMap } from '@/components/console-map';
import { fitTo } from '@/components/map-camera';
import { inBox, padBox } from '@/components/map-clusters';
import { useMapStroke } from '@/components/map-colors';
import { featureCollection, lineFeature } from '@/components/map-geometry';
import { useSettledView } from '@/components/map-portfolio';
import { Badge } from '@/components/ui/badge';

import { fanOffsets, UNGROUPED_GREEN, type FileGroup, type GroupFileRow } from './group-file';
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

/**
 * One property: a disc in its group's colour with its stop number on it.
 *
 * A property the file could only place at its zip code's centre is drawn pale
 * with a dashed rim, so a pin standing on nobody's house says so before it is
 * clicked. The drop shadow is CSS, never an SVG filter: see `map-pins.tsx` for
 * the bug a shared filter id caused.
 */
const StopPin = memo(function StopPin({ row, fill, ink }: { row: GroupFileRow; fill: string; ink: string }) {
  return (
    <svg
      aria-hidden
      className="cursor-pointer drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]"
      height="22"
      viewBox="0 0 22 22"
      width="22"
    >
      {row.approximate ? (
        <>
          <circle cx="11" cy="11" fill="#fff" r="9" />
          <circle cx="11" cy="11" fill={fill} fillOpacity={0.35} r="9" stroke={fill} strokeDasharray="3.5 2" strokeWidth="2.5" />
        </>
      ) : (
        <circle cx="11" cy="11" fill={fill} r="9" stroke="#fff" strokeWidth="2" />
      )}
      <text
        dominantBaseline="central"
        fill={row.approximate ? '#111827' : ink}
        fontFamily="system-ui, sans-serif"
        // A size down for two digits: a group runs to 11 stops, and "11" at the
        // single-digit size reaches the rim.
        fontSize={row.stop !== null && row.stop >= 10 ? 9.5 : 11}
        fontWeight="700"
        letterSpacing={row.stop !== null && row.stop >= 10 ? -0.4 : undefined}
        textAnchor="middle"
        x="50%"
        y="50%"
      >
        {row.stop ?? '·'}
      </text>
    </svg>
  );
});

/**
 * A property in no group: a bright green dot with a white rim, no number.
 *
 * Green and saturated so what is left to group stands out on the light
 * roadmap and the dark one alike -- grey disappeared into both (the office,
 * 2026-09-30) -- and no group colour is ever that green. A wider invisible
 * ring takes the click, because a 13px target is a small one. The
 * approximate-location rule holds here too: pale, with a dashed rim.
 */
const UngroupedPin = memo(function UngroupedPin({ approximate }: { approximate: boolean }) {
  return (
    <svg aria-hidden className="cursor-pointer drop-shadow-[0_1px_1.5px_rgba(0,0,0,0.4)]" height="20" viewBox="0 0 20 20" width="20">
      <circle cx="10" cy="10" fill="transparent" r="10" />
      {approximate ? (
        <>
          <circle cx="10" cy="10" fill="#fff" r="6.5" />
          <circle
            cx="10"
            cy="10"
            fill={UNGROUPED_GREEN}
            fillOpacity={0.35}
            r="6.5"
            stroke={UNGROUPED_GREEN}
            strokeDasharray="2.5 1.8"
            strokeWidth="2"
          />
        </>
      ) : (
        <circle cx="10" cy="10" fill={UNGROUPED_GREEN} r="6.5" stroke="#fff" strokeWidth="2" />
      )}
    </svg>
  );
});

/** Clear of a pin's edge, which is 11px from its centre. */
const PIN_CLEARANCE_PX = 12;

/**
 * Where a window stands off its pin, for whichever side Mapbox opens it on.
 *
 * From the pin as drawn, which for a fanned-out pin is not its coordinate, and
 * then clear of the pin's edge on the side the window is on.
 */
function popupOffsets([x, y]: [number, number]) {
  const diagonal = PIN_CLEARANCE_PX * Math.SQRT1_2;
  return {
    center: [x, y] as [number, number],
    top: [x, y + PIN_CLEARANCE_PX] as [number, number],
    bottom: [x, y - PIN_CLEARANCE_PX] as [number, number],
    left: [x + PIN_CLEARANCE_PX, y] as [number, number],
    right: [x - PIN_CLEARANCE_PX, y] as [number, number],
    'top-left': [x + diagonal, y + diagonal] as [number, number],
    'top-right': [x - diagonal, y + diagonal] as [number, number],
    'bottom-left': [x + diagonal, y - diagonal] as [number, number],
    'bottom-right': [x - diagonal, y - diagonal] as [number, number],
  };
}

/** A group as it is named in words: its own name, or its number. */
const groupTitle = (group: FileGroup) => group.name ?? `Group ${group.label}`;

/** What a pin says when it is clicked. */
/** "From stop 2: 8 min · 5.1 km", the drive into this stop along the roads. */
function LegInto({ row, leg }: { row: GroupFileRow; leg: RoadLeg | null }) {
  if (!leg || row.stop === null) return null;
  const slow = leg.durationS >= SLOW_LEG_S;
  return (
    <p className={slow ? 'text-warning font-medium' : undefined}>
      From stop {row.stop - 1}: {formatDrive(leg.durationS)} ·{' '}
      <span className="text-road-distance font-medium">{formatKm(leg.distanceM)}</span>
      {slow ? ' · long leg' : null}
    </p>
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
          <LegInto leg={leg} row={row} />
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
      <LegInto leg={leg} row={row} />
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

  /** A group's road route, when it is a route of these very stops. */
  const routeOf = (group: FileGroup) => {
    const view = routeViews?.get(group.key);
    return view?.status === 'ok' && view.route.legs.length === group.rows.length - 1 ? view.route : null;
  };
  /** The drive into a stop from the one before it. */
  const legInto = (row: GroupFileRow, group: FileGroup | null): RoadLeg | null =>
    group && row.stop !== null && row.stop > 1 ? (routeOf(group)?.legs[row.stop - 2] ?? null) : null;

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
      const route = view?.status === 'ok' && view.route.legs.length === group.rows.length - 1 ? view.route : null;
      if (!route) return [];
      return route.legs.flatMap((leg, index) => {
        const [from, to] = [group.rows[index]!, group.rows[index + 1]!];
        const [longitude, latitude] =
          road ? midpointOf(legGeometry(route, index)) : [(from.longitude + to.longitude) / 2, (from.latitude + to.latitude) / 2];
        if (!legTimes.has(group.key) && reach && !inBox({ latitude, longitude }, reach)) return [];
        return [
          {
            key: `${group.key}:${index}`,
            latitude,
            longitude,
            from: from.stop ?? index + 1,
            to: to.stop ?? index + 2,
            leg,
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
  /** Every zone's ground and fence in one source, each painted from its own colour. */
  const zoneShapes = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: zones.flatMap((territory) => [
        {
          type: 'Feature' as const,
          properties: { color: territory.color, part: 'fill' },
          geometry: { type: 'MultiPolygon' as const, coordinates: territory.fill.map((ring) => [ring]) },
        },
        {
          type: 'Feature' as const,
          properties: { color: territory.color, part: 'fence' },
          geometry: { type: 'MultiLineString' as const, coordinates: territory.fence },
        },
      ]),
    }),
    [zones],
  );

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
    const straight = (from: GroupFileRow, to: GroupFileRow) =>
      [
        [from.latitude, from.longitude],
        [to.latitude, to.longitude],
      ] as const;
    const onRoad = (points: readonly LngLat[]) => points.map(([longitude, latitude]) => [latitude, longitude] as const);
    return featureCollection(
      groups.flatMap((group) => {
        if (group.rows.length < 2) return [];
        const properties = { color: group.color.fill, dim: dimOthers && group.key !== activeKey ? 1 : 0 };
        const view = routeViews?.get(group.key);
        const route = view?.status === 'ok' && view.route.legs.length === group.rows.length - 1 ? view.route : null;
        const drawRoad = road && route !== null;
        /** One leg's line: along the road when the road is drawn, straight when it is not. */
        const leg = (index: number) =>
          drawRoad ? onRoad(legGeometry(route, index)) : straight(group.rows[index]!, group.rows[index + 1]!);

        const features = [
          drawRoad
            ? lineFeature(onRoad(route.geometry), { ...properties, kind: 'road' })
            : lineFeature(
                group.rows.map((row) => [row.latitude, row.longitude] as const),
                { ...properties, kind: 'route' },
              ),
        ];
        // The file's long hop. With the road's own leg times it is the longest
        // of them; without, the longest straight step, as before.
        if (group.longHop !== null) {
          const hop = route
            ? route.legs.reduce((longest, entry, index) => (entry.durationS > route.legs[longest]!.durationS ? index : longest), 0)
            : group.longHop;
          features.push(lineFeature(leg(hop), { ...properties, kind: 'hop' }));
        }
        if (slowLegs && route)
          route.legs.forEach((entry, index) => {
            if (entry.durationS >= SLOW_LEG_S) features.push(lineFeature(leg(index), { ...properties, kind: 'slow' }));
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

      {/* The zones first, so they lie under everything else: a faint wash for
          each zone's ground, and its fence drawn just inside its own edge, so
          where two zones meet both fences show side by side. */}
      <Source data={zoneShapes} id="group-file-zones" type="geojson">
        <Layer
          filter={['==', ['get', 'part'], 'fill']}
          id="group-file-zone-fill"
          // No antialiasing: the fill is squares laid edge to edge, and an
          // antialiased edge draws each seam as a faint line.
          paint={{ 'fill-antialias': false, 'fill-color': ['get', 'color'], 'fill-opacity': 0.07 }}
          type="fill"
        />
        <Layer
          filter={['==', ['get', 'part'], 'fence']}
          id="group-file-zone-fence"
          layout={{ 'line-join': 'round' }}
          paint={{
            'line-color': ['get', 'color'],
            'line-offset': 1.5,
            'line-opacity': 0.85,
            'line-width': 2,
          }}
          type="line"
        />
      </Source>

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
          filter={['in', ['get', 'kind'], ['literal', ['route', 'road']]]}
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
              <StopPin fill={group.color.fill} ink={group.color.ink} row={row} />
            ) : (
              <UngroupedPin approximate={row.approximate} />
            )}
          </span>
        </Marker>
      ))}

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
        const slow = label.leg.durationS >= SLOW_LEG_S;
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
                slow ? 'border-warning text-warning' : 'border-road-distance text-foreground'
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

      {/* "Zone N", on one of the zone's own properties and just below its pin. */}
      {zones.map((territory) => (
        <Marker
          anchor="top"
          key={`zone-${territory.zone}`}
          latitude={territory.labelAt.latitude}
          longitude={territory.labelAt.longitude}
          offset={[0, 12]}
          // Over the pins so it can be read, under the group numbers; it lets
          // every click through to the pin beneath.
          style={{ zIndex: 845, pointerEvents: 'none' }}
        >
          <span
            className="rounded-md border-2 border-white px-1.5 py-px text-[11px] font-semibold shadow-sm"
            style={{ backgroundColor: territory.color, color: '#fff' }}
          >
            Zone {territory.zone}
          </span>
        </Marker>
      ))}

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
