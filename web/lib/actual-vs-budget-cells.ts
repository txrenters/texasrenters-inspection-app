import { secondsAsHours, type RevenueLogField, type RevenueLogRow, type SaveRevenueLogEntryInput } from '@texasrenters/shared';

/**
 * The technician log's cells as a spreadsheet (2026-11-17, the office: "design
 * it like a csv that there's an actual cell we can add entry on"). Every cell
 * shows and takes text in the workbook's own formats -- 11/11/2026, 5:36 PM,
 * 78.99, Yes -- and this turns that text into what the server stores.
 */

/** The cells in the workbook's order. `actualSeconds` is worked out, never typed. */
export type LogColumnField = RevenueLogField | 'actualSeconds';

export const LOG_COLUMNS: { field: LogColumnField; header: string; numeric?: boolean; wide?: boolean }[] = [
  { field: 'date', header: 'Date' },
  { field: 'address', header: 'Address', wide: true },
  { field: 'workOrder', header: 'WO#' },
  { field: 'jobNumber', header: 'Job#' },
  { field: 'driveTime', header: 'Drive Time' },
  { field: 'timeBudgeted', header: 'Time Budgeted' },
  { field: 'estimatedBudgetCents', header: 'Estimated Labor Revenue Budget', numeric: true },
  { field: 'arrival', header: 'Arrival Time', numeric: true },
  { field: 'leaving', header: 'Time Leaving', numeric: true },
  { field: 'actualSeconds', header: 'Actual Time', numeric: true },
  { field: 'workComplete', header: 'Is the Work Complete?' },
  { field: 'rescheduleRequired', header: 'Re-Schedule Required?' },
  { field: 'rescheduleOn', header: 'Date For Re-schedule' },
  { field: 'laborCents', header: 'Labor Hours Income', numeric: true },
  { field: 'serviceCallFeeCents', header: 'Service Call Fee', numeric: true },
  { field: 'materialsCents', header: 'Materials', numeric: true },
  { field: 'invoiceNumber', header: 'Invoice #' },
  { field: 'postedInPw', header: 'Date Posted in PW' },
  { field: 'notes', header: 'Issues/Notes', wide: true },
];

const MONEY = new Set<LogColumnField>(['estimatedBudgetCents', 'laborCents', 'serviceCallFeeCents', 'materialsCents']);
const CLOCK = new Set<LogColumnField>(['arrival', 'leaving']);
const CHOICE = new Set<LogColumnField>(['workComplete', 'rescheduleRequired']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// ── Showing ─────────────────────────────────────────────────────────────────

/** m/d/yyyy. */
export const sheetDate = (day: string | null) => {
  if (!day || !DAY.test(day)) return day ?? '';
  const [year, month, date] = day.split('-');
  return `${Number(month)}/${Number(date)}/${year}`;
};
/** h:mm AM/PM. */
export const sheetTime = (clock: string | null) => {
  if (!clock) return '';
  const [hours, minutes] = clock.split(':').map(Number) as [number, number];
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
};
/** _(* #,##0.00_): two decimals, a dash for zero, nothing for empty. */
export const sheetMoney = (cents: number | null) => {
  if (cents === null) return '';
  if (cents === 0) return '-';
  return (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
/** "$"#,##0: a day's revenue budget total in whole dollars. */
export const sheetWholeDollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;

/** A cell as the workbook writes it. */
export function cellText(row: Pick<RevenueLogRow, RevenueLogField | 'actualSeconds'>, field: LogColumnField): string {
  if (field === 'actualSeconds') return row.arrival && row.leaving ? secondsAsHours(row.actualSeconds ?? 0) : '';
  const value = row[field];
  if (value === null || value === undefined) return '';
  if (MONEY.has(field)) return sheetMoney(value as number);
  if (CLOCK.has(field)) return sheetTime(value as string);
  if (CHOICE.has(field)) return value ? 'Yes' : 'No';
  if (field === 'date' || field === 'rescheduleOn' || field === 'postedInPw') return sheetDate(value as string);
  return String(value);
}

// ── Reading what was typed ──────────────────────────────────────────────────

/** "11/11/2026", "11/11/26" or "2026-11-11" as a day; null for anything else. */
export function readDay(text: string): string | null {
  const value = text.trim();
  if (DAY.test(value)) return value;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value);
  if (!match) return null;
  const year = match[3]!.length === 2 ? `20${match[3]}` : match[3]!;
  const month = Number(match[1]);
  const date = Number(match[2]);
  if (month < 1 || month > 12 || date < 1 || date > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
}

/** "5:36 PM", "5:36pm", "17:36" as "17:36"; null for anything else. */
export function readClock(text: string): string | null {
  const value = text.trim().toLowerCase().replace(/\s+/g, '');
  const match = /^(\d{1,2}):(\d{2})(am|pm)?$/.exec(value);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59) return null;
  if (match[3]) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (match[3] === 'pm' ? 12 : 0);
  } else if (hours > 23) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** "78.99", "$1,078.99", "-" (zero) as cents; null for anything else. */
export function readCents(text: string): number | null {
  const value = text.trim().replace(/[$,\s]/g, '');
  if (value === '-') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  return Math.round(Number(value) * 100);
}

/**
 * What a typed cell saves: `{ value }`, where null clears the office's cell and
 * the console's value shows again; or `{ problem }` in words.
 */
export function readCell(field: RevenueLogField, text: string): { value: unknown } | { problem: string } {
  const value = text.trim();
  const header = LOG_COLUMNS.find((column) => column.field === field)?.header ?? field;
  if (!value) return { value: null };
  if (MONEY.has(field)) {
    const cents = readCents(value);
    return cents === null ? { problem: `${header}: type an amount, like 78.99.` } : { value: cents };
  }
  if (CLOCK.has(field)) {
    const clock = readClock(value);
    return clock === null ? { problem: `${header}: type a time, like 5:36 PM.` } : { value: clock };
  }
  if (CHOICE.has(field)) {
    if (/^(y|yes)$/i.test(value)) return { value: true };
    if (/^(n|no)$/i.test(value)) return { value: false };
    return { problem: `${header}: type Yes or No.` };
  }
  if (field === 'date' || field === 'rescheduleOn') {
    const day = readDay(value);
    return day === null ? { problem: `${header}: type a date, like 11/11/2026.` } : { value: day };
  }
  // The office also writes "N/A" and "TBD" here, so a date is kept as one and anything else as written.
  if (field === 'postedInPw') return { value: readDay(value) ?? value };
  return { value };
}

/** Whether a typed cell says something different from what the row shows. */
export function changes(row: Pick<RevenueLogRow, RevenueLogField>, field: RevenueLogField, value: unknown): boolean {
  return (row[field] ?? null) !== value;
}

/** The cells of a new row, read all at once; the first problem, if any. */
export function readRow(texts: Partial<Record<RevenueLogField, string>>): { input: SaveRevenueLogEntryInput } | { problem: string } {
  const input: Record<string, unknown> = {};
  for (const [field, text] of Object.entries(texts) as [RevenueLogField, string][]) {
    if (!text?.trim()) continue;
    const read = readCell(field, text);
    if ('problem' in read) return read;
    input[field] = read.value;
  }
  return { input: input as SaveRevenueLogEntryInput };
}
