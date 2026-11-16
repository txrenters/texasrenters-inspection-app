/**
 * Actual vs Budget (2026-11-17): the office's revenue monitoring, kept until
 * now in "THMP Scheduling Actual Vs Budget 2026.xlsx", rebuilt in the console
 * "no more no less". This file is PR 1 of it: the technician log, one tab per
 * technician in the workbook, one row per visit and a Total row closing each
 * day.
 *
 * The office asked (2026-11-17) that "the cells that the console already know,
 * automate them but those that not yet, the office may add them". So a row is
 * a visit the console already has -- its day, address and Jobber job number,
 * the timesheet's arrival and leaving, whether it was completed, and its
 * invoice -- with the office's own entries laid over it. A cell the office has
 * typed stays as typed; one it has not shows what the console knows. A row the
 * console has no visit for (a job booked outside it) is the office's alone.
 *
 * The day totals follow the workbook's formulas, and the rules are here, pure,
 * so the page and the server add up the same way.
 */

/** Where an invoice line's amount goes in the log: the workbook's three money columns. */
export const REVENUE_COLUMNS = ['LABOR', 'SERVICE_CALL_FEE', 'MATERIALS'] as const;
export type RevenueColumn = (typeof REVENUE_COLUMNS)[number];

/** The workbook's headers for them. */
export const REVENUE_COLUMN_LABEL: Record<RevenueColumn, string> = {
  LABOR: 'Labor Hours Income',
  SERVICE_CALL_FEE: 'Service Call Fee',
  MATERIALS: 'Materials',
};

/** The longest stretch one read of a log may cover: a month and a little, as the monthly report needs. */
export const MAX_LOG_DAYS = 62;

/** "08:05", a time of day in Texas, as the office types an arrival. */
export const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The cells of a row, by the workbook's column. Each is what the office typed,
 * or, where it typed nothing, what the console knows -- `filled` says which.
 */
export interface RevenueLogCells {
  /** The visit's day in Texas, 2026-11-11. Column A, Date. */
  date: string;
  /** Column B, Address. */
  address: string | null;
  /** Column C, WO# (Propertyware's work order; the console cannot read it). */
  workOrder: string | null;
  /** Column D, Job# (Jobber's job number). */
  jobNumber: string | null;
  /** Column E, Drive Time, as the office writes it: "10–20 min", "Start", "0 min". */
  driveTime: string | null;
  /** Column F, Time Budgeted: "2 hrs", "30 mins". */
  timeBudgeted: string | null;
  /** Column G, Estimated Labor Revenue Budget. */
  estimatedBudgetCents: number | null;
  /** Column H, Arrival Time, "16:49" in Texas. */
  arrival: string | null;
  /** Column I, Time Leaving. */
  leaving: string | null;
  /** Column K, Is the Work Complete? */
  workComplete: boolean | null;
  /** Column L, Re-Schedule Required? */
  rescheduleRequired: boolean | null;
  /** Column M, Date For Re-schedule. */
  rescheduleOn: string | null;
  /** Columns N, O, P. */
  laborCents: number | null;
  serviceCallFeeCents: number | null;
  materialsCents: number | null;
  /** Column Q, Invoice #: "INV-5396", "8737/INV-2993", "N/A". */
  invoiceNumber: string | null;
  /** Column R, Date Posted in PW: a day, or the office's "N/A" / "TBD". */
  postedInPw: string | null;
  /** Column S, Issues/Notes. */
  notes: string | null;
}

export type RevenueLogField = keyof RevenueLogCells;

/** Where a cell the office did not type came from. */
export type RevenueLogSource = 'VISIT' | 'TIMESHEET' | 'INVOICE';

/** The cells the console can fill, and from where. Every other cell is the office's to type. */
export const CONSOLE_FILLED: Partial<Record<RevenueLogField, RevenueLogSource>> = {
  date: 'VISIT',
  address: 'VISIT',
  jobNumber: 'VISIT',
  workComplete: 'VISIT',
  arrival: 'TIMESHEET',
  leaving: 'TIMESHEET',
  invoiceNumber: 'INVOICE',
  laborCents: 'INVOICE',
  serviceCallFeeCents: 'INVOICE',
  materialsCents: 'INVOICE',
};

