'use client';

import type { AssignedStop, TechnicianDayTimeline } from '@texasrenters/shared';

import { businessTimeOfDay } from '@/lib/clock';
import { formatDuration } from '@/lib/format';
import { actualDayTotals, actualVisits } from '@/lib/route-plan';

/**
 * What a technician's day has come to, and when it is likely to end.
 *
 * The planner allocates in stop counts, so nothing in this system has ever
 * shown how long the work takes. These are measured from the location trail
 * rather than from when the paperwork was opened and submitted — a technician
 * who starts a form in the car and submits it from the next driveway produces
 * perfectly good timestamps describing a visit that did not happen that way.
 */

/** A number and what it is, which is the whole layout. */
function Figure({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <div
        className={`text-sm tabular-nums ${muted ? 'text-muted-foreground' : 'text-foreground'}`}
      >
        {value}
      </div>
      <div className="text-muted-foreground text-[11px] tracking-wide uppercase">{label}</div>
    </div>
  );
}

export function TechnicianDaySummary({
  timeline,
  stops = [],
}: {
  timeline: TechnicianDayTimeline;
  /** The day's inspections, whose start and submit times are the actual day. */
  stops?: readonly AssignedStop[];
}) {
  const { totals, projection } = timeline;
  // Preferred to the trail wherever the app recorded a start: the trail goes
  // quiet when a phone stops reporting, and the figures above the list must
  // agree with the ones in it.
  const actual = actualDayTotals(actualVisits(stops));

  // Nothing reported means nothing to describe. An empty card of zeroes reads
  // as "they did nothing today" rather than "nobody has heard from them".
  if (!totals.shiftSeconds && !actual)
    return (
      <p className="text-muted-foreground px-3 py-2 text-xs">
        No position reported today, so there is nothing to measure.
      </p>
    );

  /**
   * On-site and travelling need not add up to the shift.
   *
   * The difference is time the trail could not attribute to either — a silence
   * too long to call part of a visit and too long to call a drive. It is shown
   * rather than folded into whichever bucket was adjacent, because quietly
   * assigning it would make every figure here slightly untrue in a way nobody
   * could check.
   */
  const unaccounted = Math.max(0, totals.shiftSeconds - totals.onSiteSeconds - totals.travellingSeconds);

  /**
   * In Texas, whoever is reading.
   *
   * This was left to the browser, so the office in Manila read "6:49 AM" for a
   * day due to end at 5:49 PM in Houston. Null on a day that is not under way,
   * which has no finish to count toward from now.
   */
  const finish = businessTimeOfDay(projection.projectedFinishAt);

  return (
    <div className="space-y-2 border-b px-3 py-3">
      <div className="grid grid-cols-3 gap-2">
        <Figure
          label="On site"
          value={formatDuration(actual ? actual.onSiteSeconds : totals.onSiteSeconds)}
        />
        <Figure
          label="Driving"
          value={formatDuration(actual ? actual.driveSeconds : totals.travellingSeconds)}
        />
        <Figure
          label={(actual ? actual.visits : totals.visits) === 1 ? 'Visit' : 'Visits'}
          value={String(actual ? actual.visits : totals.visits)}
        />
      </div>

      {/* Only about the trail: with actual times there is nothing unaccounted
          to explain. */}
      {!actual && unaccounted > 60 ? (
        <p className="text-muted-foreground text-[11px]">
          {formatDuration(unaccounted)} unaccounted — the trail went quiet for longer than either a
          visit or a drive can explain.
        </p>
      ) : null}

      {projection.stopsRemaining || projection.current ? (
        <p className="text-xs">
          {finish ? (
            <>
              Projected finish <span className="tabular-nums">{finish}</span>
            </>
          ) : null}
          <span className="text-muted-foreground">
            {finish ? ' · ' : null}
            {/* The visit under way is not one of the stops left, so a last stop
                still in progress says so rather than "0 stops left". */}
            {projection.stopsRemaining
              ? `${projection.stopsRemaining} stop${projection.stopsRemaining === 1 ? '' : 's'} left`
              : 'on the last stop'}
            {/* Which number the projection leaned on. A day with nothing
                finished has nothing to measure, and a placeholder presented as
                derived is exactly the problem this feature exists to remove. */}
            {projection.basis === 'MEASURED'
              ? ` · ${formatDuration(projection.perVisitSeconds)} a visit, measured today`
              : ` · assuming ${formatDuration(projection.perVisitSeconds)} a visit`}
          </span>
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">No stops left to drive to.</p>
      )}

      {timeline.untimedInspectionIds.length ? (
        // Carried rather than dropped: "you have five stops and I can time
        // four" is worth saying, and a property that never geocoded is the
        // reason.
        <p className="text-muted-foreground text-[11px]">
          {timeline.untimedInspectionIds.length} stop
          {timeline.untimedInspectionIds.length === 1 ? '' : 's'} could not be timed — no
          coordinate to measure against.
        </p>
      ) : null}
    </div>
  );
}
