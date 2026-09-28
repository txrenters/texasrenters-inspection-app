'use client';

import 'mapbox-gl/dist/mapbox-gl.css';

import type {
  PropertyPosition,
  TechnicianPosition,
  TechnicianRoute,
} from '@texasrenters/shared';
import { ONLINE_WITHIN_MS, splitRouteAtPosition } from '@texasrenters/shared';
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layer, Marker, Popup, Source, useMap, type LayerProps } from 'react-map-gl/mapbox';

import { CameraDirector, MAP_OVERLAY_ATTRIBUTE, type CameraFocus } from '@/components/map-camera';
import { pointsToFit } from '@/components/map-bounds';
import { ConsoleMap } from '@/components/console-map';
import { useMapStroke } from '@/components/map-colors';
import { circleFeature, featureCollection, lineFeature } from '@/components/map-geometry';
import { RecenterControl, TechnicianHud } from '@/components/technician-hud';
import { Badge } from '@/components/ui/badge';
import { greatCirclePath, pathMidpoint } from '@/lib/great-circle';
import {
  clusterByGrid,
  inBox,
  padBox,
  ringIsLegible,
  zoomToIsolate,
  type Box,
} from '@/components/map-clusters';
import { formatDistance, formatDuration } from '@/lib/format';
import { useGlide } from '@/lib/map-animation';
import { drawsAsDriving, motionOf, type Motion } from '@/lib/technician-motion';
import { useMotionTracks } from '@/lib/use-motion-tracks';
import {
  ClusterPin,
  DonePin,
  DrivingPin,
  PlanePin,
  PropertyPin,
  StopPin,
  TechnicianPin,
} from '@/components/map-pins';

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

/** Past this, a position is history rather than an answer to "where are they". */
/**
 * Kept as a re-export so this file reads the same as it did, but the number
 * now lives in `shared` -- the roster list asks the same question, and two
 * thresholds would let the list say online while the pin said otherwise.
 */
const STALE_AFTER_MS = ONLINE_WITHIN_MS;

/**
 * The view the map opens with, before any data has arrived.
 *
 * Mapbox will render an unpositioned map at zoom 0 over the Atlantic rather
 * than refusing, which is quieter than Google's nothing-at-all and no more
 * useful. Texas, far enough out to hold the whole state.
 */
const FALLBACK_VIEW = { longitude: -99.0, latitude: 31.0, zoom: 5 };

/**
 * How far past the edge of the map markers are still drawn, as a share of the
 * view's size on each side -- so a short pan does not uncover an empty strip
 * that fills in only when the map settles.
 */
const DRAWN_BEYOND_VIEW = 0.5;

/**
 * The zoom and the visible area, as state, as of the last time the map settled.
 *
 * Grouping is worked out in projected pixels at the current zoom, so it changes
 * when the zoom does and never when panning — a clustering that reshuffled as
 * you dragged would read as the data itself moving. The visible area decides
 * which of those groups are drawn at all.
 */
function useSettledView() {
  const { current: map } = useMap();
  const [view, setView] = useState<{ zoom: number; box: Box | null }>({
    zoom: FALLBACK_VIEW.zoom,
    box: null,
  });

  useEffect(() => {
    if (!map) return;
    const sync = () =>
      setView((current) => {
        const zoom = map.getZoom() ?? current.zoom;
        const bounds = map.getBounds();
        const box = bounds
          ? {
              north: bounds.getNorth(),
              south: bounds.getSouth(),
              east: bounds.getEast(),
              west: bounds.getWest(),
            }
          : current.box;
        // The same view handed back, so a settle that changed nothing costs no
        // render at all.
        const unchanged =
          zoom === current.zoom &&
          box?.north === current.box?.north &&
          box?.south === current.box?.south &&
          box?.east === current.box?.east &&
          box?.west === current.box?.west;
        return unchanged ? current : { zoom, box };
      });
    sync();
    /**
     * `idle`, not `zoom` or `move`.
     *
     * Those fire on every frame of a scroll, pinch or drag, and each one
     * re-grouped the properties and reconciled every marker — mid-gesture,
     * several times a second. `idle` fires once, when the map has settled and
     * finished drawing, so the work happens exactly as often as the answer
     * actually changes.
     */
    map.on('idle', sync);
    return () => {
      map.off('idle', sync);
    };
  }, [map]);

  return view;
}

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

