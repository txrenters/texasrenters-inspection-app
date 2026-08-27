'use client';

import type {
  AssignedStop,
  TechnicianAssignments,
  TechnicianPosition,
  TechnicianRoute,
} from '@texasrenters/shared';

import { formatDistance, formatDuration, formatRelative, humanize } from '@/lib/format';

/**
 * Who is out, where they were last, and how much work is theirs.
 *
 * Beside the map rather than on it. The map answers "where is everybody"; this
 * answers "who is everybody, and what are they doing" — and the two questions
 * want different shapes. A dispatcher scanning a list reads names and counts
 * far faster than they read a scatter of pins.
 *
 * Selecting a person is the join between the two: the map dims everything that
 * is not theirs, which is the only way to see one round when five hundred and
 * forty-six properties are drawn.
 */

/** Past this, a position is history rather than an answer to "where are they". */
const STALE_AFTER_MS = 30 * 60_000;

export interface RosterEntry {
  technicianId: string;
  displayName: string;
  stops: AssignedStop[];
  position: TechnicianPosition | null;
}

/**
 * Everyone worth showing, from the two sources the page already holds.
 *
 * Union rather than intersection, deliberately. Somebody with work and no
 * position has not started or has no signal; somebody with a position and no
 * work is out with nothing booked. Both are things a dispatcher needs to see,
 * and an inner join would hide exactly the two cases worth asking about.
 */
export function buildRoster(
  positions: readonly TechnicianPosition[],
  assignments: readonly TechnicianAssignments[],
): RosterEntry[] {
  const entries = new Map<string, RosterEntry>();

  for (const assignment of assignments)
    entries.set(assignment.technicianId, {
      technicianId: assignment.technicianId,
      displayName: assignment.displayName,
      stops: assignment.stops,
      position: null,
    });

  for (const position of positions) {
    const existing = entries.get(position.technicianId);
    if (existing) existing.position = position;
    else
      entries.set(position.technicianId, {
        technicianId: position.technicianId,
        displayName: position.technician?.displayName ?? 'Unknown technician',
        stops: [],
        position,
      });
  }

  // Working people first, then by name. Somebody with stops is the reason this
  // panel exists; somebody idle is context.
  return [...entries.values()].sort(
    (left, right) =>
      right.stops.length - left.stops.length ||
      left.displayName.localeCompare(right.displayName),
  );
}

/**
 * The stops in the order they should be driven, when that is known.
 *
 * The route only carries stops it could place, so anything it dropped is
 * appended rather than lost -- a property with no coordinate is still work,
 * and a list that quietly held fewer inspections than the count above it
 * would be the worse failure.
 */
function orderStops(stops: AssignedStop[], route: TechnicianRoute | null | undefined) {
  if (!route?.stops.length) return stops;

  const byInspection = new Map(stops.map((stop) => [stop.inspectionId, stop]));
  const ordered = route.stops
    .map((stop) => byInspection.get(stop.inspectionId))
    .filter((stop): stop is AssignedStop => Boolean(stop));

  const seen = new Set(ordered.map((stop) => stop.inspectionId));
  return [...ordered, ...stops.filter((stop) => !seen.has(stop.inspectionId))];
}

/**
 * Stops the router had to refuse because nothing drivable is near them.
 *
 * Separate from a stop with no coordinate at all, which the panel already marks
 * as "not on the map" -- this one has a coordinate and it is wrong, which is
 * worth saying differently because the fix is different.
 */
function offRoadNetwork(route: TechnicianRoute | null | undefined): Set<string> {
  return new Set(
    (route?.unroutable ?? [])
      .filter((entry) => entry.reason === 'OUTSIDE_SERVICE_AREA')
      .map((entry) => entry.inspectionId),
  );
}

function Dot({ position }: { position: TechnicianPosition | null }) {
  if (!position)
    return (
      <span
        aria-hidden="true"
        className="border-muted-foreground/50 block size-2.5 shrink-0 rounded-full border"
      />
    );

  const stale = Date.now() - Date.parse(position.recordedAt) > STALE_AFTER_MS;
  return (
    <span
      aria-hidden="true"
      className={`block size-2.5 shrink-0 rounded-full ${
        stale ? 'bg-map-technician-stale' : 'bg-map-technician'
      }`}
    />
  );
}

