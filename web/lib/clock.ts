/**
 * Header clock formatting.
 *
 * Kept pure and separate from the component so the timezone behaviour — which
 * is the part that can silently go wrong — is testable without rendering.
 *
 * All conversion goes through `Intl.DateTimeFormat` with an IANA zone rather
 * than a fixed offset. Texas observes daylight saving, so the gap between the
 * two offices is 13 hours for part of the year and 14 for the rest; anything
 * hardcoded would be wrong for roughly half of it.
 */
export type ClockZone = {
  /** Stable key, also used as the React list key. */
  id: 'manila' | 'texas';
  /** Short label shown in the header. */
  label: string;
  /** Spoken label, so a screen reader is not left with "PH". */
  spokenLabel: string;
  timeZone: string;
};

export const CLOCK_ZONES: readonly ClockZone[] = [
  {
    id: 'manila',
    label: 'Manila',
    spokenLabel: 'Manila, Philippines',
    timeZone: 'Asia/Manila',
  },
  {
    id: 'texas',
    label: 'Texas',
    spokenLabel: 'Texas, United States',
    // Central Time. Note that far-west Texas (El Paso, Hudspeth County) is
    // Mountain Time — this is deliberately the zone the business runs on, not
    // a claim that the whole state shares it.
    timeZone: 'America/Chicago',
  },
];

export type ClockReading = {
  /** e.g. "1:40 AM" */
  time: string;
  /** e.g. "Fri, Jul 31" */
  date: string;
  /** e.g. "CDT" or "GMT+8" — makes a DST shift visible rather than silent. */
  abbreviation: string;
  /** Full sentence for assistive technology and the title tooltip. */
  description: string;
};

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) {
  return parts.find((entry) => entry.type === type)?.value ?? '';
}

export function readClock(now: Date, zone: ClockZone): ClockReading {
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: zone.timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(now);

  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: zone.timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(now);

  const abbreviation = part(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone.timeZone,
      timeZoneName: 'short',
    }).formatToParts(now),
    'timeZoneName',
  );

  return {
    time,
    date,
    abbreviation,
    description: `${zone.spokenLabel}: ${time} ${abbreviation}, ${date}`,
  };
}

/**
 * Milliseconds until the next minute boundary in the viewer's clock.
 *
 * The header shows minutes, so ticking every second would re-render sixty times
 * for fifty-nine no-ops. Scheduling to the boundary keeps the display correct
 * to the second it changes, at one render per minute.
 */
export function msUntilNextMinute(now: Date): number {
  return 60_000 - (now.getTime() % 60_000);
}

/**
 * The zone the business actually runs on.
 *
 * Every inspection is scheduled, worked and reported in Texas. The office that
 * *reads* the console is often in Manila, thirteen or fourteen hours ahead, so
 * "today" in a browser is routinely tomorrow in the field — and a schedule
 * shown a day early is not a cosmetic problem: it is a technician's roster and
 * an overdue flag.
 */
export const BUSINESS_TIME_ZONE = 'America/Chicago';

/**
 * The current business day as `yyyy-MM-dd`.
 *
 * Not the reader's day. `new Date().toLocaleDateString('en-CA')` answers the
 * calendar day of whoever is looking, which for a Manila evening is already
 * tomorrow in Texas — the technician map opened at 1am Manila showed the next
 * day's assignments and an empty roster.
 *
 * `en-CA` for the `yyyy-MM-dd` shape, with the zone pinned rather than left to
 * the browser. `toISOString` would be UTC and would roll a Texas evening over
 * early, which is the bug this replaced.
 */
export function businessToday(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: BUSINESS_TIME_ZONE });
}
