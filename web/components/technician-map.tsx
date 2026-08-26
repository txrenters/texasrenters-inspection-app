'use client';

import 'leaflet/dist/leaflet.css';

import type { PropertyPosition, TechnicianPosition } from '@texasrenters/shared';
import { divIcon, type LatLngBoundsExpression } from 'leaflet';
import { useMemo } from 'react';
import { Circle, MapContainer, Marker, Popup, TileLayer } from 'react-leaflet';

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
 * Pins drawn in the page's own CSS rather than Leaflet's marker images.
 *
 * Leaflet's default icon resolves its PNGs relative to the stylesheet, which
 * bundlers rewrite and break — the usual symptom is a map with invisible
 * markers. A `divIcon` sidesteps the asset question entirely and lets a stale
 * pin be drawn differently from a fresh one.
 */
function technicianPin(stale: boolean) {
  return divIcon({
    className: '',
    html: `<span class="block h-3.5 w-3.5 rounded-full border-2 border-white shadow ${
      stale ? 'bg-muted-foreground' : 'bg-primary'
    }"></span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

/**
 * Properties are squares, technicians are circles.
 *
 * Shape rather than only colour, because the two layers have to be told apart
 * at a glance and by people who cannot reliably distinguish two hues. Smaller
 * and paler as well: the properties are the board, not the pieces — they are
 * there so a technician's dot means something, and a map where the fixed
 * points shouted louder than the moving ones would have it backwards.
 */
function propertyPin() {
  return divIcon({
    className: '',
    html: '<span class="block h-2.5 w-2.5 rounded-[2px] border border-white bg-map-property shadow-sm"></span>',
    iconSize: [10, 10],
    iconAnchor: [5, 5],
  });
}

export function TechnicianMap({
  positions,
  properties = [],
}: {
  positions: readonly TechnicianPosition[];
  properties?: readonly PropertyPosition[];
}) {
  // Fit to everything, technicians and properties alike, rather than centring
  // on a fixed point: this office works one metropolitan area today, but a
  // hard-coded centre is the kind of thing that silently stops making sense
  // when a second one is added.
  const bounds = useMemo<LatLngBoundsExpression | undefined>(() => {
    const points: [number, number][] = [
      ...positions.map((position) => [position.latitude, position.longitude] as [number, number]),
      ...properties.map((property) => [property.latitude, property.longitude] as [number, number]),
    ];
    return points.length ? points : undefined;
  }, [positions, properties]);

  return (
    <MapContainer
      // Austin, used only when there is nothing at all to fit. With any point
      // the bounds above take over immediately.
      center={[30.2672, -97.7431]}
      bounds={bounds}
      boundsOptions={{ padding: [48, 48], maxZoom: 15 }}
      className="h-full w-full rounded-lg"
      scrollWheelZoom
    >
      <TileLayer attribution={ATTRIBUTION} url={TILE_URL} />

      {/* Properties first so they paint underneath, and pinned below the
          technicians by z-index as well — marker order alone does not decide
          it once Leaflet starts sorting by latitude. */}
      {properties.map((property) => (
        <Marker
          key={property.id}
          icon={propertyPin()}
          position={[property.latitude, property.longitude]}
          zIndexOffset={-500}
        >
          <Popup>
            <span className="font-medium">{property.name}</span>
            <br />
            {property.addressLine1}
            <br />
            {property.city}, {property.state} {property.postalCode}
            {/* Census geocoding interpolates along a street segment rather
                than pointing at a roof, so the pin is the right block and
                approximately the right house. Saying so is cheaper than
                somebody discovering it while standing in a driveway. */}
            <br />
            <span className="text-muted-foreground text-xs">Approximate location</span>
          </Popup>
        </Marker>
      ))}

      {positions.map((position) => {
        const stale = Date.now() - Date.parse(position.recordedAt) > STALE_AFTER_MS;
        return (
          <Marker
            key={position.id}
            icon={technicianPin(stale)}
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
              {position.batteryPercent === null ? null : <> · {position.batteryPercent}% battery</>}
            </Popup>
            {/* The claimed accuracy, drawn to scale. A 5m fix and a 300m fix
                are very different statements, and a map that drew them as the
                same dot would be asserting something nobody knows. */}
            {position.accuracyMeters && position.accuracyMeters > 25 ? (
              <Circle
                center={[position.latitude, position.longitude]}
                radius={position.accuracyMeters}
                pathOptions={{ weight: 1, opacity: 0.4, fillOpacity: 0.08 }}
              />
            ) : null}
          </Marker>
        );
      })}
    </MapContainer>
  );
}