export interface RevenueLogRow extends RevenueLogCells {
  /** The visit's id, or the office's row's: stable across reads. */
  key: string;
  /** The visit the row is, or null for a row the office added. */
  inspectionId: string | null;
  /** The office's entry for the row, once it has typed anything. */
  entryId: string | null;
  /** Column J, Actual Time: leaving minus arrival, in seconds; null without both. */
  actualSeconds: number | null;
  /** Which cells show what the console knows, and from where. */
  filled: Partial<Record<RevenueLogField, RevenueLogSource>>;
  /** Which cells the office typed over something the console knows. */
  corrected: RevenueLogField[];
}

/** The Total row closing a day, as the workbook's formulas work it out. */
export interface RevenueLogTotals {
  driveTime: string;
  timeBudgeted: string;
  estimatedBudgetCents: number;
  actualSeconds: number;
  laborCents: number;
  serviceCallFeeCents: number;
  materialsCents: number;
}

export interface RevenueLogDay {
  date: string;
  rows: RevenueLogRow[];
  totals: RevenueLogTotals;
}

export interface RevenueLogTechnician {
  id: string;
  name: string;
}

export interface RevenueLog {
  technician: RevenueLogTechnician;
  from: string;
  to: string;
  days: RevenueLogDay[];
}

/** Who the log can be read for: everyone with a visit or a row in the stretch, and every technician. */
export interface RevenueLogTechnicians {
  technicians: RevenueLogTechnician[];
}

/**
 * What the office types into a row. A field left out is left as it is; a null
 * clears the office's entry, and the cell shows what the console knows again.
 */
export type SaveRevenueLogEntryInput = Partial<Omit<RevenueLogCells, 'date'>> & {
  /** The visit the row is; or, for a row of the office's own, its technician and day. */
  inspectionId?: string;
  technicianId?: string;
  date?: string;
};

/** A product's money column (2026-11-17): where its lines go in the log. */
export interface RevenueProductColumn {
  productId: string;
  name: string;
  column: RevenueColumn;
}

export interface RevenueProductColumns {
  products: RevenueProductColumn[];
}

export interface SaveRevenueProductColumnInput {
  column: RevenueColumn;
}

// ── The workbook's arithmetic ────────────────────────────────────────────────

const minutes = (text: string) => Number.parseInt(text, 10);

/**
 * One Drive Time as its low and high minutes. "10–20 min" is 10 and 20; "15
 * min" is 15 and 15; "Start", "0 min", blank and anything else are nothing.
 * The workbook's LET formula reads them the same way.
 */
export function driveTimeRange(value: string | null | undefined): { low: number; high: number } {
  const text = (value ?? '').replace(/[–—]/g, '-').toLowerCase();
  const range = /^\s*(\d+)\s*-\s*(\d+)\s*min/.exec(text);
  if (range) return { low: minutes(range[1]!), high: minutes(range[2]!) };
  const single = /^\s*(\d+)\s*min/.exec(text);
  if (single) return { low: minutes(single[1]!), high: minutes(single[1]!) };
  return { low: 0, high: 0 };
}

/** A day's Drive Time total: the lows added and the highs added, "60–95 min". */
export function driveTimeTotal(values: readonly (string | null | undefined)[]): string {
  let low = 0;
  let high = 0;
  for (const value of values) {
    const range = driveTimeRange(value);
    low += range.low;
    high += range.high;
  }
  return `${low}–${high} min`;
}

/**
 * One Time Budgeted in minutes, as the workbook reads it: "2 hrs" is 120, "30
 * mins" is 30, "2-3 hrs" is 120 to 180. Null for anything it cannot read.
 */
export function budgetedMinutes(value: string | null | undefined): { low: number; high: number } | null {
  const text = (value ?? '').replace(/[–—]/g, '-').toLowerCase().replace(/\s+/g, '');
  if (!text) return null;
  const range = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)(hrs?|hours?|mins?|minutes?)$/.exec(text);
  if (range) {
    const factor = range[3]!.startsWith('h') ? 60 : 1;
    return { low: Number(range[1]) * factor, high: Number(range[2]) * factor };
  }
  const single = /^(\d+(?:\.\d+)?)(hrs?|hours?|mins?|minutes?)$/.exec(text);
  if (!single) return null;
  const amount = Number(single[1]) * (single[2]!.startsWith('h') ? 60 : 1);
  return { low: amount, high: amount };
}

