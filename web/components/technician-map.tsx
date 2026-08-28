'use client';

import 'leaflet/dist/leaflet.css';

import type {
  PropertyPosition,
  TechnicianPosition,
  TechnicianRoute,
} from '@texasrenters/shared';
import { divIcon, type LatLngBoundsExpression } from 'leaflet';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  Circle,
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet';

import { pointsToFit } from '@/components/map-bounds';
import { greatCirclePath, pathMidpoint } from '@/lib/great-circle';
import { clusterByGrid } from '@/components/map-clusters';
import { formatRelative } from '@/lib/format';

/**
 * Where every technician was when their handset last reported, over the
 * properties they are working.
 *
 * Leaflet rather than Google or Mapbox: pins on a street map need no routing,
 * no satellite imagery and no billing relationship, and the tile source is a
 * single URL — so moving to a paid provider later is configuration rather than
 * a rewrite.
 *
 * Must be loaded with `ssr: false`. Leaflet touches `window` at import time and
 * measures the container to lay tiles out, neither of which exists on a server.
 */

/**
 * OpenStreetMap only as a default.
 *
 * Their tile policy discourages production commercial traffic, and this is a
 * commercial product. Fine while the console is a handful of administrators;
 * point `NEXT_PUBLIC_MAP_TILE_URL` at a paid provider before it is in daily
 * use. Public by nature — the browser fetches it — but inlined at build time,
 * so changing it needs a rebuild rather than a restart.
 */
const TILE_URL =
  process.env.NEXT_PUBLIC_MAP_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/** Required by OpenStreetMap's licence, and good manners for any tile source. */
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Past this, a position is history rather than an answer to "where are they". */
const STALE_AFTER_MS = 30 * 60_000;

/**
 * Markers drawn as inline SVG rather than Leaflet's own images.
 *
 * Leaflet's default icon resolves its PNGs relative to the stylesheet, which
 * bundlers rewrite and break — the usual symptom is a map with invisible
 * markers. A `divIcon` sidesteps the asset question entirely, and vectors stay
 * sharp on the high-density displays these are actually read on.
 *
 * The two are separated by **shape as well as colour**: a property is the
 * classic teardrop pin planted at a spot, a technician is a round badge with a
 * person in it. Anyone who cannot reliably tell green from red still reads the
 * map correctly, which colour alone would not give them.
 *
 * White outlines on both. These sit on cartography full of green parks, blue
 * water and red arterial roads, and an unoutlined marker disappears into
 * whatever it happens to land on.
 */
const MARKER_SHADOW =
  '<filter id="pin-shadow" x="-40%" y="-40%" width="180%" height="180%">' +
  '<feDropShadow dx="0" dy="1" stdDeviation="1" flood-opacity="0.35"/></filter>';

/**
 * A teardrop pin with a house in it, anchored at its point.
 *
 * `iconAnchor` is the tip rather than the centre — a pin whose point does not
 * touch the coordinate is simply showing the wrong place, and at street zoom
 * the half-height error is most of a block.
 */
function propertyPin(dim = false) {
  return divIcon({
    className: '',
    html: `<svg width="24" height="32" viewBox="0 0 24 32" opacity="${dim ? 0.25 : 1}" xmlns="http://www.w3.org/2000/svg">
      <defs>${MARKER_SHADOW}</defs>
      <path filter="url(#pin-shadow)"
        d="M12 1.5c-5.5 0-10 4.4-10 9.9 0 7.4 10 19.1 10 19.1s10-11.7 10-19.1c0-5.5-4.5-9.9-10-9.9z"
        class="fill-map-property" stroke="#fff" stroke-width="2"/>
      <path d="M12 6.6 6.6 11v6.1h3.6v-3.5h3.6v3.5h3.6V11z" fill="#fff"/>
    </svg>`,
    iconSize: [24, 32],
    iconAnchor: [12, 31],
    popupAnchor: [0, -28],
  });
}

/**
 * A round badge with a person in it, anchored at its centre.
 *
 * Centred rather than pointed, because unlike a property this is a reading of
 * where somebody was, not a marked spot — and the accuracy circle it sits
 * inside is drawn from the same centre.
 */
