'use client';

import { memo, useMemo } from 'react';
import { Layer, Source } from 'react-map-gl/mapbox';

import { useMapStroke } from '@/components/map-colors';
import { circleFeature, featureCollection, pointFeature } from '@/components/map-geometry';

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
 * Every property, exactly where it is, at any zoom.
 *
 * **Markers cannot promise this and this layer can.** A marker is a real
 * element the map repositions on every frame, so hundreds of them stutter —
 * which is why properties are grouped into badges, and why a badge can only
 * ever stand on one of the properties it covers. Zoomed out to the whole of
 * east Texas a badge reads "388", and 387 of those properties are somewhere
 * the map is not showing.
 *
 * The office said what that costs them: "I want the markers to be precise also
 * even on the zoom out, cause right now we can't do the radius if the marker is
 * not accurate." The radius circles *are* drawn from the real coordinates — it
 * was the pins beside them that were not, and a picture that disagrees with
 * itself is not one you can judge grouping from.
 *
 * A circle layer is drawn by the GPU from a shape collection, so every one of
 * the 591 is at its own coordinate and the cost is a single layer. The badges
 * stay for what they are good at: a count, and something to click.
 *
 * The dots grow with the zoom rather than sitting at one size. Far out they are
 * a density map and want to be small; in close they are individual buildings
 * beside a pin and want to be visible.
 */
export const PropertyDotsLayer = memo(function PropertyDotsLayer({
  points,
}: {
  points: readonly MapPoint[];
}) {
  const color = useMapStroke('map-property-dot');
  const data = useMemo(
    () => featureCollection(points.map((point) => pointFeature(point.latitude, point.longitude))),
    [points],
  );

  if (!data.features.length) return null;

  return (
    <Source data={data} id="property-dots" type="geojson">
      <Layer
        id="property-dots-circle"
        paint={{
          'circle-color': color,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 1.6, 10, 2.6, 14, 4, 18, 6],
          // A white rim, for the same reason every pin here has one: these sit
          // on satellite imagery and on parks, water and arterial roads.
          'circle-stroke-color': '#fff',
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 0.4, 12, 1, 18, 1.5],
          'circle-opacity': 0.95,
        }}
        type="circle"
      />
    </Source>
  );
});

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
          'fill-opacity': 0.12,
        }}
        type="fill"
      />
      <Layer
        id="grouping-radius-outline"
        // Firmer than the fill, and firmer than it used to be. On satellite
        // imagery a faint edge disappeared into the photograph, and the edge is
        // what tells you where one circle ends and the next begins -- which is
        // the whole reading when two of them overlap.
        paint={{ 'line-color': green, 'line-opacity': 0.7, 'line-width': 1.5 }}
        type="line"
      />
    </Source>
  );
});
