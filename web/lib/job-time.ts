import { businessTimeOfDay } from './clock';
import { formatDuration } from './format';

/**
 * How long a technician was on a job.
 *
 * The handset stamps `startedAt` when Start job is pressed and `submittedAt`
 * when the work is submitted, so this is the technician's own clock rather than
 * anything inferred from photographs or locations. One clock for the whole
 * visit, which is what the office asked for (2026-09-18).
 *
 * Times are read in Texas, like every other time in this console: whoever is
 * looking may be in another hemisphere, and "9:12 AM" has to mean the morning
 * the technician was there.
 */

export interface JobWorked {
  /** "1 hr 4 min". */
  worked: string;
  /** Still out on it: the total is only as of now. */
  running: boolean;
  /** "9:12 AM – 10:16 AM", or "from 9:12 AM" while it runs. */
  window: string;
}

const instant = (value: string | null | undefined) => {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
};

/** Null for a job nobody started, which is not the same as one that took no time. */
export function jobWorked(
  job: { startedAt?: string | null; submittedAt?: string | null },
  now: number = Date.now(),
): JobWorked | null {
  const started = instant(job.startedAt);
  if (started === null) return null;
  const submitted = instant(job.submittedAt);
  const from = businessTimeOfDay(job.startedAt);
  return {
    // Clamped at zero: the stamps come from the server, but a submission
    // recorded before its start would otherwise read as negative time.
    worked: formatDuration(Math.max(0, (submitted ?? now) - started) / 1000),
    running: submitted === null,
    window: submitted === null ? `from ${from}` : `${from} – ${businessTimeOfDay(job.submittedAt)}`,
  };
}

/**
 * How long the inspection itself took, apart from the job's other tasks.
 *
 * The server reads it from the evidence (its first photograph or recording to
 * its last), because the inspection has no button of its own to time it by. So
 * it leaves out walking in before the first room and packing up after the last.
 */
export function inspectionTime(
  span: { from: string; to: string } | null | undefined,
): string | null {
  if (!span) return null;
  const from = new Date(span.from).getTime();
  const to = new Date(span.to).getTime();
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return null;
  return formatDuration((to - from) / 1000);
}
