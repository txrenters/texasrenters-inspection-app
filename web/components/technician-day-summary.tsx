'use client';

import type { TechnicianDayTimeline } from '@texasrenters/shared';

import { formatDuration } from '@/lib/format';

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

export function TechnicianDaySummary({ timeline }: { timeline: TechnicianDayTimeline }) {
  const { totals, projection } = timeline;

  // Nothing reported means nothing to describe. An empty card of zeroes reads
  // as "they did nothing today" rather than "nobody has heard from them".
  if (!totals.shiftSeconds)
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

  const finishAt = new Date(projection.projectedFinishAt);
  const finish = Number.isNaN(finishAt.getTime())
    ? null
    : finishAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  return (
    <div className="space-y-2 border-b px-3 py-3">
      <div className="grid grid-cols-3 gap-2">
        <Figure label="On site" value={formatDuration(totals.onSiteSeconds)} />
        <Figure label="Driving" value={formatDuration(totals.travellingSeconds)} />
        <Figure
          label={totals.visits === 1 ? 'Visit' : 'Visits'}
          value={String(totals.visits)}
        />
      </div>

      {unaccounted > 60 ? (
        <p className="text-muted-foreground text-[11px]">
          {formatDuration(unaccounted)} unaccounted — the trail went quiet for longer than either a
          visit or a drive can explain.
        </p>
      ) : null}

      {projection.stopsRemaining ? (
        <p className="text-xs">
          {finish ? (
            <>
              Projected finish <span className="tabular-nums">{finish}</span>
            </>
          ) : (
            'Projected finish unknown'
          )}
          <span className="text-muted-foreground">
            {' '}
            · {projection.stopsRemaining} stop{projection.stopsRemaining === 1 ? '' : 's'} left
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
