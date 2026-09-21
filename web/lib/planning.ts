import { dayVisitRange, planStartRange, quarterFirstDay, type Quarter } from '@texasrenters/shared';

/**
 * The arithmetic and reading behind the benefit-package plan page.
 *
 * Pure, so a day's clock times, the limit a day is measured against and the
 * office's sheet can be tested without rendering a page or calling the API.
 */

/** When a planned day starts: the first job at nine, as the planner assumes when it asks Google. */
export const DAY_STARTS_AT_MINUTES = 9 * 60;

export interface TimedStop {
  onSiteMinutes: number | null;
  /** The drive from the stop before, in seconds. Null for the first stop, or when nothing measured it. */
  driveSecondsForecast: number | null;
}

export interface StopClock {
  /** Minutes after midnight. */
  arrives: number;
  leaves: number;
  /** Minutes driven to reach it. */
  driveMinutes: number;
}

/**
 * A planned day as a clock: when each stop is reached and left.
 *
 * Arithmetic on the plan's own forecast -- the measured drive between stops and
 * each visit's length -- starting at nine. It says when the day would run if
 * everything took as long as planned, which is what a coordinator checks a day
 * against, and nothing about live traffic.
 */
export function dayClock<T extends TimedStop>(stops: readonly T[], startsAt = DAY_STARTS_AT_MINUTES): (T & StopClock)[] {
  let clock = startsAt;
  return stops.map((stop, index) => {
    const driveMinutes = index === 0 ? 0 : Math.round((stop.driveSecondsForecast ?? 0) / 60);
    clock += driveMinutes;
    const arrives = clock;
    clock += stop.onSiteMinutes ?? 0;
    return { ...stop, arrives, leaves: clock, driveMinutes };
  });
}

/**
 * When to leave home to reach the day's first property on time.
 *
 * The drive from home is measured for the same nine o'clock start as the rest
 * of the day, so this is a forecast, not a promise about the morning's traffic.
 */
export function leaveHomeAt(firstArrives: number, homeDriveSeconds: number): number {
  return firstArrives - Math.round(homeDriveSeconds / 60);
}

/** "9:05 AM". */
export function formatClock(minutesAfterMidnight: number): string {
  const total = ((Math.round(minutesAfterMidnight) % 1440) + 1440) % 1440;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** "45 min", "6 hr", "5 hr 30 min" -- the units `formatDuration` writes a drive in. */
export function formatMinutes(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes));
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

const SHORT_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "Oct 12" for `2026-10-12`. A calendar date, so read in UTC: in Manila, local time would show the day before. */
export const formatShortDay = (date: string) => SHORT_DAY.format(new Date(`${date}T00:00:00Z`));

interface MeasuredLegs {
  stops: readonly { driveSecondsForecast: number | null }[];
  anchors?: readonly { driveSecondsForecast: number | null }[];
}

/**
 * The longest measured drive from one of a day's stops to the next, in seconds,
 * or null when none was measured. The drive from home is not one of them.
 */
export function longestLegSeconds(day: MeasuredLegs): number | null {
  const legs = [...day.stops, ...(day.anchors ?? [])]
    .map((stop) => stop.driveSecondsForecast)
    .filter((seconds): seconds is number => seconds !== null);
  return legs.length ? Math.max(...legs) : null;
}

/** Whether a drive between two properties is longer than the plan allows (the office, 2026-09-19: twenty minutes). */
export const legOverLimit = (seconds: number | null, maxLegMinutes: number) =>
  seconds !== null && Math.round(seconds / 60) > maxLegMinutes;

/**
 * A day outside the office's rules: more visits than a day may hold, more time
 * inspecting than a day holds, or a drive from one property to the next longer
 * than the plan allows.
 *
 * Twelve visits at most, three fewer for each move-out or move-in the day is
 * built around (`dayVisitRange`, 2026-09-18), and never more than twenty
 * minutes between properties (2026-09-19). A day of fewer than nine is inside
 * them: the planner makes one only where the properties are too far apart for
 * more, and the office fills it as it likes.
 */