/**
 * The claimed accuracy, drawn to scale.
 *
 * A 5m fix and a 300m fix are very different statements, and a map that drew
 * them as the same dot would be asserting something nobody knows.
 *
 * One source for everybody reporting a vague fix, rather than one each: this
 * re-renders on every socket frame, and a source per technician is a source
 * added and removed on the map several times a second.
 */
const AccuracyLayer = memo(function AccuracyLayer({
  positions,
}: {
  positions: readonly TechnicianPosition[];
}) {
  const data = useMemo(
    () =>
      featureCollection(
        positions
          .filter((position) => position.accuracyMeters && position.accuracyMeters > 25)
          .map((position) =>
            circleFeature(position.latitude, position.longitude, position.accuracyMeters!),
          ),
      ),
    [positions],
  );

  if (!data.features.length) return null;

  return (
    <Source data={data} id="accuracy" type="geojson">
      <Layer
        id="accuracy-fill"
        paint={{ 'fill-color': '#6b7280', 'fill-opacity': 0.1, 'fill-outline-color': '#6b7280' }}
        type="fill"
      />
    </Source>
  );
});

/** One property's two radii, as the geofence layer needs them. */
interface GeofenceRing {
  id: string;
  latitude: number;
  longitude: number;
  enterRadiusMeters: number;
  exitRadiusMeters: number;
  dim: boolean;
}

/**
 * How close a technician has to be before the time counts as on site.
 *
 * Drawn because this is the number the hours are computed from, and until now
 * it existed only as a column. An office deciding whether a technician was
 * really at a property is reading a radius they cannot see against a building
 * they can — and a replay over 37 real jobs showed the geometry is not the
 * hard part, coverage is. Two circles, because the rule has two numbers: the
 * inner one is the distance that starts the clock, the outer one the distance
 * that has to be crossed before it stops. That gap is deliberate — it is what
 * keeps a technician standing still at the edge of a driveway from being
 * clocked in and out every time a fix wobbles — and drawing only one of them
 * would show a boundary the software does not actually have.
 *
 * Every ring in one source, painted from each shape's own properties. A source
 * per property meant a source added and torn down on every pan, for a shape
 * that is only drawn when somebody is already zoomed in close enough to read
 * it.
 */
const GeofenceLayer = memo(function GeofenceLayer({ rings }: { rings: readonly GeofenceRing[] }) {
  const orange = useMapStroke('map-geofence-ring');
  const data = useMemo(
    () =>
      featureCollection(
        rings.flatMap((ring) => [
          circleFeature(ring.latitude, ring.longitude, ring.enterRadiusMeters, {
            kind: 'enter',
            dim: ring.dim ? 1 : 0,
          }),
          circleFeature(ring.latitude, ring.longitude, ring.exitRadiusMeters, {
            kind: 'exit',
            dim: ring.dim ? 1 : 0,
          }),
        ]),
      ),
    [rings],
  );

  if (!rings.length) return null;

  return (
    <Source data={data} id="geofence" type="geojson">
      {/* The inner circle only. Filling both would read as one solid blob whose
          edge is the outer number, which is the opposite of what the gap
          means. */}
      <Layer
        filter={['==', ['get', 'kind'], 'enter']}
        id="geofence-fill"
        paint={{
          'fill-color': orange,
          'fill-opacity': ['case', ['==', ['get', 'dim'], 1], 0.04, 0.12],
        }}
        type="fill"
      />
      <Layer
        id="geofence-outline"
        paint={{
          'line-color': orange,
          'line-width': ['case', ['==', ['get', 'kind'], 'enter'], 2, 1],
          'line-opacity': [
            'case',
            ['all', ['==', ['get', 'kind'], 'enter'], ['==', ['get', 'dim'], 0]],
            0.85,
            ['all', ['==', ['get', 'kind'], 'enter'], ['==', ['get', 'dim'], 1]],
            0.3,
            ['==', ['get', 'dim'], 1],
            0.15,
            0.4,
          ],
        }}
        type="line"
      />
    </Source>
  );
});