export function TechnicianRoster({
  entries,
  onSelect,
  route,
  selectedId,
}: {
  entries: RosterEntry[];
  onSelect: (technicianId: string | null) => void;
  /**
   * The selected technician's drive, once it has been worked out.
   *
   * When it exists the stops are listed in the order it recommends, with the
   * drive to each. Without it they are listed alphabetically, because
   * `scheduledAt` is a date with no clock value -- so an unordered day has no
   * order of its own, and inventing one would be a suggestion nobody made.
   */
  route?: TechnicianRoute | null;
  selectedId: string | null;
}) {
  // Built once per render rather than per stop: the same answer for every row,
  // and rebuilding it inside the list would make it O(stops x refusals).
  const refused = offRoadNetwork(route);

  if (!entries.length)
    return (
      <p className="text-muted-foreground p-4 text-sm">
        Nobody has work scheduled today and no handset has reported a position.
      </p>
    );

  return (
    <ul className="divide-border divide-y">
      {entries.map((entry) => {
        const selected = entry.technicianId === selectedId;
        return (
          <li key={entry.technicianId}>
            <button
              aria-pressed={selected}
              className={`hover:bg-muted/60 focus-visible:ring-ring flex w-full items-center gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 ${
                selected ? 'bg-muted' : ''
              }`}
              // Clicking the selected row clears it, so the way out is the same
              // control as the way in rather than a separate "show all".
              onClick={() => onSelect(selected ? null : entry.technicianId)}
              type="button"
            >
              <Dot position={entry.position} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{entry.displayName}</span>
                <span className="text-muted-foreground block truncate text-xs">
                  {entry.position
                    ? formatRelative(entry.position.recordedAt)
                    : 'No position reported'}
                </span>
              </span>
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {entry.stops.length === 0
                  ? '—'
                  : `${entry.stops.length} ${entry.stops.length === 1 ? 'stop' : 'stops'}`}
              </span>
            </button>

            {/* The day itself, revealed by selecting the person rather than
                listed for everybody at once. Five technicians with six stops
                each is thirty rows, and a panel that long stops being scannable
                — which is the only thing it is for. */}
            {selected ? (
              <div className="bg-muted/40 border-t px-4 py-2">
                {entry.stops.length === 0 ? (
                  <p className="text-muted-foreground py-1 text-xs">
                    Nothing scheduled for this day.
                  </p>
                ) : (
                  <>
                    {/* Said plainly, because the alternative is a panel that
                        lists the day with no order and no explanation -- and
                        the reader has no way to tell that from the routing
                        service being down. Previously this case did not
                        surface at all: a position too far from any road was
                        quietly snapped to the nearest one that existed, and
                        the drive was reported as though it were real. */}
                    {route?.originOutsideServiceArea ? (
                      <p className="text-muted-foreground mb-2 text-xs">
                        No suggested order: the last reported position is not near any road we
                        can route on, so there is no start point to drive from.
                      </p>
                    ) : null}

                    {route?.stops.length ? (
                      <p className="text-muted-foreground mb-2 text-xs">
                        <span className="text-foreground font-medium">
                          {formatDuration(route.totalDurationSeconds)}
                        </span>{' '}
                        driving · {formatDistance(route.totalDistanceMeters)} · suggested order
                      </p>
                    ) : null}

                    <ol className="space-y-1.5">
                      {orderStops(entry.stops, route).map((stop, index) => {
                        const leg = route?.stops.length ? route.legs[index] : undefined;
                        const offNetwork = refused.has(stop.inspectionId);
                        return (
                          <li className="flex gap-2 text-xs leading-snug" key={stop.inspectionId}>
                            {/* Numbered only when there is a route to number
                                against. A bare list with numbers on it would
                                read as an order somebody chose. */}
                            {route?.stops.length ? (
                              <span className="text-muted-foreground w-3 shrink-0 tabular-nums">
                                {index + 1}
                              </span>
                            ) : null}
                            <span className="min-w-0 flex-1">
                              <span className="block font-medium">{stop.propertyName}</span>
                              <span className="text-muted-foreground block">
                                {humanize(stop.inspectionType)} · {humanize(stop.status)}
                                {/* Said rather than left as a pin that never
                                    highlights: the technician still has to go,
                                    the address simply is not on the map. */}
                                {stop.buildingId ? null : ' · not on the map'}
                                {/* A different fault from having no
                                    coordinate: this one has a position and it
                                    is nowhere a road reaches, which usually
                                    means the address geocoded badly. */}
                                {offNetwork ? ' · off the road network' : null}
                              </span>
                            </span>
                            {leg ? (
                              <span className="text-muted-foreground shrink-0 tabular-nums">
                                {formatDuration(leg.durationSeconds)}
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ol>

                    {route?.stops.length ? (
                      <p className="text-muted-foreground mt-2 text-[11px]">
                        Estimated from speed limits, without traffic.
                      </p>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
