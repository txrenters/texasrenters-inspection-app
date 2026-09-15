/**
 * When a photograph was taken, how that is known, and how it is shown.
 *
 * Photographs are evidence a court may be shown, so their time is stored as
 * data with its provenance -- never burned into the picture -- and drawn onto
 * every view of it from that data. The original file stays exactly as it was
 * received, with a fingerprint to prove it.
 */

/**
 * The zone every stamp is printed in.
 *
 * The properties are in Texas and so is everyone reading the report; a stamp
 * in the reader's own zone would print a different time on the same photograph
 * for the office in Manila and the owner in Houston.
 */
export const PHOTO_STAMP_TIME_ZONE = 'America/Chicago';

/**
 * What a photograph's `capturedAt` rests on.
 *
 * - `DEVICE_CLOCK` -- the phone's clock at the shutter, as the app reported it.
 * - `DEVICE_UPLOAD_KEY` -- the phone's clock when the photo was saved, recovered
 *   from its upload key for photos taken before the app sent a capture time.
 *   Seconds after the shutter, not at it.
 * - `REPORT_STAMP` -- the timestamp printed on the photo in an imported report.
 * - `VIDEO_OFFSET` -- a recording's start plus the moment marked in it.
 * - `SERVER_RECEIPT` -- when the server received it; nothing better was known.
 */
export const PHOTO_CAPTURE_TIME_SOURCES = [
  'DEVICE_CLOCK',
  'DEVICE_UPLOAD_KEY',
  'REPORT_STAMP',
  'VIDEO_OFFSET',
  'SERVER_RECEIPT',
] as const;
export type PhotoCaptureTimeSource = (typeof PHOTO_CAPTURE_TIME_SOURCES)[number];

/**
 * How far past the server's receipt a phone may claim to have taken a photo.
 *
 * A capture cannot happen after its upload arrives, so a later claim is a
 * wrong phone clock. The allowance is the same two minutes location fixes are
 * given, for the same reason: phones that sync their clock are still a little
 * out.
 */
export const MAX_CAPTURE_CLOCK_AHEAD_MS = 2 * 60_000;

/**
 * A zone name the photo endpoint accepts: "America/Chicago", "Etc/GMT+5", "UTC".
 *
 * The same characters the server's upload validation allows. A photograph whose
 * zone failed that check would be refused outright, and a refusal is never
 * retried, so a phone checks before it sends.
 */
export const CAPTURE_TIME_ZONE_PATTERN = /^[A-Za-z0-9_+\-/]{1,64}$/;

/** What a phone reports about the moment its shutter fired. */
export interface PhotoCaptureClaim {
  /** The phone's clock at the shutter, as an instant. */
  capturedAt: string;
  /** Minutes east of UTC on the phone at that moment; Houston in summer is -300. */
  captureUtcOffsetMinutes: number;
  /** The phone's zone name, when it could say. */
  captureTimeZone?: string;
}

/**
 * The claim for a shutter at `atMs`, by the clock of the device running this.
 *
 * The zone is handed in rather than looked up: finding it needs `Intl`, and this
 * module loads on the phone, where zone lookups have crashed Hermes before. A
 * zone that does not look like a zone name is left out rather than sent, since
 * the server would refuse the photograph over it.
 */
export function photoCaptureClaim(atMs: number, timeZone?: string | null): PhotoCaptureClaim {
  const at = new Date(atMs);
  if (Number.isNaN(at.getTime())) throw new RangeError('A capture time has to be a real moment.');
  return {
    capturedAt: at.toISOString(),
    // getTimezoneOffset counts minutes *behind* UTC; `|| 0` turns UTC's -0 into 0.
    captureUtcOffsetMinutes: -at.getTimezoneOffset() || 0,
    ...(timeZone && CAPTURE_TIME_ZONE_PATTERN.test(timeZone) ? { captureTimeZone: timeZone } : {}),
  };
}

let stampFormat: Intl.DateTimeFormat | null | undefined;

/**
 * The stamp's formatter, built on first use and never at import.
 *
 * The mobile app bundles every module of this package, and its JavaScript
 * engine is not guaranteed to accept a named zone. A formatter built at import
 * that threw there would stop the app starting over a stamp it never draws;
 * built here, the worst case is a photograph with no stamp.
 */
