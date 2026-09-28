'use client';

import { memo, useMemo } from 'react';
import { Layer, Source } from 'react-map-gl/mapbox';

import { useMapStroke } from '@/components/map-colors';
import { circleFeature, featureCollection } from '@/components/map-geometry';

/**
 * Layers that belong to no one map.
 *
 * The grouping radius was built on the technician map, and the office then
 * looked for it on the quarter plan -- which is the map they actually rebuild a
 * quarter against -- and found nothing. It was never a technician-map feature;
 * it was a feature of *this console's map*, which until now did not exist as a
 * thing that could be reused.
 */

/** Anything with a position. Deliberately not a `PropertyPosition`. */
export interface MapPoint {
  latitude: number;
  longitude: number;
}

/**
 * A circle of one radius around every point, to judge grouping by eye.
 *
 * The office rebuilds a quarter by deciding which properties are near enough to
 * be worth one day's driving, and the planner's own answer to that is a number
 * of minutes nobody can see. This draws the question instead: turn it on and
 * where the circles overlap is where properties could share a day.
 *
 * One source for everything rather than a circle per point, because this is
 * drawn over hundreds at once -- the point is the shape they make together, not
 * any single one. Filled and faint: hundreds of hard outlines read as noise,
 * and it is the overlaps being read.
 *
 * Nothing to do with the geofence rings, which are orange, per-property, and
 * are the distance somebody's hours are measured from. Two questions, two
 * colours.
 */
export const GroupingRadiusLayer = memo(function GroupingRadiusLayer({
  points,
  radiusMeters,
}: {
  points: readonly MapPoint[];
  radiusMeters: number;
}) {
  const green = useMapStroke('map-grouping-circle');
  const data = useMemo(
    () =>
      featureCollection(
        radiusMeters
          ? points.map((point) => circleFeature(point.latitude, point.longitude, radiusMeters))
          : [],
      ),
    [points, radiusMeters],
  );

  if (!radiusMeters || !data.features.length) return null;

  return (
    <Source data={data} id="grouping-radius" type="geojson">
      <Layer
        id="grouping-radius-fill"
        paint={{
          'fill-color': green,
          // Low, and deliberately so: two overlapping circles read as a darker
          // patch, which is exactly the signal. At a heavier fill the whole of
          // west Houston is one green slab and says nothing.
          'fill-opacity': 0.08,
        }}
        type="fill"
      />
      <Layer
        id="grouping-radius-outline"
        paint={{ 'line-color': green, 'line-opacity': 0.35, 'line-width': 1 }}
        type="line"
      />
    </Source>
  );
});
