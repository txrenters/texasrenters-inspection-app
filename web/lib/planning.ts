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

export type LimitState = 'within' | 'near' | 'over';

/**
 * How a day stands against one of the office's limits.
 *
 * Near is the last tenth: a day at 85 of 90 minutes is inside the rule and one
 * slow junction from outside it, which is worth seeing before it is published.
 */
export function limitState(value: number, limit: number): LimitState {
  if (value > limit) return 'over';
  return limit > 0 && value >= limit * 0.9 ? 'near' : 'within';
}

/** "Q4 2026". */
export const quarterName = (year: number, quarter: number) => `Q${quarter} ${year}`;

/** `2026-4`, the quarter's key in the address bar. */
export const quarterKey = (year: number, quarter: number) => `${year}-${quarter}`;

export interface QuarterChoice {
  key: string;
  year: number;
  quarter: number;
  label: string;
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
