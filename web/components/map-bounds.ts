/**
 * Deciding what the map should frame.
 *
 * Fitting to everything sounds right and is not. A technician whose handset
 * reported from Manila while every property is in Texas dragged the view out to
 * a world map on which neither was legible — one test device, and the map
 * stopped answering any question at all.
 */

export interface MapPoint {
  latitude: number;
  longitude: number;
}

/**
 * How far outside the properties a technician may be and still be framed.
 *
 * A degree of latitude is about 69 miles, so this admits somebody a county or
 * two beyond the patch — driving home, covering an outlying property — while
 * excluding another continent. Expressed as a constant because the right number
 * is a judgement about how far this business actually operates, not a fact.
 */
const OUTSIDE_MARGIN_DEGREES = 1.5;

interface Box {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

function boundingBox(points: readonly MapPoint[]): Box | null {
  if (!points.length) return null;
  return points.reduce<Box>(
    (box, point) => ({
      minLat: Math.min(box.minLat, point.latitude),
      maxLat: Math.max(box.maxLat, point.latitude),
      minLon: Math.min(box.minLon, point.longitude),
      maxLon: Math.max(box.maxLon, point.longitude),
    }),
    {
      minLat: points[0]!.latitude,
      maxLat: points[0]!.latitude,
      minLon: points[0]!.longitude,
      maxLon: points[0]!.longitude,
    },
  );
}

function within(box: Box, point: MapPoint, margin: number) {
  return (
    point.latitude >= box.minLat - margin &&
    point.latitude <= box.maxLat + margin &&
    point.longitude >= box.minLon - margin &&
    point.longitude <= box.maxLon + margin
  );
}

/**
 * The points worth framing, which is not always all of them.
 *
 * **The properties are the anchor.** They are where the business is, they do
 * not move, and there are hundreds of them — so they define the service area,
 * and a technician far outside it is an outlier rather than a reason to zoom
 * out. Outliers are still *drawn*; they are simply not allowed to decide the
 * framing, so the map stays readable and the stray pin is still there when
 * somebody pans to it.
 *
 * With no properties to anchor on, every position is used: there is nothing to
 * judge an outlier against, and a map that framed nothing would be worse than
 * one framed generously.
 */
export function pointsToFit(
  properties: readonly MapPoint[],
  positions: readonly MapPoint[],
): [number, number][] {
  const asPairs = (points: readonly MapPoint[]): [number, number][] =>
    points.map((point) => [point.latitude, point.longitude]);

  const anchor = boundingBox(properties);
  if (!anchor) return asPairs(positions);

  const nearby = positions.filter((position) =>
    within(anchor, position, OUTSIDE_MARGIN_DEGREES),
  );

  return asPairs([...properties, ...nearby]);
}
