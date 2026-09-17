import type { Inspection } from '../domain/models';

type Clocked = Pick<Inspection, 'startedAt' | 'submittedAt'>;

/**
 * The job's clock, as the job screen shows it.
 *
 * One clock for the whole visit, which is what the office asked for
 * (2026-09-18): it starts when the technician presses Start job and stops when
 * they submit. Both stamps are the server's, so a handset whose own clock is
 * wrong still reports the time the office will read.
 */

/** "8 min", "1 h 04 m". Minutes, because nobody schedules to the second. */
export function formatWorked(minutes: number): string {
  // Negative is possible and not an error: the start is the server's stamp, and
  // a handset a minute behind it would otherwise count backwards.
  const whole = Math.max(0, Math.floor(minutes));
  if (whole < 60) return `${whole} min`;
  return `${Math.floor(whole / 60)} h ${String(whole % 60).padStart(2, '0')} m`;
}

export interface JobClock {
  /** Still running, so the label goes stale and has to be re-rendered. */
  running: boolean;
  /** How long it has run, or took: "8 min", "1 h 04 m". */
  worked: string;
  /** When it started, on the handset's clock: "9:12 AM". */
  startedAt: string;
}

const instant = (iso: string | undefined | null) => {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  return Number.isNaN(time) ? null : time;
};

/**
 * The clock for a job, or null for one nobody has started.
 *
 * Null is the ordinary case on a scheduled job, and the screen shows Start job
 * instead. A job submitted long ago reads the same way it did the moment it was
 * submitted, because both ends are then fixed.
 */
export function jobClock(job: Clocked, now: number = Date.now()): JobClock | null {
  const started = instant(job.startedAt);
  if (started === null) return null;
  const submitted = instant(job.submittedAt);
  return {
    running: submitted === null,
    worked: formatWorked(((submitted ?? now) - started) / 60_000),
    startedAt: new Date(started).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
  };
}

/**
 * The clock as one line for a screen reader.
 *
 * "Started 9:12 AM, running 34 min" while it runs, and "took" once it has been
 * submitted — a technician checking a finished job should not be told it is
 * still going.
 */
export function jobClockLabel(clock: JobClock): string {
  return `Started ${clock.startedAt}, ${clock.running ? 'running' : 'took'} ${clock.worked}`;
}
