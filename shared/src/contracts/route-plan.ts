/**
 * Ordering a technician's day.
 *
 * `Inspection.scheduledAt` is a date with no time of day, so there are no
 * appointment windows to route around. That is what makes the order of a day's
 * stops genuinely free — and therefore worth choosing well — but it also means
 * nothing here can promise an arrival time. It says how long the driving takes
 * and no more.
 */

/**
 * Above this many stops, stop looking for the exact answer.
 *
 * Seven stops is 5,040 orderings, which is nothing. Eight is 40,320 and nine is
 * 362,880 — still fast, but the curve is factorial and the honest place to stop
 * is before it bites rather than after somebody notices. A technician's day is
 * three to six properties, so the exact path is what runs in practice and the
 * heuristic below exists for the day somebody assigns twelve.
 */
export const MAX_EXACT_STOPS = 7;

/**
 * Travel times between every point, in seconds.
 *
 * Row and column `0` are the technician's current position; `1..n` are the
 * stops in the order they were given. Square, and not necessarily symmetric —
 * one-way systems and turn restrictions mean A→B and B→A genuinely differ, so
 * this must never be collapsed to a triangle.
 */
export type DurationMatrix = readonly (readonly number[])[];

/** Total seconds to visit `order` from the origin, without returning to it. */
export function routeDuration(matrix: DurationMatrix, order: readonly number[]): number {
  if (!order.length) return 0;

  let total = matrix[0]?.[order[0] as number] ?? 0;
  for (let index = 0; index < order.length - 1; index += 1)
    total += matrix[order[index] as number]?.[order[index + 1] as number] ?? 0;

  return total;
}

function permutations(items: readonly number[]): number[][] {
  if (items.length <= 1) return [[...items]];

  const output: number[][] = [];
  for (let index = 0; index < items.length; index += 1) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) output.push([items[index] as number, ...tail]);
  }
  return output;
}

function nearestNeighbour(matrix: DurationMatrix, stops: readonly number[]): number[] {
  const remaining = new Set(stops);
  const order: number[] = [];
  let current = 0;

  while (remaining.size) {
    let best: number | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const candidate of remaining) {
      const cost = matrix[current]?.[candidate] ?? Number.POSITIVE_INFINITY;
      if (cost < bestCost) {
        bestCost = cost;
        best = candidate;
      }
    }
    if (best === null) break;
    order.push(best);
    remaining.delete(best);
    current = best;
  }

  return order;
}

/**
 * Reverse segments while that shortens the path.
 *
 * Plain 2-opt on an open path rather than a tour: there is no return leg, so a
 * reversal changes the two edges at the segment's ends and nothing else. Runs
 * to a fixed point, which for the sizes this ever sees is a handful of passes.
 */
function twoOpt(matrix: DurationMatrix, initial: readonly number[]): number[] {
  let best = [...initial];
  let bestCost = routeDuration(matrix, best);
  let improved = true;

  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i += 1) {
      for (let j = i + 1; j < best.length; j += 1) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, j + 1).reverse(),
          ...best.slice(j + 1),
        ];
        const cost = routeDuration(matrix, candidate);
        if (cost < bestCost - 1e-9) {
          best = candidate;
          bestCost = cost;
          improved = true;
        }
      }
    }
  }

  return best;
}

/**
 * The order to visit the stops in, starting from the technician's position.
 *
 * Returns indices into the matrix (`1..n`), never including the origin. Exact
 * up to `MAX_EXACT_STOPS` because the real sizes are small and an exact answer
 * costs nothing; nearest-neighbour refined by 2-opt beyond that.
 *
 * This is a shortest **path**, not a tour: it does not come back. Nothing in
 * the system knows where a technician goes at the end of the day, and assuming
 * they return to the first property would optimise for a journey nobody makes.
 */
export function shortestRouteOrder(matrix: DurationMatrix): number[] {
  const stops = Array.from({ length: Math.max(0, matrix.length - 1) }, (_, index) => index + 1);
  if (stops.length <= 1) return stops;

  if (stops.length <= MAX_EXACT_STOPS) {
    let best = stops;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const candidate of permutations(stops)) {
      const cost = routeDuration(matrix, candidate);
      if (cost < bestCost) {
        bestCost = cost;
        best = candidate;
      }
    }
    return best;
  }

  return twoOpt(matrix, nearestNeighbour(matrix, stops));
}

export interface RouteStop {
  inspectionId: string;
  propertyId: string;
  propertyName: string;
  addressLine1: string;
  city: string;
  latitude: number;
  longitude: number;
}

export interface RouteLeg {
  /** Null on the first leg, which starts from the technician rather than a stop. */
  fromStopId: string | null;
  toStopId: string;
  distanceMeters: number;
  durationSeconds: number;
}

/**
 * A technician's day, in the order it should be driven.
 *
 * `unroutable` is carried rather than dropped. A property that never geocoded
 * cannot be routed to, and silently omitting it would turn "you have five
 * inspections" into a route of four with nothing to say why — the one failure
 * mode here that nobody would report.
 */
export interface TechnicianRoute {
  technicianId: string;
  /** Where the technician was when this was calculated, and when that was. */
  origin: { latitude: number; longitude: number; recordedAt: string } | null;
  stops: RouteStop[];
  legs: RouteLeg[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  unroutable: { inspectionId: string; propertyName: string; reason: 'NO_COORDINATES' }[];
  /**
   * The drive itself, as `[latitude, longitude]` along the road.
   *
   * **Latitude first**, flipped from what OSRM returns. OSRM speaks
   * `lon,lat`; Leaflet, and every coordinate elsewhere in this system, is
   * `lat,lng`. Passing OSRM's order straight through draws a line through the
   * Indian Ocean, which is the same axis mistake the Census geocoder invites in
   * the opposite direction -- so the flip happens once, at the edge, and is
   * tested.
   *
   * Empty when the route could not be drawn. The stops and legs may still be
   * present: knowing the order and the times is useful without the line.
   */
  geometry: [number, number][];
  /**
   * Free-flow, from the road network's speed limits. OSRM has no traffic data,
   * so this is optimistic in Houston at five o'clock and both surfaces must say
   * "estimate" rather than implying an arrival time.
   */
  estimated: true;
}

/**
 * Who is working today, and which properties are theirs.
 *
 * Deliberately only ids and a name. The console already holds every position
 * and every property for its map, so sending those again would be a second
 * copy to disagree with the first -- the panel joins what it has rather than
 * being told twice.
 *
 * `buildingIds` point at `propertyware_buildings`, the same table the map
 * draws. A real inspection carries that id; `Property` rows exist only where
 * the inspection workflow happened to create one, so matching on those would
 * highlight almost nothing.
 */
/** One inspection on somebody's day, as the console panel lists it. */
export interface AssignedStop {
  inspectionId: string;
  /**
   * The map marker this stop belongs to, or null when the inspection has no
   * synced building.
   *
   * Nullable rather than filtered out: the technician still has to go, and a
   * stop that cannot be highlighted is worth showing in the list with nothing
   * to click. Dropping it would make the panel disagree with the workload.
   */
  buildingId: string | null;
  propertyName: string;
  inspectionType: string;
  status: string;
}

export interface TechnicianAssignments {
  technicianId: string;
  displayName: string;
  stops: AssignedStop[];
}