function stampFormatter() {
  if (stampFormat === undefined) {
    try {
      stampFormat = new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        timeZone: PHOTO_STAMP_TIME_ZONE,
        timeZoneName: 'short',
      });
    } catch {
      stampFormat = null;
    }
  }
  return stampFormat;
}

/**
 * The stamp drawn on a photograph: "Sep 14, 2026, 1:22:07 PM CDT".
 *
 * Null when the time's provenance is unknown. Imported photographs were stored
 * with their report stamp read in whatever zone the importing machine happened
 * to be in -- UTC for most, not for all -- and printing one of those would put
 * a confidently wrong time on evidence. They get a stamp once their time has
 * been re-read from the report itself.
 */
export function formatPhotoStamp(
  capturedAt: string | Date | null | undefined,
  source: PhotoCaptureTimeSource | null | undefined,
): string | null {
  if (!capturedAt || !source) return null;
  const date = new Date(capturedAt);
  const format = stampFormatter();
  if (Number.isNaN(date.getTime()) || !format) return null;
  const stamp = format.format(date);
  return source === 'SERVER_RECEIPT' ? `Received ${stamp}` : stamp;
}

/** Where a photograph's time came from, in words for the people reviewing it. */
export function describePhotoCaptureTime(source: PhotoCaptureTimeSource | null | undefined) {
  switch (source) {
    case 'DEVICE_CLOCK':
      return "Taken, by the phone's clock";
    case 'DEVICE_UPLOAD_KEY':
      return "Saved on the phone, by its clock";
    case 'REPORT_STAMP':
      return "Taken, as stamped on the imported report";
    case 'VIDEO_OFFSET':
      return 'Taken, from the recording it was marked in';
    case 'SERVER_RECEIPT':
      return 'Received by the server; the capture time is not known';
    default:
      return 'Capture time not yet confirmed';
  }
}

/** Minutes a zone is ahead of UTC at an instant: -300 for Texas in summer. */
export function utcOffsetMinutes(at: Date, timeZone: string = PHOTO_STAMP_TIME_ZONE): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour') % 24, part('minute'), part('second'));
  return Math.round((wall - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/**
 * The instant a wall-clock time in a zone names.
 *
 * Resolved twice because the zone's offset depends on the instant being
 * sought: the first pass can land on the wrong side of a daylight-saving
 * change. In the hour the clocks go back, the earlier of the two instants.
 */
export function wallClockToInstant(
  wall: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timeZone: string = PHOTO_STAMP_TIME_ZONE,
): Date {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  let instant = naive - utcOffsetMinutes(new Date(naive), timeZone) * 60_000;
  instant = naive - utcOffsetMinutes(new Date(instant), timeZone) * 60_000;
  return new Date(instant);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A report photo's stamp, as Inspect & Cloud prints it: "Sep 02 2026 01:15:39 PM".
 *
 * Read as Texas wall-clock time, because that is what the camera printed. The
 * importer used to hand the text to `new Date()`, which reads it in the zone of
 * whatever machine runs the import: UTC in production, and not everywhere the
 * backfill was run. Null for anything that is not a real time in that form.
 */
export function parseReportPhotoStamp(
  text: string | null | undefined,
  timeZone: string = PHOTO_STAMP_TIME_ZONE,
): Date | null {
  const match = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s+([AP]M)$/i.exec(
    (text ?? '').trim(),
  );
  if (!match) return null;
  const [, monthName, day, year, hour12, minute, second, meridiem] = match;
  const month = MONTHS.indexOf(monthName!.toLowerCase()) + 1;
  const hour = Number(hour12);
  if (month < 1 || hour < 1 || hour > 12 || Number(minute) > 59 || Number(second) > 59) return null;
  const wall = {
    year: Number(year),
    month,
    day: Number(day),
    hour: (hour % 12) + (meridiem!.toUpperCase() === 'PM' ? 12 : 0),
    minute: Number(minute),
    second: Number(second),
  };
  const check = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
  if (check.getUTCMonth() !== wall.month - 1 || check.getUTCDate() !== wall.day) return null;
  return wallClockToInstant(wall, timeZone);
}
