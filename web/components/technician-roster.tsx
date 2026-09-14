'use client';

import type {
  AssignedStop,
  TechnicianAssignments,
  TechnicianDayTimeline,
  TechnicianPosition,
  TechnicianRoute,
} from '@texasrenters/shared';
import { isFinishedStatus } from '@texasrenters/shared';
import { CheckIcon, MapPinIcon } from 'lucide-react';

import { businessTimeOfDay } from '@/lib/clock';
import { formatDistance, formatDuration, formatRelative, humanize } from '@/lib/format';
import {
  arrivalTime,
  describeOrigin,
  historyTotals,
  isPlanned,
  listDay,
  offRoadNetwork,
  onSiteSeconds,
  timingNote,
  visitTimes,
} from '@/lib/route-plan';

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
/**
 * Whether a technician belongs on the map for the day being looked at.
 *
 * Scheduled work decides it -- not whether their phone is reporting.
 *
 * Offline **with** stops stays. The forecast and the drawn route depend on
 * seeing that technician, and somebody who has not started yet is exactly who a
 * dispatcher is looking for at eight in the morning.
 *
 * Nothing scheduled leaves, online or not. Showing those rows was actively
 * harmful: the map fits itself to every marker, so an office tester with no
 * work and a last position in the Philippines dragged the whole view across the
 * Pacific and away from every Texas stop.
 */
