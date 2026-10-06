/**
 * "605 Sorrento Dr · Nov 27": which job, in a technician's notification that it
 * was cancelled -- by the office, the lease schedule or Jobber (2026-10-07).
 * The inspection may be gone by the time the phone reads it, so the words
 * travel with the event.
 *
 * `scheduledAt` is a date, stored as that day's UTC midnight, so it is read in
 * UTC: in Texas time it would be the day before.
 */
export function jobInWords(property: string | null | undefined, scheduledAt: Date) {
  const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    scheduledAt,
  );
  return [property?.trim() || null, day].filter(Boolean).join(' · ');
}
