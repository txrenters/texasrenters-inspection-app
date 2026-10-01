'use client';

import { memo, useMemo } from 'react';
import { Layer, Marker, Source } from 'react-map-gl/mapbox';

import type { ZoneTerritory } from '@/components/planning/zone-territories';

/**
 * Each zone's ground and fence, and its name: the Group maker's zones, on any
 * map that draws them.
 *
 * Always mounted, drawing nothing when there are no zones to show, and hidden
 * rather than unmounted: layer order is mount order, so zones switched on
 * later would otherwise be added over everything mounted since. Mount it
 * before whatever should lie on top of it.
 */
export const ZoneLayers = memo(function ZoneLayers({
  zones,
  visible = true,
}: {
  zones: readonly ZoneTerritory[];
  visible?: boolean;
}) {
  /** Every zone's ground and fence in one source, each painted from its own colour. */
  const shapes = useMemo(
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
  const visibility = visible ? 'visible' : 'none';

  return (
    <>
      {/* A faint wash for each zone's ground, and its fence drawn just inside
          its own edge, so where two zones meet both fences show side by side. */}
      <Source data={shapes} id="zones" type="geojson">
        <Layer
          filter={['==', ['get', 'part'], 'fill']}
          id="zone-fill"
          // No antialiasing: the fill is squares laid edge to edge, and an
          // antialiased edge draws each seam as a faint line.
          layout={{ visibility }}
          paint={{ 'fill-antialias': false, 'fill-color': ['get', 'color'], 'fill-opacity': 0.07 }}
          type="fill"
        />
        <Layer
          filter={['==', ['get', 'part'], 'fence']}
          id="zone-fence"
          layout={{ 'line-join': 'round', visibility }}
          paint={{
            'line-color': ['get', 'color'],
            'line-offset': 1.5,
            'line-opacity': 0.85,
            'line-width': 2,
          }}
          type="line"
        />
      </Source>

      {/* "Zone N", on one of the zone's own properties and just below its pin. */}
      {visible
        ? zones.map((territory) => (
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
          ))
        : null}
    </>
  );
});