/**
 * Every property, grouped when the pins would overlap.
 *
 * Clustered because this is a portfolio of hundreds: drawn individually at
 * metropolitan zoom they merge into a green smear that reports neither where
 * the work is nor how much of it there is. Three Houston properties within 250m
 * already drew as one pin while the legend said three.
 *
 * **Only properties cluster.** Technicians are the thing being watched, and
 * folding two of them into a badge would hide exactly what somebody opened the
 * map to see.
 *
 * Memoised, and that is the single biggest thing on this map. Technician
 * positions arrive over the socket every few seconds, re-rendering this page
 * and everything under it. Without this, each of those frames reconciled ~40
 * cluster markers whose props had not changed — every one a real DOM element
 * the map repositions itself. None of this layer's props move when a
 * technician does.
 */
const PropertyLayer = memo(function PropertyLayer({
  highlighted,
  properties,
  selectedPropertyId,
}: {
  /**
   * The selected technician's buildings, or null when nobody is selected.
   *
   * Null rather than an empty set, because the two mean opposite things: null
   * is "show everything at full strength", empty is "this person has no mapped
   * stops", and drawing those the same way would make a technician with no work
   * look like no selection at all.
   */
  highlighted: ReadonlySet<string> | null;
  properties: readonly PropertyPosition[];
  /** Picked from the list, so its own window opens without a second click. */
  selectedPropertyId: string | null;
}) {
  const { current: map } = useMap();
  const { zoom, box } = useSettledView();
  const [openKey, setOpenKey] = useState<string | null>(null);
  /** The selection this layer last acted on, so churn is not mistaken for a change. */
  const lastSelected = useRef<string | null>(selectedPropertyId);

  const clusters = useMemo(() => clusterByGrid(properties, zoom), [properties, zoom]);

  /**
   * Only the groups on or near the screen are drawn.
   *
   * Every property used to be a marker all the time. At street level that is
   * every one of them standing alone -- 586 in production -- nearly all of them
   * miles off-screen, each a real element the map repositions on every frame of
   * a zoom. Scrolling the map in and out stuttered and froze for up to a
   * second. The grouping itself is unchanged: it is still worked out from the
   * zoom alone, so panning never reshuffles a badge.
   *
   * Until the map first reports where it is looking, everything is drawn --
   * which costs nothing, because the zoom used for grouping is still the
   * opening, country-wide one, where the whole portfolio is a handful of
   * badges. The open window's group stays drawn even when panned out of view,
   * so it does not close under the reader.
   */
  const drawn = useMemo(() => {
    if (!box) return clusters;
    const reach = padBox(box, DRAWN_BEYOND_VIEW);
    return clusters.filter((cluster) => cluster.key === openKey || inBox(cluster, reach));
  }, [box, clusters, openKey]);

  /**
   * The rings worth drawing: a property standing alone, and only once it is big
   * enough on screen to be a size rather than a smudge.
   *
   * A badge's coordinate is the average of what it holds, so a circle drawn
   * there would be centred on nobody's building.
   */
  const rings = useMemo<GeofenceRing[]>(
    () =>
      drawn.flatMap((cluster) => {
        const single = cluster.members.length === 1 ? cluster.members[0] : null;
        if (!single || !ringIsLegible(single.enterRadiusMeters, single.latitude, zoom)) return [];
        return [
          {
            id: single.id,
            latitude: single.latitude,
            longitude: single.longitude,
            enterRadiusMeters: single.enterRadiusMeters,
            exitRadiusMeters: single.exitRadiusMeters,
            dim: Boolean(highlighted && !highlighted.has(single.id)),
          },
        ];
      }),
    [drawn, highlighted, zoom],
  );

  /**
   * Opens the selected property's window once it is actually drawn.
   *
   * Depends on `clusters` as well as the selection, and that is the whole
   * trick: selecting flies the map in, the zoom change regroups the clusters,
   * and only then does the property stop being folded into a badge and get a
   * marker of its own. Running on the selection alone would fire while it was
   * still inside a cluster and find nothing to open.
   *
   * Falls back to the badge it is hiding in rather than opening nothing —
   * reached when no zoom separates them, which is two records at identical
   * coordinates. "It is here, with another" beats a click that looks lost.
   */
  useEffect(() => {
    const letGo = selectedPropertyId === null;
    const changed = selectedPropertyId !== lastSelected.current;
    lastSelected.current = selectedPropertyId;

    /**
     * **A window opened by clicking is not this effect's to close.**
     *
     * This ran on `clusters` as well as the selection and closed the window
     * whenever nothing was selected -- so a click on a pin opened its details
     * and the next refetch, which rebuilds the property list and with it the
     * clusters, closed them again. On the technician map that is every few
     * seconds, and the window was gone before it could be read. Reported as
     * markers that cannot be clicked at all, because that is what it looked
     * like.
     *
     * Only *letting go* of a selected property closes its window now; the
     * clusters changing underneath an open one leaves it alone.
     */
    if (letGo) {
      if (changed) setOpenKey(null);
      return;
    }

    const own = clusters.find(
      (cluster) => cluster.members.length === 1 && cluster.members[0].id === selectedPropertyId,
    );
    const group = clusters.find((cluster) =>
      cluster.members.some((member) => member.id === selectedPropertyId),
    );
    setOpenKey(own?.key ?? group?.key ?? null);
  }, [clusters, selectedPropertyId]);

  return (
    <>
      <GeofenceLayer rings={rings} />

      {drawn.map((cluster) => {
        const single = cluster.members.length === 1 ? cluster.members[0] : null;
        // Everything recedes rather than disappearing when somebody is
        // selected: a dispatcher looking at one technician still needs to see
        // what is near them.
        const dim = Boolean(
          highlighted && !cluster.members.some((member) => highlighted.has(member.id)),
        );

        return (
          <Fragment key={cluster.key}>
            <Marker
              anchor="bottom"
              latitude={cluster.latitude}
              longitude={cluster.longitude}
              onClick={(event) => {
                event.originalEvent.stopPropagation();
                if (single) {
                  setOpenKey(cluster.key);
                  return;
                }
                // A badge is a request to see inside it, not a thing to read.
                // Zoom until its members separate rather than opening a window
                // that can only say "several".
                const target = zoomToIsolate(cluster.members, cluster.members[0].id, zoom, 21);
                map?.easeTo({ center: [cluster.longitude, cluster.latitude], zoom: target });
              }}
              style={{ zIndex: single ? 100 : 90 }}
            >
              <span title={single ? single.name : `${cluster.members.length} properties`}>
                {single ? (
                  <PropertyPin dim={dim} />
                ) : (
                  <ClusterPin count={cluster.members.length} dim={dim} />
                )}
              </span>
            </Marker>

            {openKey === cluster.key ? (
              <Popup
                anchor="bottom"
                closeOnClick={false}
                latitude={cluster.latitude}
                longitude={cluster.longitude}
                offset={34}
                onClose={() => setOpenKey(null)}
              >
                {single ? (
                  <>
                    <span className="font-medium">{single.name}</span>
                    {/* Said on the pin as well as in the list, because a reader
                     * who arrived by clicking the map never saw the list. The
                     * address is fictional and sits in the middle of the service
                     * area, so an unmarked pin is one somebody routes to. */}
                    {single.isDemo ? (
                      <>
                        {' '}
                        <Badge variant="warning">Demo</Badge>
                      </>
                    ) : null}
                    <br />
                    {single.addressLine1}
                    {single.city ? `, ${single.city}` : null}
                    <br />
                    {/* The number the hours come from, in words, beside the
                     * circle drawing it. Saying the centre was moved matters
                     * as much as the radius: a ring sitting off the building
                     * is a correction somebody made, not a geocoder's mistake,
                     * and without this line it reads as a bug. */}
                    <span className="text-muted-foreground text-xs">
                      On site within {single.enterRadiusMeters}m
                      {single.geofenceMoved ? ' · centre set by the office' : null}
                    </span>
                  </>
                ) : (
                  <span className="font-medium">{cluster.members.length} properties here</span>
                )}
              </Popup>
            ) : null}
          </Fragment>
        );
      })}
    </>
  );
});