/** Minutes as the workbook writes them, "5h 40m"; minutes always two digits. */
export function hoursAndMinutes(totalMinutes: number): string {
  const whole = Math.max(0, Math.round(totalMinutes));
  return `${Math.floor(whole / 60)}h ${String(whole % 60).padStart(2, '0')}m`;
}

/**
 * A day's Time Budgeted total, "5h 40m", or "5h 40m – 6h 40m" when a range
 * makes it one; "-" when nothing in it can be read. A blank row is passed
 * over. (In the workbook a blank inside the formula's range turns the whole
 * total into "-", which only ever hid a day's total; the office's rows are
 * added either way.)
 */
export function timeBudgetedTotal(values: readonly (string | null | undefined)[]): string {
  let low = 0;
  let high = 0;
  let read = 0;
  for (const value of values) {
    const range = budgetedMinutes(value);
    if (!range) continue;
    low += range.low;
    high += range.high;
    read += 1;
  }
  if (!read) return '-';
  return low === high ? hoursAndMinutes(low) : `${hoursAndMinutes(low)} – ${hoursAndMinutes(high)}`;
}

/** "16:49" as minutes after midnight, or null. */
export function clockMinutes(value: string | null | undefined): number | null {
  if (!value || !CLOCK_TIME.test(value)) return null;
  const [hours, mins] = value.split(':');
  return Number(hours) * 60 + Number(mins);
}

/**
 * Column J, Actual Time: leaving minus arrival, carried over midnight as the
 * workbook's MOD(I-H,1) does. Null unless both are known.
 */
export function actualSeconds(arrival: string | null | undefined, leaving: string | null | undefined): number | null {
  const start = clockMinutes(arrival);
  const end = clockMinutes(leaving);
  if (start === null || end === null) return null;
  return (((end - start) % 1440) + 1440) % 1440 * 60;
}

/** A Total row: the workbook's formulas over the day's rows. */
export function revenueLogTotals(rows: readonly Pick<RevenueLogRow, 'driveTime' | 'timeBudgeted' | 'estimatedBudgetCents' | 'actualSeconds' | 'laborCents' | 'serviceCallFeeCents' | 'materialsCents'>[]): RevenueLogTotals {
  const sum = (pick: (row: (typeof rows)[number]) => number | null) => rows.reduce((total, row) => total + (pick(row) ?? 0), 0);
  return {
    driveTime: driveTimeTotal(rows.map((row) => row.driveTime)),
    timeBudgeted: timeBudgetedTotal(rows.map((row) => row.timeBudgeted)),
    estimatedBudgetCents: sum((row) => row.estimatedBudgetCents),
    actualSeconds: sum((row) => row.actualSeconds),
    laborCents: sum((row) => row.laborCents),
    serviceCallFeeCents: sum((row) => row.serviceCallFeeCents),
    materialsCents: sum((row) => row.materialsCents),
  };
}

/** Seconds as the workbook's [h]"h "mm"m": "4h 14m", "0h 16m". */
export const secondsAsHours = (seconds: number) => hoursAndMinutes(seconds / 60);

/** The stretch a log is read for, or what is wrong with it. */
export function logRangeProblem(from: string, to: string): string | null {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(from) || !day.test(to)) return 'Choose a first and a last day.';
  if (from > to) return 'The first day comes after the last.';
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (span > MAX_LOG_DAYS) return `Choose ${MAX_LOG_DAYS} days or fewer.`;
  return null;
}

// ── PR 2: the daily sheets ───────────────────────────────────────────────────
//
// Three of the workbook's tabs read one day across the technicians: "Next
// Day's Projected Productivity", the daily "ACTUAL VS PROJECTED REVENUE" and
// the "REVENUE TRACKER". Each technician's figures come from their log -- the
// day's Total row -- and the timesheet; the budgets and the remarks are the
// office's.

/** A regular day: past it, the hours are overtime ("Budgeted Daily Revenue (Regular 8 hour-work)"). */
export const REGULAR_DAY_SECONDS = 8 * 3600;