export function dayOutsideRules(
  day: MeasuredLegs & { stopCount: number; onSiteMinutes: number },
  rules: { minStopsPerDay: number; maxStopsPerDay: number; maxOnSiteMinutes: number; maxLegMinutes: number },
) {
  const range = dayVisitRange(rules, day.anchors?.length ?? 0);
  return (
    day.stopCount > range.max ||
    day.onSiteMinutes > rules.maxOnSiteMinutes ||
    legOverLimit(longestLegSeconds(day), rules.maxLegMinutes)
  );
}

/** One of the three starts the office picks between when a quarter is built, and what it means. */
export interface PlanStartOption {
  value: 'EARLY' | 'ON_TIME' | 'LATE' | 'KEPT';
  label: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Before today: the plan starts on it, and the days already gone are skipped. */
  past: boolean;
}

/**
 * The starts a quarter can be built from: fifteen days early, on time, or
 * fifteen days late (the office, 2026-09-19: "the +-15 days ... if we will apply
 * the +15 or -15 or on time quarter schedule").
 *
 * A start already past is still offered -- the plan begins from it and the days
 * gone are simply not planned -- so a quarter can still be started as soon as
 * possible. A plan built from some other day keeps that day as a fourth choice,
 * so rebuilding never moves it by accident.
 */
export function planStartOptions(quarter: Quarter, startsOn: string | null | undefined, today: string): PlanStartOption[] {
  const { earliest, latest } = planStartRange(quarter);
  const option = (value: PlanStartOption['value'], label: string, date: string): PlanStartOption => ({
    value,
    label,
    date,
    past: date < today,
  });
  const choices = [
    option('EARLY', '15 days early', earliest),
    option('ON_TIME', 'On time', quarterFirstDay(quarter)),
    option('LATE', '15 days late', latest),
  ];
  const kept = startsOn?.slice(0, 10);
  return kept && !choices.some((choice) => choice.date === kept) ? [...choices, option('KEPT', 'As built', kept)] : choices;
}

/** Which start a plan is on now: its own day, or on time for a plan not built yet. */
export function planStartValue(options: readonly PlanStartOption[], startsOn: string | null | undefined): PlanStartOption['value'] {
  const kept = startsOn?.slice(0, 10);
  return (kept && options.find((option) => option.date === kept)?.value) || 'ON_TIME';
}