/**
 * Built once per appearance, then reused.
 *
 * Leaflet replaces a marker's DOM whenever the `icon` prop is a new object, and
 * positions arrive over the socket every few seconds -- so a freshly built icon
 * on every render restarts the pulse animation from zero each time, which reads
 * as a stutter rather than a heartbeat. There are three possible appearances,
 * so caching them is both cheap and the only way the animation survives.
 *
 * Sharing one icon instance across several markers is fine: `divIcon` is a
 * template, and Leaflet builds separate DOM for each marker from it.
 */
const TECHNICIAN_PINS = new Map<string, ReturnType<typeof divIcon>>();

/**
 * A round badge with a person in it, anchored at its centre.
 *
 * The canvas is 44px while the badge is still 22px across: the extra room is
 * for the pulse, which expands past the badge and would otherwise be clipped by
 * the SVG viewport. The badge geometry is unchanged -- it is drawn at its
 * original coordinates inside a translate -- so nothing about the marker's
 * apparent size or anchoring moved.
 */
function technicianPin(stale: boolean, dim = false) {
  const key = `${stale}|${dim}`;
  const cached = TECHNICIAN_PINS.get(key);
  if (cached) return cached;

  const fill = stale ? 'fill-map-technician-stale' : 'fill-map-technician';
  // Only for someone reporting now, and only when they are not dimmed. A stale
  // position is the opposite of live, so animating it would say the wrong
  // thing; a dimmed marker belongs to somebody who was not selected, and a
  // pulse is the loudest thing on the map.
  const live = !stale && !dim;

  const icon = divIcon({
    className: '',
    html: `<svg width="44" height="44" viewBox="0 0 44 44" opacity="${dim ? 0.3 : 1}" xmlns="http://www.w3.org/2000/svg">
      <defs>${MARKER_SHADOW}</defs>
      ${live ? '<circle class="map-technician-pulse fill-map-technician" cx="22" cy="22" r="11"/>' : ''}
      <g transform="translate(8,8)">
        <circle filter="url(#pin-shadow)" cx="14" cy="14" r="11"
          class="${fill}" stroke="#fff" stroke-width="2.5"/>
        <circle cx="14" cy="11.1" r="2.9" fill="#fff"/>
        <path d="M8.1 20.4c0-3.2 2.7-5.2 5.9-5.2s5.9 2 5.9 5.2z" fill="#fff"/>
      </g>
    </svg>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    // Unchanged from the 28px icon: the badge is the same size in the same
    // place, so the popup should sit exactly where it did.
    popupAnchor: [0, -14],
  });

  TECHNICIAN_PINS.set(key, icon);
  return icon;
}

/**
 * A badge standing in for several properties too close to draw separately.
 *
 * Sized by how many it hides, in three coarse steps rather than continuously:
 * the useful signal is "a few" versus "a lot", and a smoothly growing circle
 * just makes every cluster look slightly different from every other one.
 */
function clusterPin(count: number, dim = false) {
  const size = count < 10 ? 30 : count < 50 ? 36 : 42;
  return divIcon({
    className: '',
    html: `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" opacity="${dim ? 0.25 : 1}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 3}"
        class="fill-map-property" opacity="0.35"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 6}"
        class="fill-map-property" stroke="#fff" stroke-width="2"/>
      <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central"
        fill="#fff" font-size="${count < 100 ? 12 : 10}" font-weight="600"
        font-family="system-ui, sans-serif">${count}</text>
    </svg>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/**
 * The view the map opens with, before any data has arrived.
 *
 * **`zoom` is not optional and its absence is not cosmetic.** react-leaflet
 * only sets a view when `center != null && zoom != null`, falling back to
 * `bounds` and otherwise doing nothing at all. A map with no view cannot
 * project, so every layer added to it fails to compute `_point`, and the next
 * `setStyle` dies on `undefined.subtract` — taking the whole page down with a
 * client-side exception rather than merely rendering an empty map.
 *
 * That is reachable here on any cold load: both queries are still pending on
 * first render, so there are no points to fit and `bounds` is undefined. It
 * looked intermittent only because a warm react-query cache supplied bounds
 * before the map was built.
 */
const FALLBACK_CENTER: [number, number] = [31.0, -99.0];
const FALLBACK_ZOOM = 5;

/**
 * One Earth, and only one.
 *
 * Latitude stops at ±85 rather than ±90 because Web Mercator cannot project
 * the poles — they sit at infinity, and asking Leaflet to bound them produces
 * a map that will not settle.
 */
const WORLD_BOUNDS: LatLngBoundsExpression = [
  [-85, -180],
  [85, 180],
];

/**
 * Fits the map to the data once it arrives.
 *
 * `MapContainer`'s own `bounds` prop is read exactly once, when the map is
 * constructed, so it cannot do this: positions that load a moment later would
 * leave the map sitting on its fallback view with every pin off screen.
 *
 * **Keyed on which entities are present, never on where they are.** Positions
 * now arrive over the socket every few seconds, and refitting on coordinates
 * would drag the view back to a computed framing under the hands of whoever is
 * reading the map — the more often technicians moved, the less usable it would
 * become. So the map re-fits when somebody comes on shift or a property loads,
 * and holds still while people drive around.
 */
function FitToData({
  fitKey,
  points,
  suspended,
}: {
  fitKey: string;
  points: [number, number][];
  /**
   * True while somebody is selected from the roster.
   *
   * Without this the two fits fight: a technician coming on shift changes the
   * key, this re-frames the whole patch, and the view somebody deliberately
   * focused is pulled away by a colleague opening their app. A deliberate
   * choice outranks an automatic one.
   */
  suspended: boolean;
}) {
  const map = useMap();

  // Held in a ref so the effect can read current coordinates without listing
  // them as a dependency — they change constantly and must not trigger it.
  const latest = useRef(points);
  latest.current = points;

  useEffect(() => {
    if (suspended || !latest.current.length) return;
    map.fitBounds(latest.current as LatLngBoundsExpression, { padding: [48, 48], maxZoom: 15 });
  }, [map, fitKey, suspended]);

  return null;
}

/**
 * Every property, grouped when the pins would overlap.
 *
 * Clustered because this is a portfolio of hundreds: drawn individually at
 * metropolitan zoom they merge into a green smear that reports neither where
 * the work is nor how much of it there is. Three Houston properties within
 * 250m already drew as one pin while the legend said three.
 *
 * **Only properties cluster.** Technicians are the thing being watched, and
 * folding two of them into a badge would hide exactly what somebody opened the
 * map to see.
 */
function PropertyLayer({
  highlighted,
  properties,
}: {
  /**
   * The selected technician's buildings, or null when nobody is selected.
   *
   * Null rather than an empty set, because the two mean opposite things: null
   * is "show everything at full strength", empty is "this person has no
   * mapped stops", and drawing those the same way would make a technician with
   * no work look like no selection at all.
   */
  highlighted: ReadonlySet<string> | null;
  properties: readonly PropertyPosition[];
}) {
  const map = useMap();
  const [zoom, setZoom] = useState(() => map.getZoom());

  // Grouping is computed in projected pixels at the current zoom, so it changes
  // when the zoom does and never when panning — a clustering that reshuffled as
  // you dragged would read as the data itself moving.
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });

  const clusters = useMemo(
    () => clusterByGrid(map, properties, zoom),
    [map, properties, zoom],
  );

  return (
    <>
      {clusters.map((cluster) => {
        // A cluster stays bright if any of its members belong to the selected
        // technician: dimming it would hide their stop inside a group of
        // somebody else's properties, which is the case selection exists for.
        const dim = highlighted
          ? !cluster.members.some((member) => highlighted.has(member.id))
          : false;

        return cluster.members.length === 1 ? (
          <Marker
            key={cluster.key}
            icon={propertyPin(dim)}
            position={[cluster.latitude, cluster.longitude]}
            zIndexOffset={-500}
          >
            <Popup>
              <span className="font-medium">{cluster.members[0]?.name}</span>
              <br />
              {cluster.members[0]?.addressLine1}
              <br />
              {cluster.members[0]?.city}, {cluster.members[0]?.state}{' '}
              {cluster.members[0]?.postalCode}
              {/* Census geocoding interpolates along a street segment rather
                  than pointing at a roof, so the pin is the right block and
                  approximately the right house. Saying so is cheaper than
                  somebody discovering it while standing in a driveway. */}
              <br />
              <span className="text-muted-foreground text-xs">Approximate location</span>
            </Popup>
          </Marker>
        ) : (
          <Marker
            key={cluster.key}
            icon={clusterPin(cluster.members.length, dim)}
            position={[cluster.latitude, cluster.longitude]}
            zIndexOffset={-500}
            eventHandlers={{
              // Zoom to the members rather than stepping in by a fixed amount:
              // a cluster of three neighbours and a cluster spanning a county
              // need very different zooms to come apart.
              click: () =>
                map.fitBounds(
                  cluster.members.map(
                    (member) => [member.latitude, member.longitude] as [number, number],
                  ),
                  { padding: [64, 64], maxZoom: 17 },
                ),
            }}
          >
            <Popup>
              <span className="font-medium">{cluster.members.length} properties here</span>
              <br />
              <span className="text-muted-foreground text-xs">
                Click the cluster to zoom in.
              </span>
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}

/**
 * The drive, along the roads it actually uses.
 *
 * Two lines rather than one: a wide pale casing under a narrower solid stroke.
 * That is how every road map draws a route, and for the same reason — a single
 * line the width of a street disappears into the street beneath it, while the
 * casing separates it from the cartography without hiding what it crosses.
 *
 * Numbered markers sit at each stop, because the order is the recommendation.
 * Without them the line says where somebody drives and not which end they
 * start from, which is the question the panel exists to answer.
 */
function RouteLayer({ route }: { route: TechnicianRoute | null }) {
  if (!route?.geometry.length) return null;

  return (
    <>
      <Polyline
        pathOptions={{ className: 'map-route-casing', weight: 9, opacity: 0.9 }}
        positions={route.geometry}
      />
      <Polyline
        pathOptions={{ className: 'map-route-line', weight: 4, opacity: 1 }}
        positions={route.geometry}
      />
      {route.stops.map((stop, index) => (
        <Marker
          icon={stopPin(index + 1)}
          key={stop.inspectionId}
          position={[stop.latitude, stop.longitude]}
          zIndexOffset={800}
        >
          <Popup>
            <span className="font-medium">
              {index + 1}. {stop.propertyName}
            </span>
            <br />
            {stop.addressLine1}
            {stop.city ? `, ${stop.city}` : null}
          </Popup>
        </Marker>
      ))}
    </>
  );
}

/**
 * A numbered stop on the recommended route.
 *
 * Above the property pin it sits on, and above the technician, because while a
 * route is shown the order is the thing being read. It carries its own dark
 * ground so a number stays legible over both the line and the map.
 */
function stopPin(order: number) {
  return divIcon({
    className: '',
    html: `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="10" class="fill-map-route" stroke="#fff" stroke-width="2"/>
      <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central"
        fill="#fff" font-size="11" font-weight="700"
        font-family="system-ui, sans-serif">${order}</text>
    </svg>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12],
  });
}

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
function AirTravelLayer({ route }: { route: TechnicianRoute | null }) {
  const runs = useMemo(() => {
    if (!route?.airTravel || !route.origin) return [];
    const stop = route.stops.find((entry) => entry.inspectionId === route.airTravel?.inspectionId);
    if (!stop) return [];
    return greatCirclePath(route.origin, stop);
  }, [route]);

  if (!runs.length) return null;
  const middle = pathMidpoint(runs);

  return (
    <>
      {runs.map((run, index) => (
        <Polyline
          key={index}
          pathOptions={{
            className: 'map-air-line',
            weight: 2,
            opacity: 0.9,
            dashArray: '6 8',
          }}
          positions={run}
        />
      ))}
      {middle ? <Marker icon={planePin()} position={middle} zIndexOffset={700} /> : null}
    </>
  );
}

/** A plane, marking a journey nobody is driving. */
function planePin() {
  return divIcon({
    className: '',
    html: `<svg width="26" height="26" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="11" class="fill-map-air" stroke="#fff" stroke-width="2"/>
      <path fill="#fff" d="M12 4.6c.5 0 .9.4.9.9v3.2l4.7 2.8v1.3l-4.7-1.4v3.3l1.6 1.2v1L12 17.4l-2.5.5v-1l1.6-1.2v-3.3l-4.7 1.4v-1.3l4.7-2.8V5.5c0-.5.4-.9.9-.9z"/>
    </svg>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -13],
  });
}

/**
 * Takes the map to a property picked from the list.
 *
 * A separate component from `FocusSelected` rather than a branch inside it,
 * because the two are driven by different selections and must not race: the
 * page clears one when the other is set, so at most one of these ever has
 * something to do.
 *
 * Keyed on the id alone. Properties do not move, but the array they arrive in
 * is rebuilt whenever the query refetches, and depending on the object would
 * fly the map back to the same place every couple of minutes.
 */
function FocusProperty({
  properties,
  selectedPropertyId,
}: {
  properties: readonly PropertyPosition[];
  selectedPropertyId: string | null;
}) {
  const map = useMap();

  const latest = useRef(properties);
  latest.current = properties;

  useEffect(() => {
    if (!selectedPropertyId) return;
    const property = latest.current.find((entry) => entry.id === selectedPropertyId);
    if (!property) return;

    const animate = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    map.flyTo([property.latitude, property.longitude], SELECTED_ZOOM, {
      animate,
      duration: 0.6,
    });
  }, [map, selectedPropertyId]);

  return null;
}

/**
 * Lets the map zoom out far enough to actually show the whole world.
 *
 * The floor used to be a fixed `minZoom={3}`, which on a console-sized pane
 * stops with a third of the planet off screen -- so the button greyed out with
 * the map still cropped, and a technician reporting from outside Texas could
 * not be brought into the same view as the properties. It read as the map being
 * stuck, which is exactly what it was.
 *
 * The floor is now whatever zoom makes one Earth fit this pane, recomputed when
 * the pane changes size. So "as far out as the world" is always reachable, and
 * never further -- which is the part `minZoom` was there to protect, since past
 * that point the world starts repeating.
 *
 * `Math.floor` rather than `ceil`: the fitting zoom is fractional, and rounding
 * up leaves the world overflowing the pane by a few degrees, which is the whole
 * complaint. Rounding down letterboxes it instead.
 */
function WorldMinZoom() {
  const map = useMap();

  useEffect(() => {
    const apply = () => {
      const fits = map.getBoundsZoom(WORLD_BOUNDS);
      // Zero-sized containers and a not-yet-measured pane both produce
      // nonsense here; leaving the floor alone is better than setting one from
      // a bad measurement.
      if (!Number.isFinite(fits)) return;

      const floor = Math.max(0, Math.floor(fits));
      if (floor !== map.getMinZoom()) map.setMinZoom(floor);
    };

    apply();
    map.on('resize', apply);
    return () => {
      map.off('resize', apply);
    };
  }, [map]);

  return null;
}

/**
 * How close the map goes when somebody is picked from the roster.
 *
 * Street level rather than rooftop. The position is a Balanced-accuracy fix
 * from a handset, good to a few tens of metres, so a closer zoom would imply a
 * precision the dot does not have -- and a technician standing in a garden
 * would appear to be in next door's kitchen.
 */
const SELECTED_ZOOM = 15;

/**
 * Moves the map to whoever was selected in the roster.
 *
 * **Keyed on the selection, never on the position.** Positions arrive every
 * fifteen seconds now, and re-centring on each one would drag the map out from
 * under anybody who had panned away to look at something — following a moving
 * dot is a different feature, and one that has to be asked for rather than
 * imposed the moment a name is clicked.
 *
 * Falls back to the technician's stops when they have no position: somebody who
 * has not opened the app yet still has a round, and showing where their work is
 * answers more than leaving the map where it was.
 */
function FocusSelected({
  fallback,
  position,
  selectedTechnicianId,
}: {
  fallback: [number, number][];
  position: TechnicianPosition | null;
  selectedTechnicianId: string | null;
}) {
  const map = useMap();

  // Read through refs so the effect depends on the selection alone. Both change
  // as fixes arrive, and listing them would re-run this every fifteen seconds.
  const latest = useRef({ fallback, position });
  latest.current = { fallback, position };

  useEffect(() => {
    if (!selectedTechnicianId) return;
    const { fallback: stops, position: at } = latest.current;

    // Animation is a courtesy, not the point: somebody who has asked for less
    // motion gets the same destination without the flight.
    const animate = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (at) {
      map.flyTo([at.latitude, at.longitude], SELECTED_ZOOM, {
        animate,
        duration: 0.6,
      });
      return;
    }
    if (stops.length) map.fitBounds(stops, { padding: [64, 64], maxZoom: SELECTED_ZOOM });
  }, [map, selectedTechnicianId]);

  return null;
}

export function TechnicianMap({
  highlightedBuildingIds = null,
  positions,
  properties = [],
  route = null,
  selectedPropertyId = null,
  selectedTechnicianId = null,
}: {
  highlightedBuildingIds?: ReadonlySet<string> | null;
  positions: readonly TechnicianPosition[];
  properties?: readonly PropertyPosition[];
  /** The selected technician's drive, when one has been worked out. */
  route?: TechnicianRoute | null;
  /** A property picked from the list, which the map flies to. */
  selectedPropertyId?: string | null;
  selectedTechnicianId?: string | null;
}) {
  // Fit to everything, technicians and properties alike, rather than centring
  // on a fixed point: this office works one metropolitan area today, but a
  // hard-coded centre is the kind of thing that silently stops making sense
  // when a second one is added.
  // Not simply everything. A handset reporting from another continent -- a
  // test device, a phone that travelled -- would otherwise drag the view out
  // to a world map on which neither it nor the properties could be read. The
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

  return (
    <MapContainer
      center={FALLBACK_CENTER}
      zoom={FALLBACK_ZOOM}
      className="h-full w-full rounded-lg"
      // Leaflet tiles the world endlessly on the horizontal axis, so zooming
      // out drew the Earth three times over with the properties repeated in
      // each copy — and a technician could appear to be in two places at once.
      // `maxBounds` pins the map to one world, and the viscosity makes the
      // edge firm rather than springy.
      maxBounds={WORLD_BOUNDS}
      maxBoundsViscosity={1}
      // No `minZoom` here on purpose: `WorldMinZoom` sets it from the pane's
      // own size on mount and on resize. A constant cannot be right for both a
      // wide console and a phone, and the one that was here stopped short of
      // the whole world on both.
      scrollWheelZoom
    >
      <WorldMinZoom />
      <FitToData
        fitKey={fitKey}
        points={points}
        suspended={Boolean(selectedTechnicianId) || Boolean(selectedPropertyId)}
      />
      <FocusProperty properties={properties} selectedPropertyId={selectedPropertyId} />
      <FocusSelected
        fallback={selectedStops}
        position={selectedPosition}
        selectedTechnicianId={selectedTechnicianId}
      />
      {/* `noWrap` stops the tile layer itself repeating. Both this and the
          container's `maxBounds` are needed: one bounds the view, the other
          bounds what is painted, and without the pair the copies come back at
          the edges. */}
      <TileLayer attribution={ATTRIBUTION} noWrap url={TILE_URL} />

      {/* Under the markers and over the properties: the route is context for
          the pins, not a thing to be read on its own. */}
      <RouteLayer route={route} />
      <AirTravelLayer route={route} />

      {/* Properties first so they paint underneath, and pinned below the
          technicians by z-index as well — marker order alone does not decide
          it once Leaflet starts sorting by latitude. */}
      <PropertyLayer highlighted={highlightedBuildingIds} properties={properties} />

      {positions.map((position) => {
        const stale = Date.now() - Date.parse(position.recordedAt) > STALE_AFTER_MS;
        // Everybody else recedes rather than disappearing. A dispatcher looking
        // at one technician still needs to see who is near them.
        const dim = Boolean(selectedTechnicianId) && position.technicianId !== selectedTechnicianId;
        return (
          <Fragment key={position.id}>
            {/* The claimed accuracy, drawn to scale. A 5m fix and a 300m fix
                are very different statements, and a map that drew them as the
                same dot would be asserting something nobody knows.

                A sibling of the marker rather than a child, because only
                `Popup` and `Tooltip` belong inside a `Marker`. Nesting it did
                work — `useLayerLifecycle` falls back to `context.map`, and a
                `Marker` sets `overlayContainer`, not `layerContainer` — but
                relying on that is relying on a detail nothing guarantees.
                Drawn before the marker so it sits underneath. */}
            {position.accuracyMeters && position.accuracyMeters > 25 ? (
              <Circle
                center={[position.latitude, position.longitude]}
                radius={position.accuracyMeters}
                pathOptions={{
                  className: 'map-accuracy-ring',
                  weight: 1,
                  opacity: 0.45,
                  fillOpacity: 0.1,
                }}
              />
            ) : null}
            <Marker
              icon={technicianPin(stale, dim)}
              position={[position.latitude, position.longitude]}
              zIndexOffset={500}
            >
              <Popup>
                <span className="font-medium">
                  {position.technician?.displayName ?? 'Unknown technician'}
                </span>
                <br />
                {formatRelative(position.recordedAt)}
                {position.accuracyMeters === null ? null : <> · ±{position.accuracyMeters}m</>}
                {position.batteryPercent === null ? null : (
                  <> · {position.batteryPercent}% battery</>
                )}
              </Popup>
            </Marker>
          </Fragment>
        );
      })}
    </MapContainer>
  );
}
