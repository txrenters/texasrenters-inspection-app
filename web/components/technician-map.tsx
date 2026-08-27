'use client';

import 'leaflet/dist/leaflet.css';

import type { PropertyPosition, TechnicianPosition } from '@texasrenters/shared';
import { divIcon, type LatLngBoundsExpression } from 'leaflet';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, MapContainer, Marker, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet';

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
function technicianPin(stale: boolean, dim = false) {
  const fill = stale ? 'fill-map-technician-stale' : 'fill-map-technician';
  return divIcon({
    className: '',
    html: `<svg width="28" height="28" viewBox="0 0 28 28" opacity="${dim ? 0.3 : 1}" xmlns="http://www.w3.org/2000/svg">
      <defs>${MARKER_SHADOW}</defs>
      <circle filter="url(#pin-shadow)" cx="14" cy="14" r="11"
        class="${fill}" stroke="#fff" stroke-width="2.5"/>
      <circle cx="14" cy="11.1" r="2.9" fill="#fff"/>
      <path d="M8.1 20.4c0-3.2 2.7-5.2 5.9-5.2s5.9 2 5.9 5.2z" fill="#fff"/>
    </svg>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });
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
function FitToData({ fitKey, points }: { fitKey: string; points: [number, number][] }) {
  const map = useMap();

  // Held in a ref so the effect can read current coordinates without listing
  // them as a dependency — they change constantly and must not trigger it.
  const latest = useRef(points);
  latest.current = points;

  useEffect(() => {
    if (!latest.current.length) return;
    map.fitBounds(latest.current as LatLngBoundsExpression, { padding: [48, 48], maxZoom: 15 });
  }, [map, fitKey]);

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

export function TechnicianMap({
  highlightedBuildingIds = null,
  positions,
  properties = [],
  selectedTechnicianId = null,
}: {
  highlightedBuildingIds?: ReadonlySet<string> | null;
  positions: readonly TechnicianPosition[];
  properties?: readonly PropertyPosition[];
  selectedTechnicianId?: string | null;
}) {
  // Fit to everything, technicians and properties alike, rather than centring
  // on a fixed point: this office works one metropolitan area today, but a
  // hard-coded centre is the kind of thing that silently stops making sense
  // when a second one is added.
  const points = useMemo<[number, number][]>(
    () => [
      ...positions.map((position) => [position.latitude, position.longitude] as [number, number]),
      ...properties.map((property) => [property.latitude, property.longitude] as [number, number]),
    ],
    [positions, properties],
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
      scrollWheelZoom
    >
      <FitToData fitKey={fitKey} points={points} />
      <TileLayer attribution={ATTRIBUTION} url={TILE_URL} />

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