/**
 * One technician on the map: where they are, and how they are moving.
 *
 * The arrow while they are driving, the person badge otherwise. Slides from fix
 * to fix instead of jumping, so a drive reads as a drive.
 *
 * Anchored at its centre: the coordinate is the middle of the badge or the
 * arrow, which is also where the accuracy ring is drawn from. Everything else
 * on this map is anchored at its bottom edge, because everything else is a pin
 * with a point.
 */
const TechnicianMarker = memo(function TechnicianMarker({
  dim,
  motion,
  onSelect,
  position,
  selected,
}: {
  dim: boolean;
  motion: Motion | null;
  onSelect: (technicianId: string) => void;
  position: TechnicianPosition;
  selected: boolean;
}) {
  const at = useGlide(position.latitude, position.longitude);
  const stale = Date.now() - Date.parse(position.recordedAt) > STALE_AFTER_MS;
  // A stale fix's course is the direction they were travelling whenever it was
  // taken, which may be hours ago. `motion.live` already refuses anything over
  // a few minutes; `stale` is the half-hour line the rest of the map uses.
  const driving = !stale && drawsAsDriving(motion);

  return (
    <Marker
      anchor="center"
      latitude={at.lat}
      longitude={at.lng}
      onClick={(event) => {
        event.originalEvent.stopPropagation();
        onSelect(position.technicianId);
      }}
      style={{ zIndex: selected ? 520 : 500 }}
    >
      <span title={position.technician?.displayName ?? 'Unknown technician'}>
        {driving && motion ? (
          <DrivingPin
            dim={dim}
            heading={motion.headingDegrees ?? 0}
            stopped={motion.state === 'STOPPED'}
          />
        ) : (
          <TechnicianPin
            dim={dim}
            heading={
              !stale && motion?.live && motion.state === 'ON_FOOT' ? motion.headingDegrees : null
            }
            stale={stale}
          />
        )}
      </span>
    </Marker>
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

  const now = Date.now();

  return (
    <ConsoleMap initialView={FALLBACK_VIEW} radiusPoints={properties}>
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

      {/* Layer order is mount order, and the shared map has already drawn the
          grouping circles beneath everything here. Markers are real elements
          above the canvas, so every pin sits above every layer regardless. */}
      <PropertyLayer
        highlighted={highlightedBuildingIds}
        properties={properties}
        selectedPropertyId={selectedPropertyId}
      />

      <RouteLayer
        currentInspectionIds={currentInspectionIds}
        position={selectedPosition}
        route={route}
      />
      <AirTravelLayer route={route} />
      <AccuracyLayer positions={positions} />

      {positions.map((position) => (
        // Keyed on the technician, not the fix. The fix's id is new on every
        // report, which remounted the marker each time -- so there was nothing
        // to slide, only a marker destroyed and drawn again.
        <TechnicianMarker
          dim={Boolean(selectedTechnicianId) && position.technicianId !== selectedTechnicianId}
          key={position.technicianId}
          motion={motionOf(tracks.get(position.technicianId) ?? [], now)}
          onSelect={selectFromMap}
          position={position}
          selected={position.technicianId === selectedTechnicianId}
        />
      ))}

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
