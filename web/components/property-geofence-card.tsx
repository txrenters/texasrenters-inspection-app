'use client';

import { GEOFENCE_RADIUS_BOUNDS, geofenceRadiusProblem, type AdminPropertyGeofence } from '@texasrenters/shared';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { usePermissions } from '@/lib/auth';
import { useAdminMutations } from '@/lib/queries';

/**
 * How close a technician has to be for this property to count as visited.
 *
 * The number the hours on the Timesheet are computed from. Until this existed
 * nothing in the system could write it, so all 589 properties ran on 40 m in /
 * 60 m out whether that suited a suburban house, a twelve-acre lot or a
 * forty-unit complex — and an office looking at a ring drawn over the wrong
 * shape had nowhere to say so.
 *
 * Deliberately plain about what the two numbers are for. "Arrival" and
 * "departure" rather than "enter" and "exit" radius, because the person
 * setting them is reading a timesheet, not a specification, and the gap
 * between them is the one thing they have to understand to set them sensibly.
 */
export function PropertyGeofenceCard({
  propertyId,
  geofence,
}: {
  propertyId: string;
  geofence: AdminPropertyGeofence;
}) {
  const { has } = usePermissions();
  const canChange = has('properties:manage');
  const { setPropertyGeofence, clearPropertyGeofence } = useAdminMutations();

  const [enter, setEnter] = useState(String(geofence.enterRadiusMeters));
  const [exit, setExit] = useState(String(geofence.exitRadiusMeters));
  const [saved, setSaved] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const numbers = { enter: Number(enter), exit: Number(exit) };
  /**
   * Checked here with the server's own function, so the office reads the
   * reason while typing rather than after a round trip that failed.
   */
  const problem =
    enter.trim() === '' || exit.trim() === ''
      ? 'Give both distances.'
      : geofenceRadiusProblem(numbers.enter, numbers.exit);
  const unchanged =
    numbers.enter === geofence.enterRadiusMeters && numbers.exit === geofence.exitRadiusMeters;
  const busy = setPropertyGeofence.isPending || clearPropertyGeofence.isPending;

  const field = 'h-9 w-24 rounded-md border border-border bg-card px-2 text-sm text-foreground';

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Time on site</CardTitle>
        <CardDescription>
          How close a technician has to be for this property to count as visited. The hours on the
          Timesheet are read from these distances.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-muted-foreground flex flex-col gap-1 text-xs">
            Arrival within
            <span className="flex items-center gap-1">
              <input
                className={field}
                disabled={!canChange || busy}
                inputMode="numeric"
                onChange={(event) => setEnter(event.target.value)}
                value={enter}
              />
              <span className="text-foreground text-sm">m</span>
            </span>
          </label>
          <label className="text-muted-foreground flex flex-col gap-1 text-xs">
            Left after
            <span className="flex items-center gap-1">
              <input
                className={field}
                disabled={!canChange || busy}
                inputMode="numeric"
                onChange={(event) => setExit(event.target.value)}
                value={exit}
              />
              <span className="text-foreground text-sm">m</span>
            </span>
          </label>
          {canChange ? (
            <>
              <Button
                disabled={Boolean(problem) || unchanged || busy}
                onClick={() => {
                  setFailed(null);
                  setPropertyGeofence.mutate(
                    {
                      propertyId,
                      enterRadiusMeters: numbers.enter,
                      exitRadiusMeters: numbers.exit,
                    },
                    {
                      onSuccess: () => setSaved(`Saved: on site within ${numbers.enter}m.`),
                      onError: (error) =>
                        setFailed(error instanceof Error ? error.message : 'It did not save.'),
                    },
                  );
                }}
                size="sm"
              >
                {setPropertyGeofence.isPending ? 'Saving…' : 'Save'}
              </Button>
              {/*
                Only where there is something to undo. Offering it on a property
                already on the defaults would suggest the defaults were somebody's
                decision, which is the distinction `set` exists to keep.
              */}
              {geofence.set ? (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setFailed(null);
                    clearPropertyGeofence.mutate(
                      { propertyId },
                      {
                        onSuccess: (result) => {
                          setEnter(String(result.enterRadiusMeters));
                          setExit(String(result.exitRadiusMeters));
                          setSaved('Back to the standard distances.');
                        },
                        onError: (error) =>
                          setFailed(error instanceof Error ? error.message : 'It did not clear.'),
                      },
                    );
                  }}
                  size="sm"
                  variant="secondary"
                >
                  Use the standard distances
                </Button>
              ) : null}
            </>
          ) : null}
        </div>

        {/*
          The gap between the two numbers is the only thing somebody has to
          understand to set them sensibly, so it is said here rather than left
          to be discovered through a rejection.
        */}
        <p className="text-muted-foreground text-xs">
          The second distance has to be the larger one. A technician is on site once they are inside
          the first, and counted as gone only once they are past the second — the gap is what stops
          the clock starting and stopping while somebody stands near the edge of a driveway. Between{' '}
          {GEOFENCE_RADIUS_BOUNDS.minMeters} and {GEOFENCE_RADIUS_BOUNDS.maxMeters} metres.
        </p>

        {problem && canChange ? <p className="text-warning text-xs">{problem}</p> : null}
        {failed ? <p className="text-destructive text-xs">{failed}</p> : null}
        {!problem && saved ? <p className="text-muted-foreground text-xs">{saved}</p> : null}

        {!geofence.set ? (
          <p className="text-muted-foreground text-xs">
            Nobody has set this property’s own distances, so it uses the standard ones.
          </p>
        ) : null}
        {geofence.centreMoved ? (
          <p className="text-muted-foreground text-xs">
            The centre of this property’s circle has been moved off the geocoded pin. The map, the
            routing and the drive-time estimates still use the pin; only the time is measured from
            the moved centre.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
