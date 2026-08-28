'use client';

import type { TechnicianRoute } from '@texasrenters/shared';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDistance, formatDuration, formatRelative } from '@/lib/format';
import { describeUnroutable, isPlanned, pluralStops } from '@/lib/route-plan';

/**
 * The order a technician's remaining day should be driven in.
 *
 * Advisory. Nothing stores this order and nothing enforces it — the route is
 * recomputed from wherever the technician actually is, so a technician who
 * ignores it simply gets a different suggestion a minute later rather than
 * being marked as off-plan.
 */
function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}

export function TechnicianRouteCard({
  displayName,
  route,
}: {
  displayName: string;
  route?: TechnicianRoute;
}) {
  // Legs, not stops. See `isPlanned` -- reading `stops` here printed "1 min
  // driving · 0.0 mi · 1 stops" over a route the planner had refused, because
  // the day's stops come back either way and a zero total formats as a minute.
  const planned = isPlanned(route);

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Today&rsquo;s route</CardTitle>
      </CardHeader>
      <CardContent>
        {!route ? (
          <Note>Working it out&hellip;</Note>
        ) : !route.origin ? (
          /* Not an error. The route is measured from where the technician is,
             so without a position there is no starting point — and saying that
             is more useful than an empty list that looks like "no work". */
          <Note>
            {displayName} has not reported a position today, so there is nowhere to measure from.
            The route appears once their shift tracking is on.
          </Note>
        ) : !route.stops.length && !route.unroutable.length ? (
          <Note>Nothing scheduled for today.</Note>
        ) : (
          <div className="space-y-4">
            {/* A position that exists and cannot be driven from. Distinct from
                having no position at all, and previously not distinguished at
                all: the card simply asserted a drive of zero minutes. */}
            {route.originOutsideServiceArea ? (
              <Note>
                {displayName}&rsquo;s last position is not near any road we can route on, so there
                is no start point to drive from.
                {route.airTravel ? (
                  <>
                    {' '}
                    Their nearest stop is{' '}
                    <span className="text-foreground font-medium">
                      {formatDistance(route.airTravel.distanceMeters)}
                    </span>{' '}
                    away in a straight line, so this is a journey by air rather than by road.
                    {/* No duration, on purpose. Flight time needs airports,
                        schedules and connections we do not have, and a number
                        derived from distance would be wrong by hours while
                        looking exact. */}{' '}
                    How long that takes is not something this system can answer.
                  </>
                ) : null}{' '}
                Their stops are listed below, in no particular order.
              </Note>
            ) : null}

            {planned ? (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-2xl font-semibold tabular-nums">
                  {formatDuration(route.totalDurationSeconds)}
                </span>
                <span className="text-muted-foreground text-sm">
                  driving · {formatDistance(route.totalDistanceMeters)} ·{' '}
                  {pluralStops(route.stops.length)}
                </span>
              </div>
            ) : null}

            {/* Said plainly rather than in a tooltip. These times come from a
                routing engine with no traffic data, so they describe an empty
                road — and somebody planning a day around them should know that
                before they are late, not after.

                Only alongside times that exist: without a route there is
                nothing being estimated, and the caveat read as a claim. */}
            {planned && route.origin ? (
              <Note>
                Estimated from free-flow speeds, without traffic. Measured from{' '}
                {formatRelative(route.origin.recordedAt)}.
              </Note>
            ) : null}

            {route.stops.length ? (
              <ol className="space-y-0">
                {route.stops.map((stop, index) => {
                  const leg = planned ? route.legs[index] : undefined;
                  return (
                    <li key={stop.inspectionId} className="border-border/60 border-t py-3">
                      <div className="flex items-baseline gap-3">
                        {/* Numbered only against a real order. A numeral beside
                            an unordered stop reads as a sequence somebody
                            chose, which is the claim this card must not make
                            when the route was refused. */}
                        {planned ? (
                          <span className="text-muted-foreground w-5 text-sm tabular-nums">
                            {index + 1}
                          </span>
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <div className="font-medium">{stop.propertyName}</div>
                          <div className="text-muted-foreground text-sm">
                            {stop.addressLine1}, {stop.city}
                          </div>
                        </div>
                        {/* The drive to this stop, not from it. The first is
                            from the technician's current position, which is
                            why it reads as a journey rather than a schedule. */}
                        <span className="text-muted-foreground text-sm tabular-nums">
                          {leg ? `${formatDuration(leg.durationSeconds)} drive` : null}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : null}

            {/* Never silently dropped. A property nobody could place still has
                an inspection attached to it, and a route of four when the day
                holds five is the failure nobody would report.

                Two reasons now, and they are different faults: one address was
                never located, the other was located somewhere no road reaches. */}
            {route.unroutable.length ? (
              <div className="border-border/60 border-t pt-3">
                <Note>Not on this route: {describeUnroutable(route)}</Note>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
