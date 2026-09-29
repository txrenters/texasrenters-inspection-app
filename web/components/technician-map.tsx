'use client';

import 'mapbox-gl/dist/mapbox-gl.css';

import type {
  PropertyPosition,
  TechnicianPosition,
  TechnicianRoute,
} from '@texasrenters/shared';
import { splitRouteAtPosition } from '@texasrenters/shared';
import { Fragment, memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Layer, Marker, Popup, Source, type LayerProps } from 'react-map-gl/mapbox';

import { CameraDirector, MAP_OVERLAY_ATTRIBUTE, type CameraFocus } from '@/components/map-camera';
import { pointsToFit } from '@/components/map-bounds';
import { ConsoleMap } from '@/components/console-map';
import { useMapStroke } from '@/components/map-colors';
import { featureCollection, lineFeature } from '@/components/map-geometry';
import { RecenterControl, TechnicianHud } from '@/components/technician-hud';
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
  position,
  route,
}: {
  /** The visit under way, from the location trail, so its stop can say so. */
  currentInspectionIds: readonly string[] | null;
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
      ...(history.length > 1
        ? [
            lineFeature(history, { kind: 'casing', w: 7, o: 0.6 }),
            lineFeature(history, { kind: 'line', tone: 'done', w: 4, o: 0.95 }),
          ]
        : []),
      // The part of this route already driven, in the same grey as the drives
      // between finished stops -- so the line is continuous and only its colour
      // says which side of the technician it is on.
      ...(split.travelled.length > 1
        ? [lineFeature(split.travelled, { kind: 'line', tone: 'done', w: 4, o: 0.9 })]
        : []),
      ...(split.ahead.length > 1
        ? [
            lineFeature(split.ahead, { kind: 'casing', w: 9, o: 0.9 }),
            lineFeature(split.ahead, { kind: 'line', tone: 'ahead', w: 4, o: 1 }),
          ]
        : []),
    ]);
  }, [route, split]);

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
              <div className="text-popover-foreground text-xs leading-relaxed">
                <div className="text-sm font-medium">{stop.propertyName}</div>
                <div className="text-muted-foreground">
                  {stop.addressLine1}
                  {stop.city ? `, ${stop.city}` : null}
                </div>
                <div className="mt-1">Done</div>
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

export function TechnicianMap({
  currentInspectionIds = null,
  highlightedBuildingIds = null,
  onSelectTechnician,
  positions,
  properties = [],
  route = null,
  selectedPropertyId = null,
  selectedTechnicianId = null,
}: {
  /** The selected technician's visit under way, by their location trail. */
  currentInspectionIds?: readonly string[] | null;
  highlightedBuildingIds?: ReadonlySet<string> | null;
  /** A technician's marker was clicked: select them, which follows them. */
  onSelectTechnician?: (technicianId: string) => void;
  positions: readonly TechnicianPosition[];
  properties?: readonly PropertyPosition[];
  /** The selected technician's drive, when one has been worked out. */
  route?: TechnicianRoute | null;
  /** A property picked from the list, which the map flies to. */
  selectedPropertyId?: string | null;
  selectedTechnicianId?: string | null;
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
      if (technicianId === selectedTechnicianId) recenter();
      else onSelectTechnician?.(technicianId);
    },
    [onSelectTechnician, recenter, selectedTechnicianId],
  );

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

  return (
    <ConsoleMap
      // The same portfolio and the same crew every other map in the console
      // draws: this page hands over its own lists, filtered by its roster, and
      // says who and what is picked.
      crew={{ onSelect: selectFromMap, positions, selectedTechnicianId, tracks }}
      initialView={FALLBACK_VIEW}
      portfolio={{ highlighted: highlightedBuildingIds, properties, selectedPropertyId }}
    >
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
          every pin sits above every layer regardless. */}
      <RouteLayer
        currentInspectionIds={currentInspectionIds}
        position={selectedPosition}
        route={route}
      />
      <AirTravelLayer route={route} />

      {/* Inside the map rather than over it, so they stay on screen in
          fullscreen. Lifted clear of the bottom edge, which belongs to
          Mapbox's logo and attribution -- both of which have to stay
          readable. */}
      <div {...{ [MAP_OVERLAY_ATTRIBUTE]: '' }} className="absolute right-0 bottom-6 z-10">
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
          className="absolute bottom-6 left-1/2 z-10 -translate-x-1/2"
        >
          <TechnicianHud
            nextStop={nextStop}
            position={selectedPosition}
            track={tracks.get(selectedPosition.technicianId) ?? []}
          />
        </div>
      ) : null}
    </ConsoleMap>
  );
}
