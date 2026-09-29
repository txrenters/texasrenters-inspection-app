/**
 * How far back a phone's own Start job time is believed.
 *
 * A start can reach the server late: the phone saves it the moment Start job
 * is pressed and sends it when it can, so a technician who starts a job in a
 * basement, or closes the app before the request lands, has it delivered on
 * the next launch (the office, 2026-09-29: "job should continue even if we
 * close the app entirely, time should continue too"). Stamping the arrival
 * would cut the time the office reads off the front of the job.
 *
 * Bounded, because it is the phone's clock: a day covers any job and any
 * delivery delay worth honouring, and a claim older than that is a wrong clock
 * rather than a long job.
 */
export const JOB_START_TRUST_WINDOW_MS = 24 * 60 * 60_000;

/** The start to record: the phone's, when it is believable, and now otherwise. */
export function jobStartTime(claimed: string | undefined, now: Date): Date {
  if (!claimed) return now;
  const at = new Date(claimed);
  if (Number.isNaN(at.getTime())) return now;
  // A phone whose clock runs ahead cannot start a job in the future.
  if (at.getTime() > now.getTime()) return now;
  if (now.getTime() - at.getTime() > JOB_START_TRUST_WINDOW_MS) return now;
  return at;
}
