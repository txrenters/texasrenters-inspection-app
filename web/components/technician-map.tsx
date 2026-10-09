'use client';

import 'mapbox-gl/dist/mapbox-gl.css';

import type {
  PropertyPosition,
  TechnicianPosition,
  TechnicianRoute,
  TechnicianTrail,
} from '@texasrenters/shared';
import { splitRouteAtPosition, withLivePosition } from '@texasrenters/shared';
import { Fragment, memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layer, Marker, Popup, Source, useMap, type LayerProps } from 'react-map-gl/mapbox';

import { InspectionDetailsLink } from '@/components/inspection-details-link';
import { CameraDirector, fitTo, MAP_OVERLAY_ATTRIBUTE, type CameraFocus } from '@/components/map-camera';
import { pointsToFit } from '@/components/map-bounds';
import { ConsoleMap } from '@/components/console-map';
import { useMapStroke } from '@/components/map-colors';
import { featureCollection, lineFeature } from '@/components/map-geometry';
import { RecenterControl, TechnicianHud } from '@/components/technician-hud';
import type { PropertyVisit } from '@/lib/day-visits';
import { greatCirclePath, pathMidpoint } from '@/lib/great-circle';
import { formatDistance, formatDuration } from '@/lib/format';
import { useMotionTracks } from '@/lib/use-motion-tracks';
import { DonePin, PlanePin, StopPin } from '@/components/map-pins';

/**
 * Where every technician was when their handset last reported, over the
 * properties they are working.
 *
 * Mapbox, replacing Google, which replaced Leaflet. The reason for this move is
 * not taste: the console's Google maps go blank the moment that account's
 * billing lapses, and they did — every map in the console was a grey rectangle
 * for days, on a page the office uses to find people. The quarter planner was
 * drawn on Mapbox first; this brings the technician map onto the same provider
 * so the two are one map with two sets of things on it, rather than two maps
 * that disagree about the world.
 *
 * What survived every one of those moves is the part that was never about the
 * provider: `map-bounds.ts` and `map-clusters.ts` are pure arithmetic, and
 * `map-pins.tsx` is SVG. `map-geometry.ts` is new and is the one real
 * difference — Google drew a circle from a centre and a radius in metres, and
 * Mapbox's circle layer takes a radius in *pixels*, so every circle here is a
 * polygon in real coordinates instead.
 *
 * Must be loaded with `ssr: false`. Mapbox GL touches `window` and measures its
 * container, neither of which exists on a server.
 */

/**
 * The view the map opens with, before any data has arrived.
 *
 * Mapbox will render an unpositioned map at zoom 0 over the Atlantic rather
 * than refusing, which is quieter than Google's nothing-at-all and no more
 * useful. Texas, far enough out to hold the whole state.
 */
const FALLBACK_VIEW = { longitude: -99.0, latitude: 31.0, zoom: 5 };

/**
 * Every line on the map, in one source.
 *
 * Under Google each line was its own `Polyline` with a `zIndex`. Mapbox draws
 * layers in the order they were added, which means a line that appears later —
 * the travelled part of a route, say — would land on top of lines added before
 * it, and the stacking would depend on what happened to mount first. Two
 * layers over one source fixes that: every casing is painted, then every line
 * over it, which is the road-map idiom these were always drawn in.
 */
const ROUTE_SOURCE = 'technician-routes';

/**
 * The recommended drive, under the markers.
 *
 * Two lines, not one: a wide casing under a narrow line is what keeps a route
 * legible over both pale suburb and dark motorway.
 */