/** One technician on one day, as all three sheets read them. */
export interface RevenueDayTechnician {
  technician: RevenueLogTechnician;
  /** The usual: "Budgeted Daily Revenue (Regular 8 hour-work)", and the overtime rate. */
  dailyBudgetCents: number;
  otRateCents: number;
  /** The day's budget: the usual, or what the office typed for the day. */
  budgetCents: number;
  /** The log's Total row for the day. */
  driveTime: string;
  billableTime: string;
  projectedCents: number;
  /** The day's Labor Hours Income plus Service Call Fee; materials are not revenue. */
  actualCents: number;
  /** Tech's Work Time: the timesheet's hours, or the office's. Null when neither has any. */
  workSeconds: number | null;
  /** Which of these the office typed over what the console works out. */
  typed: { budget: boolean; work: boolean };
  projectionRemarks: string | null;
  dailyRemarks: string | null;
  trackerRemarks: string | null;
  /** The payroll period so far, through this day. */
  period: { regularSeconds: number; overtimeSeconds: number; budgetedCents: number; actualCents: number };
}

export interface RevenueDay {
  date: string;
  /** The payroll period the day falls in. */
  payrollPeriod: { from: string; to: string };
  technicians: RevenueDayTechnician[];
}

/** What the office types for a technician's day. Left out stays; null goes back to what the console works out. */
export interface SaveRevenueDayInput {
  budgetCents?: number | null;
  workSeconds?: number | null;
  projectionRemarks?: string | null;
  dailyRemarks?: string | null;
  trackerRemarks?: string | null;
}

/** Each technician's budget and overtime rate, and the payroll periods. */
export interface RevenueBudgets {
  payrollPeriodStart: string;
  payrollPeriodDays: number;
  technicians: { id: string; name: string; dailyBudgetCents: number | null; otRateCents: number | null }[];
}

export interface SaveRevenueBudgetsInput {
  payrollPeriodStart?: string;
  payrollPeriodDays?: number;
  /** A null budget takes the technician off the daily sheets. */
  technicians?: { technicianId: string; dailyBudgetCents: number | null; otRateCents: number | null }[];
}

/** Where the workbook's periods ran from: November 2-15, 2026, then every fortnight. */
export const DEFAULT_PAYROLL_PERIOD = { start: '2026-11-02', days: 14 } as const;

const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;
const dayText = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

/** The payroll period a day falls in, counting periods of `days` from `start` both ways. */
export function payrollPeriodOf(date: string, start: string, days: number): { from: string; to: string } {
  const offset = Math.floor((dayNumber(date) - dayNumber(start)) / days);
  const from = dayNumber(start) + offset * days;
  return { from: dayText(from), to: dayText(from + days - 1) };
}

/** "November 2-15", "November 30 - December 13": as the tracker's heading names its period. */
export function payrollPeriodWords(period: { from: string; to: string }): string {
  const month = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const date = (day: string) => Number(day.slice(8));
  return month(period.from) === month(period.to)
    ? `${month(period.from)} ${date(period.from)}-${date(period.to)}`
    : `${month(period.from)} ${date(period.from)} - ${month(period.to)} ${date(period.to)}`;
}

/** Tech's OT: the work past a regular day. */
export const overtimeSeconds = (workSeconds: number | null) => Math.max(0, (workSeconds ?? 0) - REGULAR_DAY_SECONDS);

/**
 * The revenue tracker's day for one technician, as the workbook works it out:
 * OT Budget Add-On = the rate x the overtime's hours (=85*183/60); Final Budget
 * = budget + add-on; Actual - Final Budget; % of Budget = actual / final budget.
 */
export function trackerFigures(row: Pick<RevenueDayTechnician, 'budgetCents' | 'otRateCents' | 'actualCents' | 'workSeconds'>) {
  const overtime = overtimeSeconds(row.workSeconds);
  const addOnCents = Math.round((row.otRateCents * overtime) / 3600);
  const finalBudgetCents = row.budgetCents + addOnCents;
  return {
    overtimeSeconds: overtime,
    addOnCents,
    finalBudgetCents,
    overCents: row.actualCents - finalBudgetCents,
    share: finalBudgetCents ? row.actualCents / finalBudgetCents : null,
  };
}

/** "5h 40m" (or the first of "6h 00m – 7h 00m") in minutes; nothing readable is none. */
export function hoursAndMinutesValue(text: string | null | undefined): number {
  const match = /(\d+)h\s*(\d+)m/.exec(text ?? '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

/** A share as the workbook writes it, 0.00%: "82.20%". */
export const percentText = (share: number | null) => (share === null || !Number.isFinite(share) ? '' : `${(share * 100).toFixed(2)}%`);