/** "Sep 21, 10 days before the quarter", or the quarter's own first day. */
export function planStartText(quarter: Quarter, startsOn: string | null | undefined): string {
  const first = quarterFirstDay(quarter);
  const start = startsOn?.slice(0, 10) ?? first;
  const days = Math.round((Date.parse(`${first}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
  if (days === 0) return `${formatShortDay(start)}, the quarter's first day`;
  return `${formatShortDay(start)}, ${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'} ${days > 0 ? 'before' : 'after'} the quarter's first`;
}

/**
 * The move-outs and move-ins in a list, in words: "a move-out", "2 move-outs
 * and a move-in". `count` writes a single one as "1 move-out", `bare` as
 * "move-out".
 */
export function bookedInWords(anchors: readonly { kind: 'MOVE_OUT' | 'MOVE_IN' }[], style: 'article' | 'count' | 'bare' = 'article') {
  const part = (count: number, noun: string) =>
    count === 0 ? null : count > 1 || style === 'count' ? `${count} ${noun}${count > 1 ? 's' : ''}` : style === 'article' ? `a ${noun}` : noun;
  const outs = anchors.filter((anchor) => anchor.kind === 'MOVE_OUT').length;
  return [part(outs, 'move-out'), part(anchors.length - outs, 'move-in')].filter(Boolean).join(' and ');
}

/**
 * A visit that has a day but not yet a door: its building has several units and
 * nothing has said which is its (the office, 2026-09-18). Publishing waits for it.
 */
export const needsUnit = (stop: { status: string; unitResolution: string }) =>
  stop.status === 'PLANNED' && stop.unitResolution === 'UNRESOLVED';

/** What a visit waiting for its unit says, wherever it is listed. */
export const NEEDS_UNIT_MESSAGE =
  'Choose its unit before publishing: the building has several, and Propertyware does not say which this tenancy is in.';

/** What a visit needing attention is waiting for, and how it is drawn on the map. */
export type AttentionKind = 'NO_DAY' | 'NO_TECHNICIAN' | 'NEEDS_UNIT' | 'KIND_TO_CHECK' | 'FAILED';

export interface AttentionStop {
  status: string;
  unitResolution: string;
  scheduledOn: string | null;
  assignedTechnicianId: string | null;
  inspectionTypeNeedsReview: boolean;
}

const ATTENTION_TEXT: Record<AttentionKind, string> = {
  NO_DAY: 'No day yet',
  NO_TECHNICIAN: 'No technician yet',
  NEEDS_UNIT: 'Needs its unit',
  KIND_TO_CHECK: 'Kind of visit to check',
  FAILED: 'Publishing failed',
};

/**
 * What a visit is waiting for, or null when it is waiting for nothing.
 *
 * The office asked to see these on a map, as Jobber shows its unscheduled
 * appointments (2026-09-20): "kaning naka needs attention pwede nato ni ma latag
 * tanan sa map para makita ni sila asa dapita?" -- so the first thing a visit is
 * missing is the one named, the day before the technician.
 */
export function attentionOf(stop: AttentionStop): AttentionKind | null {
  // Unscheduled is Jobber's to schedule now, not the office's to fix here.
  if (stop.status === 'EXCLUDED' || stop.status === 'PUBLISHED' || stop.status === 'UNSCHEDULED') return null;
  if (stop.status === 'FAILED') return 'FAILED';
  if (!stop.scheduledOn) return 'NO_DAY';
  if (!stop.assignedTechnicianId) return 'NO_TECHNICIAN';
  if (needsUnit(stop)) return 'NEEDS_UNIT';
  if (stop.inspectionTypeNeedsReview) return 'KIND_TO_CHECK';
  return null;
}

/** The same, in the words the map and the list use. */
export const attentionText = (kind: AttentionKind) => ATTENTION_TEXT[kind];

export type LimitState = 'within' | 'near' | 'over';

/**
 * How a day stands against one of the office's limits.
 *
 * Near is the last tenth: a day at 5 hr 30 min of 6 hr inspecting is inside the
 * rule and one long visit from outside it, which is worth seeing before it is
 * published.
 */
export function limitState(value: number, limit: number): LimitState {
  if (value > limit) return 'over';
  return limit > 0 && value >= limit * 0.9 ? 'near' : 'within';
}

/** "Q4 2026". */
export const quarterName = (year: number, quarter: number) => `Q${quarter} ${year}`;

/**
 * The quarter a day falls in, as the office writes it: "Q3 2026".
 *
 * Read in UTC, like every other day in this console: a visit's day is a date,
 * and reading it locally would move it across a quarter boundary for anyone
 * east of Texas.
 */
export function quarterOf(day: string | Date | null | undefined): string {
  if (!day) return '';
  const at = typeof day === 'string' ? new Date(day) : day;
  if (Number.isNaN(at.getTime())) return '';
  return quarterName(at.getUTCFullYear(), Math.floor(at.getUTCMonth() / 3) + 1);
}

/**
 * The quarter after this one, the one under way, and the six before it.
 *
 * The next quarter is offered because its visits exist before it starts: a
 * plan may be built and published fifteen days early, which on 2026-09-21 had
 * already put 55 Q4 visits on the calendar while the list offered nothing
 * newer than Q3 (the office: "Q4 2026 is not there").
 */
export function recentQuarters(today: Date = new Date()): string[] {
  let year = today.getUTCFullYear();
  let quarter = Math.floor(today.getUTCMonth() / 3) + 1;
  quarter += 1;
  if (quarter === 5) {
    quarter = 1;
    year += 1;
  }
  const quarters: string[] = [];
  for (let step = 0; step < 8; step += 1) {
    quarters.push(quarterName(year, quarter));
    quarter -= 1;
    if (quarter === 0) {
      quarter = 4;
      year -= 1;
    }
  }
  return quarters;
}

/** `2026-4`, the quarter's key in the address bar. */
export const quarterKey = (year: number, quarter: number) => `${year}-${quarter}`;

export interface QuarterChoice {
  key: string;
  year: number;
  quarter: number;
  label: string;
  /**
   * The quarter has already begun.
   *
   * A quarter is planned before it starts -- that is what the fifteen days
   * either side are for -- so one already under way with no plan was run
   * somewhere else, and its visits are inspections. Building a plan now would
   * lay today's tenancies over days that have passed. The office opened Q3
   * looking for visits a Jobber backfill had just brought in, and was offered
   * "Build the Q3 2026 plan" (2026-09-21).
   */
  started: boolean;
}

/**
 * The quarters a coordinator can open: every plan there is, the quarter under
 * way, and the one coming -- newest first, the coming one before the rest.
 */
export function quarterChoices(
  plans: readonly { quarterYear: number; quarterNumber: number }[],
  today: Date,
): QuarterChoice[] {
  const year = today.getUTCFullYear();
  const current = Math.floor(today.getUTCMonth() / 3) + 1;
  const next = current === 4 ? { year: year + 1, quarter: 1 } : { year, quarter: current + 1 };
  const all = [next, { year, quarter: current }, ...plans.map((plan) => ({ year: plan.quarterYear, quarter: plan.quarterNumber }))];
  const seen = new Set<string>();
  return all
    .filter((entry) => {
      const key = quarterKey(entry.year, entry.quarter);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => right.year - left.year || right.quarter - left.quarter)
    .map((entry) => ({
      key: quarterKey(entry.year, entry.quarter),
      year: entry.year,
      quarter: entry.quarter,
      label: quarterName(entry.year, entry.quarter),
      started: entry.year < year || (entry.year === year && entry.quarter <= current),
    }));
}

/**
 * Rows and fields from CSV text, quotes and all.
 *
 * The office's sheet comes out of a spreadsheet, where a cell holding a comma,
 * a quote or a line break is quoted and its quotes doubled. Splitting on commas
 * would cut "Filter Change: 20x25x1, 16x25x1 + ..." into two columns.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  // A spreadsheet saves UTF-8 with a byte-order mark, which would otherwise be read into the first column's name.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += character;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface OfficeSheetRow {
  address: string;
  city: string | null;
  postalCode: string | null;
  details: string;
}

export interface OfficeSheet {
  rows: OfficeSheetRow[];
  /** Rows with no address or no Details, which give the plan nothing to use. */
  skipped: number;
  /** The columns the sheet has to have and does not, in words. */
  missing: string[];
}

/** The column names the office's Jobber import sheet uses, and the other spellings a sheet might. */
const COLUMNS = {
  address: ['street1', 'property address', 'address', 'street', 'street address'],
  city: ['city'],
  postalCode: ['zip', 'zip code', 'postal code', 'postcode'],
  details: ['instruction', 'instructions', 'details', 'visit details'],
} as const;

/**
 * The office's sheet of visit Details, read.
 *
 * Its own Jobber import sheet: "Street1", "City", "Zip" and "Instruction", one
 * row per property. Columns are found by name, so a sheet saved with its
 * columns in another order still reads.
 */
export function readOfficeSheet(text: string): OfficeSheet {
  const table = parseCsv(text).filter((row) => row.some((cell) => cell.trim()));
  const header = (table[0] ?? []).map((cell) => cell.trim().toLowerCase());
  // In the order the names are listed: the sheet has both "Property Address"
  // and "Street1", and Street1 is the one Jobber imports.
  const column = (names: readonly string[]) => {
    for (const name of names) if (header.includes(name)) return header.indexOf(name);
    return -1;
  };
  const at = {
    address: column(COLUMNS.address),
    city: column(COLUMNS.city),
    postalCode: column(COLUMNS.postalCode),
    details: column(COLUMNS.details),
  };
  const missing = [
    at.address < 0 ? 'an address column (Street1)' : null,
    at.details < 0 ? 'a Details column (Instruction)' : null,
  ].filter((entry): entry is string => entry !== null);
  if (missing.length) return { rows: [], skipped: 0, missing };

  const cell = (row: string[], index: number) => (index < 0 ? '' : (row[index] ?? '').trim());
  let skipped = 0;
  const rows: OfficeSheetRow[] = [];
  for (const row of table.slice(1)) {
    const address = cell(row, at.address);
    const details = cell(row, at.details);
    if (!address || !details) {
      skipped += 1;
      continue;
    }
    rows.push({
      address,
      city: cell(row, at.city) || null,
      postalCode: cell(row, at.postalCode) || null,
      details,
    });
  }
  return { rows, skipped, missing };
}