const RouteLayer = memo(function RouteLayer({
  currentInspectionIds,
  drawDriven,
  position,
  route,
}: {
  /** The visit under way, from the location trail, so its stop can say so. */
  currentInspectionIds: readonly string[] | null;
  /**
   * Whether to draw the road already behind them, in grey.
   *
   * That grey line is the road between the stops they finished, routed after
   * the fact -- the best the map could say about where they had been while it
   * had no trail. With their real trail drawn it is a second, guessed version
   * of the same drive lying under the true one, so it gives way. Still drawn
   * for a day with no trail: location paused, or a phone that never reported.
   */
  drawDriven: boolean;
  /**
   * Where the technician is now, which is where the route is cut.
   *
   * From the live position rather than from the route's own origin: the origin
   * is where they were when the line was last drawn, which is the whole
   * problem this solves.
   */
  position: { latitude: number; longitude: number } | null;
  route: TechnicianRoute | null;
}) {
  const [openStop, setOpenStop] = useState<string | null>(null);
  const casing = useMapStroke('map-route-casing');
  const done = useMapStroke('map-route-done-line');
  const ahead = useMapStroke('map-route-line');

  /**
   * The road behind them, and the road still ahead.
   *
   * A route is drawn once and reused for minutes, so between redraws its line
   * kept starting where they *were* -- orange leading back to somewhere they
   * had already driven. Google Maps consumes the road behind you and the
   * office asked for the same. The travelled part is not thrown away: it is
   * drawn in the grey the finished stops use, so the day still reads as one
   * continuous line.
   *
   * Off the line, this gives the whole route back as ahead -- see
   * `splitRouteAtPosition`. The redraw is what answers being off it.
   */
  const split = useMemo(
    () =>
      route
        ? splitRouteAtPosition(route.geometry, position)
        : { travelled: [] as [number, number][], ahead: [] as [number, number][] },
    [route, position],
  );

  const lines = useMemo(() => {
    if (!route) return featureCollection([]);
    const history = route.history.geometry;
    return featureCollection([
      // The day so far, in grey and under the orange: the drive through the
      // stops already finished. They used to disappear from the map as they
      // were submitted, so an afternoon showed only what was left.
      ...(drawDriven && history.length > 1
        ? [
            lineFeature(history, { kind: 'casing', w: 7, o: 0.6 }),
            lineFeature(history, { kind: 'line', tone: 'done', w: 4, o: 0.95 }),
          ]
        : []),
      // The part of this route already driven, in the same grey as the drives
      // between finished stops -- so the line is continuous and only its colour
      // says which side of the technician it is on.
      ...(drawDriven && split.travelled.length > 1
        ? [lineFeature(split.travelled, { kind: 'line', tone: 'done', w: 4, o: 0.9 })]
        : []),
      ...(split.ahead.length > 1
        ? [
            lineFeature(split.ahead, { kind: 'casing', w: 9, o: 0.9 }),
            lineFeature(split.ahead, { kind: 'line', tone: 'ahead', w: 4, o: 1 }),
          ]
        : []),
    ]);
  }, [drawDriven, route, split]);

  if (!route) return null;

  const current = new Set(currentInspectionIds ?? []);
  // The first stop still ahead: not the one they are standing at.
  const nextId = route.geometry.length
    ? route.stops.find((stop) => !current.has(stop.inspectionId))?.inspectionId
    : undefined;

  const casingLayer: LayerProps = {
    id: 'route-casing',
    type: 'line',
    filter: ['==', ['get', 'kind'], 'casing'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': casing,
      'line-width': ['get', 'w'],
      'line-opacity': ['get', 'o'],
    },
  };
  const lineLayer: LayerProps = {
    id: 'route-line',
    type: 'line',
    filter: ['==', ['get', 'kind'], 'line'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['case', ['==', ['get', 'tone'], 'done'], done, ahead],
      'line-width': ['get', 'w'],
      'line-opacity': ['get', 'o'],
    },
  };

  return (
    <>
      <Source data={lines} id={ROUTE_SOURCE} type="geojson">
        <Layer {...casingLayer} />
        <Layer {...lineLayer} />
      </Source>

      {route.history.stops.map((stop) => (
        <Fragment key={`done-${stop.inspectionId}`}>
          <Marker
            anchor="bottom"
            latitude={stop.latitude}
            longitude={stop.longitude}
            onClick={(event) => {
              event.originalEvent.stopPropagation();
              setOpenStop(stop.inspectionId);
            }}
            style={{ zIndex: 700 }}
          >
            <DonePin />
          </Marker>
          {openStop === stop.inspectionId ? (
            <Popup
              anchor="bottom"
              closeOnClick={false}
              latitude={stop.latitude}
              longitude={stop.longitude}
              offset={28}
              onClose={() => setOpenStop(null)}
            >
              <div className="text-popover-foreground grid gap-1.5 text-xs leading-relaxed">
                <div>
                  <div className="text-sm font-medium">{stop.propertyName}</div>
                  <div className="text-muted-foreground">
                    {stop.addressLine1}
                    {stop.city ? `, ${stop.city}` : null}
                  </div>
                  <div className="mt-1">Done</div>
                </div>
                <InspectionDetailsLink inspectionId={stop.inspectionId} />
              </div>
            </Popup>
          ) : null}
        </Fragment>
      ))}

      {(route.geometry.length ? route.stops : []).map((stop, index) => {
        // Legs run parallel to stops -- leg[i] is the drive that *arrives* at
        // stop[i], so the first one starts from the technician rather than
        // from another stop. That is also why `fromStopId` is nullable.
        const leg = route.legs[index];
        // Driving only. It deliberately excludes time spent inside the
        // properties before this one, because nothing here knows that yet --
        // so it is labelled as driving rather than presented as an arrival
        // time, which would be wrong by however long the day's work takes.
        const drivingSoFar = route.legs
          .slice(0, index + 1)
          .reduce((total, each) => total + each.durationSeconds, 0);
        return (
          <Fragment key={stop.inspectionId}>
            {/* Above the property pin it sits on, and above the technician,
                because while a route is shown the order is the thing being
                read. */}
            <Marker
              anchor="bottom"
              latitude={stop.latitude}
              longitude={stop.longitude}
              onClick={(event) => {
                event.originalEvent.stopPropagation();
                setOpenStop(stop.inspectionId);
              }}
              style={{ zIndex: 800 }}
            >
              {current.has(stop.inspectionId) ? (
                // Where the technician is, labelled on the pin itself beside
                // the marker that moves, so "which property" has an answer on
                // the map as well as in the list.
                <div className="flex flex-col items-center gap-0.5">
                  <span className="bg-map-technician rounded-full px-1.5 py-px text-[10px] font-semibold whitespace-nowrap text-white shadow">
                    Here now
                  </span>
                  <StopPin order={index + 1} />
                </div>
              ) : (
                <StopPin next={stop.inspectionId === nextId} order={index + 1} />
              )}
            </Marker>
            {openStop === stop.inspectionId ? (
              <Popup
                anchor="bottom"
                closeOnClick={false}
                latitude={stop.latitude}
                longitude={stop.longitude}
                offset={28}
                onClose={() => setOpenStop(null)}
              >
                {/* Explicit colours as well as the themed bubble: the popup is
                    styled through Mapbox's own class names in `globals.css`,
                    and if one of those ever changes the text stays legible
                    against whatever is painted behind it. */}
                <div className="text-popover-foreground text-xs leading-relaxed">
                  <div className="text-sm font-medium">
                    {index + 1}. {stop.propertyName}
                  </div>
                  <div className="text-muted-foreground">
                    {stop.addressLine1}
                    {stop.city ? `, ${stop.city}` : null}
                  </div>
                  {leg ? (
                    <div className="mt-1">
                      <div>
                        {formatDuration(leg.durationSeconds)} · {formatDistance(leg.distanceMeters)}{' '}
                        <span className="text-muted-foreground">
                          {leg.fromStopId === null ? 'from the technician' : 'from the last stop'}
                        </span>
                      </div>
                      {/* Only once there is something to accumulate. On the
                          first stop the running total and the leg are the same
                          number, and printing it twice reads as an error. */}
                      {index > 0 ? (
                        <div className="text-muted-foreground">
                          {formatDuration(drivingSoFar)} driving so far
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <InspectionDetailsLink className="mt-1.5" inspectionId={stop.inspectionId} />
                </div>
              </Popup>
            ) : null}
          </Fragment>
        );
      })}
    </>
  );
});

/**
 * The journey when there is no drive.
 *
 * Dashed and in its own colour, because it is emphatically not the road line:
 * nobody drives this, and drawing it like the routed one would suggest we had
 * planned it. The plane sits on the path rather than at either end, which is
 * the only position that reads as "between these two" rather than "here".
 *
 * There is no time on it. A flight duration needs airports, schedules and
 * connections this system does not have, and deriving one from distance would
 * be wrong by hours while looking authoritative.
 */
const AirTravelLayer = memo(function AirTravelLayer({ route }: { route: TechnicianRoute | null }) {
  const stroke = useMapStroke('map-air-line');
  const runs = useMemo(() => {
    if (!route?.airTravel || !route.origin) return [];
    const stop = route.stops.find((entry) => entry.inspectionId === route.airTravel?.inspectionId);
    if (!stop) return [];
    return greatCirclePath(route.origin, stop);
  }, [route]);

  const data = useMemo(() => featureCollection(runs.map((run) => lineFeature(run))), [runs]);

  if (!runs.length) return null;
  const middle = pathMidpoint(runs);

  return (
    <>
      <Source data={data} id="air-travel" type="geojson">
        <Layer
          id="air-travel-line"
          layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          paint={{
            'line-color': stroke,
            'line-width': 2,
            'line-opacity': 0.9,
            // Google drew a dashed line as an invisible stroke plus repeating
            // glyphs; Mapbox has dashes, in multiples of the line's width.
            'line-dasharray': [1, 1.6],
          }}
          type="line"
        />
      </Source>
      {middle ? (
        <Marker anchor="bottom" latitude={middle[0]} longitude={middle[1]} style={{ zIndex: 700 }}>
          <PlanePin />
        </Marker>
      ) : null}
    </>
  );
});

/** A line for somebody the page gave no colour, which it never should. */
const UNCOLOURED_LINE = '#2563eb';

/**
 * Where each technician actually went that day, in their colour (the office,
 * 2026-10-02: "the trailing lines").
 *
 * The road they drove, from their own phone's fixes -- not the routed guess
 * between finished stops that the grey line is. Solid, over a white casing
 * that carries it across the dark roadmap; wider for the person selected, and
 * everyone else's recedes rather than disappearing while somebody is, as the
 * rest of the map does. Broken where the phone went quiet, so a gap reads as a
 * gap rather than as a straight line through people's houses.
 *
 * On the day that is happening, each line runs on to the marker from the live
 * position, which arrives far more often than the trail is fetched.
 *
 * Always mounted, even with nothing to draw: layer order is mount order, and a
 * source that came and went would land on top of the selected route.
 */
const TrailLayer = memo(function TrailLayer({
  colors,
  live,
  positions,
  selectedTechnicianId,
  trails,
}: {
  colors: ReadonlyMap<string, string>;
  /** The day shown is today, so the live position is part of it. */
  live: boolean;
  positions: readonly TechnicianPosition[];
  selectedTechnicianId: string | null;
  trails: readonly TechnicianTrail[];
}) {
  const data = useMemo(() => {
    const here = new Map(positions.map((position) => [position.technicianId, position]));
    return featureCollection(
      trails.flatMap((trail) => {
        const selected = trail.technicianId === selectedTechnicianId;
        const receded = Boolean(selectedTechnicianId) && !selected;
        const color = colors.get(trail.technicianId) ?? UNCOLOURED_LINE;
        const segments = live
          ? withLivePosition(trail.segments, here.get(trail.technicianId))
          : trail.segments;
        return segments
          .filter((segment) => segment.points.length > 1)
          .flatMap((segment) => [
            lineFeature(segment.points, {
              kind: 'casing',
              w: selected ? 8 : 5.5,
              o: receded ? 0.2 : 0.85,
              z: selected ? 1 : 0,
            }),
            lineFeature(segment.points, {
              kind: 'line',
              color,
              w: selected ? 5 : 3,
              o: receded ? 0.3 : 0.95,
              z: selected ? 1 : 0,
            }),
          ]);
      }),
    );
  }, [colors, live, positions, selectedTechnicianId, trails]);

  return (
    <Source data={data} id="technician-trails" type="geojson">
      <Layer
        filter={['==', ['get', 'kind'], 'casing']}
        id="trail-casing"
        // The selected person's line over everybody else's where they cross.
        layout={{ 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'z'] }}
        paint={{ 'line-color': '#ffffff', 'line-width': ['get', 'w'], 'line-opacity': ['get', 'o'] }}
        type="line"
      />
      <Layer
        filter={['==', ['get', 'kind'], 'line']}
        id="trail-line"
        layout={{ 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'z'] }}
        paint={{
          'line-color': ['get', 'color'],
          'line-width': ['get', 'w'],
          'line-opacity': ['get', 'o'],
        }}
        type="line"
      />
    </Source>
  );
});

/**
 * Everybody's day still ahead of them, dashed in their colour: the line on to
 * the properties they are yet to visit (the office, 2026-10-02: "the lines that
 * connects to the scheduled property of the scheduled day").
 *
 * Dashed because it is a plan, not a drive -- the solid lines are where people
 * actually went. Cut at their live position on the day that is happening, the
 * way the selected route is. The selected technician's own day is skipped:
 * `RouteLayer` draws it, numbered, in the route's orange.
 *
 * Always mounted, for the same reason as the trails, and under them.
 */
const CrewRoutesLayer = memo(function CrewRoutesLayer({
  colors,
  live,
  positions,
  routes,
  selectedTechnicianId,
}: {
  colors: ReadonlyMap<string, string>;
  live: boolean;
  positions: readonly TechnicianPosition[];
  routes: readonly TechnicianRoute[];
  selectedTechnicianId: string | null;
}) {
  const data = useMemo(() => {
    const here = new Map(positions.map((position) => [position.technicianId, position]));
    const receded = Boolean(selectedTechnicianId);
    return featureCollection(
      routes.flatMap((route) => {
        if (route.technicianId === selectedTechnicianId || route.geometry.length < 2) return [];
        const ahead = live
          ? splitRouteAtPosition(route.geometry, here.get(route.technicianId) ?? null).ahead
          : route.geometry;
        if (ahead.length < 2) return [];
        return [
          lineFeature(ahead, { kind: 'casing', o: receded ? 0.2 : 0.7 }),
          lineFeature(ahead, {
            kind: 'line',
            color: colors.get(route.technicianId) ?? UNCOLOURED_LINE,
            o: receded ? 0.35 : 0.95,
          }),
        ];
      }),
    );
  }, [colors, live, positions, routes, selectedTechnicianId]);

  return (
    <Source data={data} id="crew-routes" type="geojson">
      <Layer
        filter={['==', ['get', 'kind'], 'casing']}
        id="crew-route-casing"
        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
        paint={{ 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': ['get', 'o'] }}
        type="line"
      />
      <Layer
        filter={['==', ['get', 'kind'], 'line']}
        id="crew-route-line"
        layout={{ 'line-join': 'round' }}
        paint={{
          'line-color': ['get', 'color'],
          'line-width': 2.5,
          'line-opacity': ['get', 'o'],
          // In multiples of the width, and one pattern for the whole layer:
          // Mapbox cannot vary a dash by feature.
          'line-dasharray': [2, 1.5],
        }}
        type="line"
      />
    </Source>
  );
});

/** Past this many matches a search frames nothing useful, and the map stays where it is. */
const MAX_FRAMED_MATCHES = 60;

/**
 * Frames what a search is showing, as it narrows (the office, 2026-10-02: "the
 * map should show them too real time").
 *
 * After a pause in typing rather than on every key, and only for a search
 * narrow enough to be worth framing. Framing counts as the reader moving the
 * map: following a selected technician pauses -- Re-center takes it back --
 * rather than their next position report pulling the view away from what was
 * being looked for.
 */
function SearchFramer({
  hudShown,
  ids,
  onFramed,
  properties,
}: {
  /**
   * The technician panel is along the bottom, with Re-center above it: frame
   * the matches clear of both, or the nearest ones land underneath them.
   */
  hudShown: boolean;
  ids: ReadonlySet<string> | null;
  onFramed: () => void;
  properties: readonly PropertyPosition[];
}) {
  const { current: map } = useMap();
  const key = ids?.size ? [...ids].sort().join('|') : '';
  // Read, not depended on: the list refetches without anybody searching.
  const latest = useRef(properties);
  latest.current = properties;

  useEffect(() => {
    if (!map || !key) return;
    const timer = window.setTimeout(() => {
      const wanted = new Set(key.split('|'));
      const points = latest.current
        .filter((property) => wanted.has(property.id))
        .map((property) => [property.latitude, property.longitude] as [number, number]);
      if (!points.length || points.length > MAX_FRAMED_MATCHES) return;
      fitTo(map, points, { top: 70, left: 60, right: 70, bottom: hudShown ? 230 : 90 });
      onFramed();
    }, 350);
    return () => window.clearTimeout(timer);
  }, [hudShown, key, map, onFramed]);

  return null;
}

/** Stable empties, so a map handed nothing does not redraw its lines every render. */
const NO_COLORS: ReadonlyMap<string, string> = new Map();
const NO_TRAILS: readonly TechnicianTrail[] = [];
const NO_ROUTES: readonly TechnicianRoute[] = [];

export function TechnicianMap({
  colors = NO_COLORS,
  crewRoutes = NO_ROUTES,
  currentInspectionIds = null,
  highlightedBuildingIds = null,
  live = true,
  onSelectTechnician,
  positions,
  properties = [],
  route = null,
  selectedPropertyId = null,
  selectedTechnicianId = null,
  trails = NO_TRAILS,
  visits = null,
  searchedPropertyIds = null,
  followRequest = 0,
  onFocusTechnician,
  controls,
}: {
  /** Buttons for the map's top-left corner, beside its settings (see `ConsoleMap`). */
  controls?: ReactNode;
  /**
   * Goes up each time the page asks for the selected technician again, from
   * wherever the map is ("See Moses's location"). The map focuses them,
   * follows them, and drops any property it was showing.
   */
  followRequest?: number;
  /**
   * Back to a technician without touching the page's selection otherwise --
   * their own marker clicked while one of their stops is shown. The page
   * clears the stop; without it, the marker re-centres on the stop.
   */
  onFocusTechnician?: (technicianId: string) => void;
  /** What a search on the page is showing: ringed on the map, and framed. See `PortfolioOptions.searched`. */
  searchedPropertyIds?: ReadonlySet<string> | null;
  /** Each technician's colour, for their lines and the ring on their marker. */
  colors?: ReadonlyMap<string, string>;
  /** Everybody's planned drive for the day, dashed. The selected one's is `route`. */
  crewRoutes?: readonly TechnicianRoute[];
  /** The selected technician's visit under way, by their location trail. */
  currentInspectionIds?: readonly string[] | null;
  highlightedBuildingIds?: ReadonlySet<string> | null;
  /** The day shown is today: the live positions carry the lines on. */
  live?: boolean;
  /** A technician's marker was clicked: select them, which follows them. */
  onSelectTechnician?: (technicianId: string) => void;
  positions: readonly TechnicianPosition[];
  properties?: readonly PropertyPosition[];
  /** The selected technician's drive, when one has been worked out. */
  route?: TechnicianRoute | null;
  /** A property picked from the list, which the map flies to. */
  selectedPropertyId?: string | null;
  selectedTechnicianId?: string | null;
  /** Where each technician actually went that day. */
  trails?: readonly TechnicianTrail[];
  /** The day's inspections by property: a tick on each disc whose are all in, and links in its window. */
  visits?: ReadonlyMap<string, readonly PropertyVisit[]> | null;
}) {
  /**
   * The map follows the console, not the operating system.
   *
   * `resolvedTheme` rather than `theme`, because `theme` can be the string
   * `system` and the map needs an answer. A light map inside a dark console was
   * the brightest thing on the screen by a wide margin — and this console is
   * read at night, from Manila, by people looking at a Texas afternoon.
   */
  // Fit to everything, technicians and properties alike, rather than centring
  // on a fixed point: this office works one metropolitan area today, but a
  // hard-coded centre is the kind of thing that silently stops making sense
  // when a second one is added.
  //
  // Not simply everything. A handset reporting from another continent — a test
  // device, a phone that travelled — would otherwise drag the view out to a
  // world map on which neither it nor the properties could be read. The
  // properties anchor the frame; an outlier is still drawn, it just does not
  // get to decide the zoom.
  const points = useMemo(() => pointsToFit(properties, positions), [positions, properties]);

  const selectedPosition = useMemo(
    () => positions.find((position) => position.technicianId === selectedTechnicianId) ?? null,
    [positions, selectedTechnicianId],
  );

  // Where the selected technician's work is, for the case where they have no
  // position to fly to yet.
  const selectedStops = useMemo<[number, number][]>(
    () =>
      highlightedBuildingIds
        ? properties
            .filter((property) => highlightedBuildingIds.has(property.id))
            .map((property) => [property.latitude, property.longitude])
        : [],
    [highlightedBuildingIds, properties],
  );

  // Who is on the map, not where they are. Keyed on `technicianId` rather than
  // the position row's own id, which is a new row for every fix and would make
  // this change as often as the coordinates do.
  const fitKey = useMemo(
    () =>
      [
        ...positions.map((position) => position.technicianId).sort(),
        ...properties.map((property) => property.id).sort(),
      ].join('|'),
    [positions, properties],
  );

  /** Every technician's last few minutes of fixes, for how they are moving. */
  const tracks = useMotionTracks(positions);

  /**
   * What the camera is about, and whether the reader has taken it.
   *
   * The most recent pick wins: a technician, or a property -- including a stop
   * picked inside the selected technician's day, which moves the map to that
   * address while the technician stays selected. Letting go of the property
   * goes back to following the technician.
   */
  const [focus, setFocus] = useState<CameraFocus>({ kind: 'OVERVIEW' });
  const [readerMoved, setReaderMoved] = useState(false);
  const [recenterRequest, setRecenterRequest] = useState(0);

  useEffect(() => {
    if (selectedTechnicianId) {
      setFocus({ kind: 'TECHNICIAN', technicianId: selectedTechnicianId });
      setReaderMoved(false);
    } else {
      setFocus(
        selectedPropertyId
          ? { kind: 'PROPERTY', propertyId: selectedPropertyId }
          : { kind: 'OVERVIEW' },
      );
    }
    // Runs for the technician pick; the property is read, not depended on.
  }, [selectedTechnicianId]);

  useEffect(() => {
    if (selectedPropertyId) {
      setFocus({ kind: 'PROPERTY', propertyId: selectedPropertyId });
      setReaderMoved(false);
    } else if (selectedTechnicianId) {
      setFocus({ kind: 'TECHNICIAN', technicianId: selectedTechnicianId });
      setReaderMoved(false);
    } else {
      setFocus({ kind: 'OVERVIEW' });
    }
    // As above, the other way round.
  }, [selectedPropertyId]);

  const readerMovedTheMap = useCallback(() => setReaderMoved(true), []);
  const recenter = useCallback(() => {
    setReaderMoved(false);
    setRecenterRequest((count) => count + 1);
  }, []);

  /**
   * A marker click picks that technician -- and on the one already picked,
   * re-centres on them, rather than letting go of the person being watched.
   */
  const selectFromMap = useCallback(
    (technicianId: string) => {
      if (technicianId !== selectedTechnicianId) onSelectTechnician?.(technicianId);
      // Clicking the person the map is about, while it is showing one of
      // their stops: back to them. Re-centring would have centred on the stop
      // again -- the camera's subject was the property -- which is how the
      // office ended up with no way back to Moses but collapsing his list.
      else if (focus.kind === 'PROPERTY' && onFocusTechnician) onFocusTechnician(technicianId);
      else recenter();
    },
    [focus.kind, onFocusTechnician, onSelectTechnician, recenter, selectedTechnicianId],
  );

  /**
   * The page asking for the selected technician again -- "See Moses's
   * location". Acted on each time the count goes up, so pressing it after
   * panning away still brings them back; never on mount, which is 0.
   */
  useEffect(() => {
    if (!followRequest || !selectedTechnicianId) return;
    setFocus({ kind: 'TECHNICIAN', technicianId: selectedTechnicianId });
    recenter();
    // On the request alone: the technician is read, not depended on.
  }, [followRequest]);

  // The first stop still ahead of them, by the same rule the route layer uses
  // to colour its next stop.
  const nextStop = useMemo(() => {
    if (!route?.geometry.length) return null;
    const current = new Set(currentInspectionIds ?? []);
    const index = route.stops.findIndex((stop) => !current.has(stop.inspectionId));
    const stop = route.stops[index];
    if (!stop) return null;
    return { name: stop.propertyName, driveSeconds: route.legs[index]?.durationSeconds ?? null };
  }, [currentInspectionIds, route]);

  const recenterSubject =
    focus.kind === 'TECHNICIAN'
      ? (selectedPosition?.technician?.displayName ?? 'the technician')
      : focus.kind === 'PROPERTY'
        ? 'the property'
        : 'everyone';

  // Whether the selected person's real path is on the map, which retires the
  // routed guess at it -- see `RouteLayer`'s `drawDriven`.
  const selectedHasTrail = trails.some(
    (trail) => trail.technicianId === selectedTechnicianId && trail.segments.length > 0,
  );

  return (
    <ConsoleMap
      controls={controls}
      // The same portfolio and the same crew every other map in the console
      // draws: this page hands over its own lists, filtered by its roster, and
      // says who and what is picked.
      crew={{ colors, onSelect: selectFromMap, positions, selectedTechnicianId, tracks }}
      initialView={FALLBACK_VIEW}
      portfolio={{
        highlighted: highlightedBuildingIds,
        properties,
        searched: searchedPropertyIds,
        selectedPropertyId,
        visits,
      }}
    >
      <SearchFramer
        hudShown={Boolean(selectedPosition)}
        ids={searchedPropertyIds}
        onFramed={readerMovedTheMap}
        properties={properties}
      />
      <CameraDirector
        fallback={selectedStops}
        fitKey={fitKey}
        focus={focus}
        followed={selectedPosition}
        onReaderMoved={readerMovedTheMap}
        points={points}
        properties={properties}
        readerMoved={readerMoved}
        recenterRequest={recenterRequest}
      />

      {/* The shared map has drawn the portfolio beneath these and draws the
          crew above them. Markers are real elements above the canvas, so
          every pin sits above every layer regardless.

          Lines bottom to top: the plans, then where people actually went,
          then the selected technician's route -- the one being read. */}
      <CrewRoutesLayer
        colors={colors}
        live={live}
        positions={positions}
        routes={crewRoutes}
        selectedTechnicianId={selectedTechnicianId}
      />
      <TrailLayer
        colors={colors}
        live={live}
        positions={positions}
        selectedTechnicianId={selectedTechnicianId}
        trails={trails}
      />
      <RouteLayer
        currentInspectionIds={currentInspectionIds}
        drawDriven={!selectedHasTrail}
        position={selectedPosition}
        route={route}
      />
      <AirTravelLayer route={route} />

      {/* Inside the map rather than over it, so they stay on screen in
          fullscreen. Lifted clear of the bottom edge, which belongs to
          Mapbox's logo and attribution -- both of which have to stay
          readable.

          One column, Re-center above the technician panel: side by side they
          overlapped as soon as the map was narrower than both, which beside
          the sidebar it always is -- "Following" was half under the panel.
          The column passes the pointer through its empty space, so the map
          under it still drags. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex flex-col items-end">
        <div {...{ [MAP_OVERLAY_ATTRIBUTE]: '' }} className="pointer-events-auto">
          <RecenterControl
            following={focus.kind === 'TECHNICIAN' && Boolean(selectedPosition)}
            onRecenter={recenter}
            readerMoved={readerMoved}
            subject={recenterSubject}
          />
        </div>
        {selectedPosition ? (
          <div
            {...{ [MAP_OVERLAY_ATTRIBUTE]: '' }}
            className="pointer-events-auto max-w-full self-center"
          >
            <TechnicianHud
              nextStop={nextStop}
              position={selectedPosition}
              track={tracks.get(selectedPosition.technicianId) ?? []}
            />
          </div>
        ) : null}
      </div>
    </ConsoleMap>
  );
}