export function isOnTheDay(entry: RosterEntry): boolean {
  return entry.stops.length > 0;
}

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
  onSelectStop,
  route,
  selectedId,
  selectedStopBuildingId = null,
  timeline = null,
}: {
  entries: RosterEntry[];
  onSelect: (technicianId: string | null) => void;
  /**
   * Take the map to one stop, without disturbing the technician selection.
   *
   * Separate from `onSelect` because the two mean different things: picking a
   * person frames their whole round, picking a stop moves to one address
   * inside it. The round stays selected either way, so the highlighting and
   * the drawn route survive the click.
   */
  onSelectStop?: (buildingId: string | null) => void;
  /**
   * The selected technician's day as their location trail read it: the visit
   * under way, when each stop ahead is reached, and how long each finished
   * visit took. From the timeline rather than the route, because only the
   * trail knows where they have actually been.
   */
  timeline?: TechnicianDayTimeline | null;
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
  /** The stop the map is currently showing, so the list can say which. */
  selectedStopBuildingId?: string | null;
}) {
  // Built once per render rather than per stop: the same answer for every row,
  // and rebuilding it inside the list would make it O(stops x refusals).
  const refused = offRoadNetwork(route);
  const planned = isPlanned(route);
  const projection = timeline?.projection ?? null;

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
        // Only the selected person's day is read closely enough to know where
        // they are; everyone else is a name and a count.
        const listings = selected
          ? listDay(entry.stops, route, projection?.current?.inspectionIds)
          : [];
        const here = listings.find((listing) => listing.role === 'CURRENT');
        const finishedCount = entry.stops.filter((stop) => isFinishedStatus(stop.status)).length;
        const totals = historyTotals(timeline, listings);
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
                  {/* Where they are, when the trail puts them at one of the
                      day's properties -- the question somebody opening this
                      row is usually asking. */}
                  {here ? (
                    <span className="text-foreground">At {here.stop.propertyName} · </span>
                  ) : null}
                  {entry.position
                    ? formatRelative(entry.position.recordedAt)
                    : 'No position reported'}
                </span>
              </span>
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {entry.stops.length === 0
                  ? '—'
                  : finishedCount
                    ? `${finishedCount}/${entry.stops.length} done`
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

                    {planned && route ? (
                      <p className="text-muted-foreground mb-2 text-xs">
                        <span className="text-foreground font-medium">
                          {formatDuration(route.totalDurationSeconds)}
                        </span>{' '}
                        driving · {formatDistance(route.totalDistanceMeters)} · suggested order
                        {describeOrigin(route) ? <> {describeOrigin(route)}</> : null}
                      </p>
                    ) : null}

                    {/* The finished part of the day, added up from the
                        location trail: the time it took, the driving, and
                        the time inside. Only what the trail measured -- a
                        visit it never saw is counted but adds no time. */}
                    {totals.finished ? (
                      <p className="text-muted-foreground mb-2 text-xs">
                        <span className="text-foreground font-medium">
                          {totals.finished} done
                        </span>
                        {totals.measured ? (
                          <>
                            {' '}
                            · {formatDuration(totals.totalSeconds)} total ·{' '}
                            {formatDuration(totals.driveSeconds)} driving ·{' '}
                            {formatDuration(totals.onSiteSeconds)} on site
                          </>
                        ) : (
                          ' · no time measured'
                        )}
                      </p>
                    ) : null}

                    <ol className="space-y-1.5">
                      {listings.map(({ stop, role, routeIndex }) => {
                        const finished = role === 'FINISHED';
                        const leg =
                          planned && routeIndex !== null ? route?.legs[routeIndex] : undefined;
                        const onSite = onSiteSeconds(projection, stop.inspectionId);
                        const arrival = arrivalTime(projection, stop.inspectionId);
                        const took = finished ? visitTimes(timeline, stop.inspectionId) : null;
                        const offNetwork = refused.has(stop.inspectionId);
                        // Only a stop with a building can be shown on a map, so
                        // only that one becomes a control. The rest already say
                        // "not on the map"; making them look pressable and then
                        // doing nothing would be worse than leaving them plain.
                        const mappable = Boolean(stop.buildingId && onSelectStop);
                        const focused = Boolean(
                          stop.buildingId && stop.buildingId === selectedStopBuildingId,
                        );
                        // One element either way. Swapping the tag rather than
                        // nesting a button keeps the row's layout identical
                        // between the two cases.
                        const Row = mappable ? 'button' : 'span';
                        return (
                          <li
                            className={`flex gap-2 text-xs leading-snug ${finished ? 'opacity-60' : ''}`}
                            key={stop.inspectionId}
                          >
                            {/* A tick for what is done, the route's number for
                                what is left. Numbers only where there is a
                                route: a bare list with numbers on it would read
                                as an order somebody chose. */}
                            {finished ? (
                              <CheckIcon
                                aria-label="Done"
                                className="text-muted-foreground mt-0.5 size-3 shrink-0"
                              />
                            ) : planned ? (
                              <span className="text-muted-foreground w-3 shrink-0 tabular-nums">
                                {routeIndex !== null ? routeIndex + 1 : ''}
                              </span>
                            ) : null}
                            <Row
                              {...(mappable
                                ? {
                                    'aria-pressed': focused,
                                    onClick: () =>
                                      onSelectStop?.(focused ? null : (stop.buildingId ?? null)),
                                    type: 'button' as const,
                                  }
                                : {})}
                              className={`min-w-0 flex-1 text-left ${
                                mappable
                                  ? 'hover:text-foreground focus-visible:ring-ring cursor-pointer rounded-sm outline-none focus-visible:ring-2'
                                  : ''
                              }`}
                            >
                              {/* Green is the next stop, on the list and on the
                                  map. The stop the map is showing is underlined
                                  rather than coloured, so the two never read as
                                  the same thing. */}
                              <span
                                className={`flex items-center gap-1 font-medium ${
                                  role === 'NEXT' ? 'text-map-technician' : ''
                                } ${finished ? 'text-muted-foreground' : ''} ${
                                  focused ? 'underline underline-offset-2' : ''
                                }`}
                              >
                                {role === 'CURRENT' ? (
                                  <MapPinIcon aria-label="Here now" className="size-3 shrink-0" />
                                ) : null}
                                <span className="min-w-0 truncate">{stop.propertyName}</span>
                                {role === 'NEXT' ? (
                                  <span className="text-[10px] font-semibold tracking-wide uppercase">
                                    Next
                                  </span>
                                ) : null}
                              </span>
                              <span className="text-muted-foreground block">
                                {/* The type carries more weight than the status
                                    it sits beside: it is what separates two
                                    visits to the same address, and at the same
                                    colour the pair read as one grey blob. */}
                                <span className={finished ? '' : 'text-foreground'}>
                                  {humanize(stop.inspectionType)}
                                </span>{' '}
                                · {humanize(stop.status)}
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
                              {/* How the finished visit went, from the trail. */}
                              {took ? (
                                <span className="text-muted-foreground block tabular-nums">
                                  {took.driveSeconds !== null
                                    ? `${formatDuration(took.driveSeconds)} drive · `
                                    : ''}
                                  {formatDuration(took.onSiteSeconds)} on site ·{' '}
                                  {formatDuration(took.totalSeconds)} total
                                </span>
                              ) : null}
                            </Row>
                            {finished ? (
                              <span className="text-muted-foreground shrink-0 text-right tabular-nums">
                                {businessTimeOfDay(stop.finishedAt)
                                  ? `Done ${businessTimeOfDay(stop.finishedAt)}`
                                  : 'Done'}
                              </span>
                            ) : onSite !== null ? (
                              /* The stop they are at has no drive left and no
                                 arrival to wait for -- only how long they have
                                 been there, which is what the times after it
                                 are counted from. */
                              <span className="text-foreground shrink-0 text-right tabular-nums">
                                on site {formatDuration(onSite)}
                              </span>
                            ) : leg ? (
                              <span className="text-muted-foreground shrink-0 text-right tabular-nums">
                                {formatDuration(leg.durationSeconds)}
                                {/* When they are expected there, recomputed from
                                    where they are on every refresh. Absent for a
                                    stop already behind them. */}
                                {arrival ? (
                                  <span className="text-foreground block">{arrival}</span>
                                ) : null}
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ol>

                    {/* What the times are, from whichever router drew them:
                        Google's include traffic, the fallback's describe an
                        empty road. Only beside times that exist. */}
                    {planned && timingNote(route) ? (
                      <p className="text-muted-foreground mt-2 text-[11px]">{timingNote(route)}</p>
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
