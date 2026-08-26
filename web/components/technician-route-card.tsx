'use client';

import type { TechnicianRoute } from '@texasrenters/shared';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDistance, formatDuration, formatRelative } from '@/lib/format';

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
            {route.stops.length ? (
              <>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-2xl font-semibold tabular-nums">
                    {formatDuration(route.totalDurationSeconds)}
                  </span>
                  <span className="text-muted-foreground text-sm">
                    driving · {formatDistance(route.totalDistanceMeters)} ·{' '}
                    {route.stops.length} stops
                  </span>
                </div>

                {/* Said plainly rather than in a tooltip. These times come from
                    a routing engine with no traffic data, so they describe an
                    empty road — and somebody planning a day around them should
                    know that before they are late, not after. */}
                <Note>
                  Estimated from free-flow speeds, without traffic. Measured from{' '}
                  {formatRelative(route.origin.recordedAt)}.
                </Note>

                <ol className="space-y-0">
                  {route.stops.map((stop, index) => {
                    const leg = route.legs[index];
                    return (
                      <li key={stop.inspectionId} className="border-border/60 border-t py-3">
                        <div className="flex items-baseline gap-3">
                          <span className="text-muted-foreground w-5 text-sm tabular-nums">
                            {index + 1}
                          </span>
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
              </>
            ) : null}

            {/* Never silently dropped. A property nobody could place still has
                an inspection attached to it, and a route of four when the day
                holds five is the failure nobody would report. */}
            {route.unroutable.length ? (
              <div className="border-border/60 border-t pt-3">
                <Note>
                  {route.unroutable.length === 1 ? 'One stop is' : `${route.unroutable.length} stops are`}{' '}
                  not on this route because the address could not be placed on the map:{' '}
                  {route.unroutable.map((stop) => stop.propertyName).join(', ')}.
                </Note>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
