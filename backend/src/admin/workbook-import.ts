import { monthWeeks } from '@texasrenters/shared';

import { technicianLog, type WorkbookSheet } from './workbook-reader';

/**
 * Everything the office's workbook holds for the technicians still working
 * (2026-11-17, the office: "I want all the data imported too"), read from the
 * text each cell showed: every visit row of each technician's tab, each
 * technician's budget, the remarks on the projection, daily and tracker tabs,
 * and the weekly and monthly reports. Only the days before the import count:
 * for those the workbook's cells win over the console's (the office's choice);
 * from the import on, the console fills the cells as before.
 *
 * Pure: the service matches what this finds to technicians and visits.
 */

/** A log row's cells, in the console's names; null is "the workbook left it blank". */
export interface ImportedLogCells {
  address: string | null;
  workOrder: string | null;
  jobNumber: string | null;
  driveTime: string | null;
  timeBudgeted: string | null;
  estimatedBudgetCents: number | null;
  arrival: string | null;
  leaving: string | null;
  workComplete: boolean | null;
  rescheduleRequired: boolean | null;
  rescheduleOn: string | null;
  laborCents: number | null;
  serviceCallFeeCents: number | null;
  materialsCents: number | null;
  invoiceNumber: string | null;
  postedInPw: string | null;
  notes: string | null;
}

export interface ImportedLogRow {
  date: string;
  cells: ImportedLogCells;
}

export interface ImportedLog {
  /** The tab's name: the technician's first name. */
  tab: string;
  rows: ImportedLogRow[];
  /** Rows with something typed but no day the console could read. */
  undated: number;
  /** Rows dated today or later: the console's own. */
  notPast: number;
}

export type ImportedDayField = 'budgetCents' | 'workSeconds' | 'projectionRemarks' | 'dailyRemarks' | 'trackerRemarks';

export interface ImportedDayCell {
  name: string;
  date: string;
  field: ImportedDayField;
  value: string | number;
}

export interface ImportedWeek {
  name: string;
  weekStart: string;
  /** Null when the week is not over: its figures are still the console's to work out. */
  targetCents: number | null;
  actualCents: number | null;
  remarks: string | null;
}

export interface ImportedMonth {
  name: string;
  month: string;
  remarks: string | null;
}

export interface ImportedWorkbook {
  logs: ImportedLog[];
  /** From the newest revenue tracker: each technician's Budgeted Daily Revenue. */
  budgets: { name: string; dailyBudgetCents: number }[];
  days: ImportedDayCell[];
  weeks: ImportedWeek[];
  months: ImportedMonth[];
}

// ── Reading a cell's text ───────────────────────────────────────────────────

const MAX_TEXT = 1000;
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (value: number) => String(value).padStart(2, '0');

export function text(cell: string | undefined): string | null {
  const value = (cell ?? '').trim();
  return value ? value.slice(0, MAX_TEXT) : null;
}

/** "11/16/2026", "16-Nov-26", or a day's serial number as Excel keeps it. */
export function dayFrom(cell: string | undefined, yearHint?: number): string | null {
  const value = (cell ?? '').trim();
  let match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value);
  if (match) return isoDay(Number(match[3]!.length === 2 ? `20${match[3]}` : match[3]), Number(match[1]), Number(match[2]));
  match = /^(\d{1,2})-([A-Za-z]{3})(?:-(\d{2}|\d{4}))?$/.exec(value);
  if (match) {
    const month = MONTH_NAMES.indexOf(match[2]!.toLowerCase()) + 1;
    const year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : yearHint;
    return month && year ? isoDay(year, month, Number(match[1])) : null;
  }
  if (/^\d{5}(\.\d+)?$/.test(value)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(value)) * 86_400_000);
    return date.toISOString().slice(0, 10);
  }
  return null;
}

function isoDay(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Dollars as any of the workbook's formats show them, in cents; "-" is the accounting zero. Never negative. */
export function centsFrom(cell: string | undefined): number | null {
  const value = (cell ?? '').trim();
  if (!value) return null;
  if (/^\$?\s*-$/.test(value)) return 0;
  const negative = /^\(.*\)$/.test(value) || /^-/.test(value);
  const digits = value.replace(/[$,()\s]/g, '').replace(/^-/, '');
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  if (negative) return null;
  return Math.round(Number(digits) * 100);
}

/** "8:44 AM", "16:49", "8:44:00 pm": the clock time as the console keeps it, "08:44". */
export function clockFrom(cell: string | undefined): string | null {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp]\.?[Mm]\.?)?$/.exec((cell ?? '').trim());
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const half = match[3]?.[0]?.toLowerCase();
  if (half) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (half === 'p' ? 12 : 0);
  }
  if (hours > 23 || minutes > 59) return null;
  return `${pad(hours)}:${pad(minutes)}`;
}

export function yesNo(cell: string | undefined): boolean | null {
  const value = (cell ?? '').trim().toLowerCase();
  if (value === 'yes' || value === 'y' || value === 'true') return true;
  if (value === 'no' || value === 'n' || value === 'false') return false;
  return null;
}

/** "8h 25m", "8:25", "11h 3m": hours worked, in seconds. */
export function secondsFrom(cell: string | undefined): number | null {
  const value = (cell ?? '').trim();
  let match = /^(\d+)\s*h(?:\s*(\d+)\s*m)?$/i.exec(value);
  if (match) return Number(match[1]) * 3600 + Number(match[2] ?? 0) * 60;
  match = /^(\d+):(\d{2})$/.exec(value);
  if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60;
  return null;
}

const cellsOfRow = (sheet: WorkbookSheet, row: number) => sheet.rows.get(row) ?? new Map<string, string>();
const lower = (value: string | undefined) => (value ?? '').trim().toLowerCase();

/** The first day written anywhere in a tab's first rows: "DATE:11/16/2026", "Date: 11/11/2026", or a date cell. */
function dateNear(sheet: WorkbookSheet, upTo: number): string | null {
  for (let row = 1; row <= upTo; row++)
    for (const value of cellsOfRow(sheet, row).values()) {
      const written = /(\d{1,2}\/\d{1,2}\/\d{4})/.exec(value)?.[1];
      const day = dayFrom(written ?? value);
      if (day) return day;
    }
  return null;
}

/** A report's heading row -- the one whose first cell says "Technician" -- and the rows under it, up to its Total. */
function reportRows(sheet: WorkbookSheet): { headers: Map<string, string>; rows: Map<string, string>[] } | null {
  const numbers = [...sheet.rows.keys()].sort((left, right) => left - right);
  const headerAt = numbers.find((number) => number <= 6 && lower(cellsOfRow(sheet, number).get('A')) === 'technician');
  if (headerAt === undefined) return null;
  const headers = new Map([...cellsOfRow(sheet, headerAt).entries()].map(([letter, value]) => [letter, lower(value)]));
  const rows: Map<string, string>[] = [];
  for (const number of numbers) {
    if (number <= headerAt) continue;
    const cells = cellsOfRow(sheet, number);
    const name = lower(cells.get('A'));
    if (!name) continue;
    if (name.startsWith('total')) break;
    rows.push(cells);
  }
  return { headers, rows };
}

const columnOf = (headers: Map<string, string>, test: (heading: string) => boolean) => [...headers.entries()].find(([, heading]) => test(heading))?.[0];

// ── The tabs ────────────────────────────────────────────────────────────────

/**
 * A technician's tab: the workbook's 19 columns, in the same places on every
 * tab, even where a heading is missing. Rows dated `today` or later are the
 * console's and are only counted; a taken-over tab's rows (2026-11-18) pass a
 * day past them all.
 */
export function logOf(sheet: WorkbookSheet, today: string): ImportedLog | null {
  const log = technicianLog(sheet);
  if (!log || lower(log.headers[1]) !== 'address' || lower(log.headers[13]) !== 'labor hours income') return null;
  const result: ImportedLog = { tab: sheet.name.trim(), rows: [], undated: 0, notPast: 0 };
  let lastYear: number | undefined;
  for (const row of log.rows) {
    const [date, address, workOrder, jobNumber, driveTime, timeBudgeted, estimate, arrival, leaving, , complete, reschedule, rescheduleOn, labor, fee, materials, invoice, posted, notes] = row;
    if (lower(date).startsWith('total') || lower(address) === 'total') continue;
    const day = dayFrom(date, lastYear);
    if (!day) {
      // A Total row has no day and no address; anything else typed without a day is counted, not guessed at.
      if (text(address)) result.undated += 1;
      continue;
    }
    lastYear = Number(day.slice(0, 4));
    if (day >= today) {
      result.notPast += 1;
      continue;
    }
    const cells: ImportedLogCells = {
      address: text(address),
      workOrder: text(workOrder),
      jobNumber: text(jobNumber)?.replace(/^#/, '') ?? null,
      driveTime: text(driveTime),
      timeBudgeted: text(timeBudgeted),
      estimatedBudgetCents: centsFrom(estimate),
      arrival: clockFrom(arrival),
      leaving: clockFrom(leaving),
      workComplete: yesNo(complete),
      rescheduleRequired: yesNo(reschedule),
      rescheduleOn: dayFrom(rescheduleOn, lastYear),
      laborCents: centsFrom(labor),
      serviceCallFeeCents: centsFrom(fee),
      materialsCents: centsFrom(materials),
      invoiceNumber: text(invoice),
      postedInPw: text(posted),
      notes: text(notes),
    };
    // A day typed on a row with nothing else on it is a row the office started and left.
    if (Object.values(cells).some((value) => value !== null)) result.rows.push({ date: day, cells });
  }
  return result;
}

const TRACKER = /^new\s+\d{4}$/i;
const DAILY = /^\d{4}$/;
const PROJECTION = /^projected productivity_\d{4}$/i;
const PERIOD = /^period covered:\s*(.+)$/i;

export function importWorkbook(sheets: WorkbookSheet[], today: string): ImportedWorkbook {
  const visible = sheets.filter((sheet) => !sheet.hidden);
  const found: ImportedWorkbook = { logs: [], budgets: [], days: [], weeks: [], months: [] };
  let newestTracker: { date: string; budgets: { name: string; dailyBudgetCents: number }[] } | null = null;
  const day = (name: string, date: string, field: ImportedDayField, value: string | number | null) => {
    if (value !== null && value !== '' && date < today) found.days.push({ name, date, field, value });
  };

  for (const sheet of visible) {
    const name = sheet.name.trim();
    const log = logOf(sheet, today);
    if (log) {
      found.logs.push(log);
      continue;
    }
    if (TRACKER.test(name)) {
      const date = dateNear(sheet, 3);
      const report = reportRows(sheet);
      if (!date || !report) continue;
      const budget = columnOf(report.headers, (heading) => heading.startsWith('budgeted daily revenue'));
      const work = columnOf(report.headers, (heading) => heading.endsWith('work time'));
      const remarks = columnOf(report.headers, (heading) => heading.includes('remark'));
      const budgets: { name: string; dailyBudgetCents: number }[] = [];
      for (const cells of report.rows) {
        const technician = text(cells.get('A'))!;
        const cents = budget ? centsFrom(cells.get(budget)) : null;
        if (cents) budgets.push({ name: technician, dailyBudgetCents: cents });
        if (cents !== null) day(technician, date, 'budgetCents', cents);
        if (work) day(technician, date, 'workSeconds', secondsFrom(cells.get(work)));
        if (remarks) day(technician, date, 'trackerRemarks', text(cells.get(remarks)));
      }
      if (!newestTracker || date > newestTracker.date) newestTracker = { date, budgets };
      continue;
    }
    if (DAILY.test(name) || PROJECTION.test(name)) {
      const date = dateNear(sheet, 3);
      const report = reportRows(sheet);
      if (!date || !report) continue;
      const remarks = columnOf(report.headers, (heading) => heading.includes('remark'));
      if (!remarks) continue;
      for (const cells of report.rows)
        day(text(cells.get('A'))!, date, DAILY.test(name) ? 'dailyRemarks' : 'projectionRemarks', text(cells.get(remarks)));
      continue;
    }
    const period = PERIOD.exec(text(cellsOfRow(sheet, 1).get('A')) ?? '')?.[1]?.trim();
    if (!period) continue;
    const report = reportRows(sheet);
    if (!report) continue;
    const target = columnOf(report.headers, (heading) => heading.startsWith('target revenue'));
    const actual = columnOf(report.headers, (heading) => heading.startsWith('actual revenue'));
    const remarks = columnOf(report.headers, (heading) => heading.includes('remark'));
    const monthOf = /^month of\s+([a-z]+)/i.exec(period);
    if (monthOf) {
      const number = MONTH_NAMES.indexOf(monthOf[1]!.slice(0, 3).toLowerCase()) + 1;
      if (!number) continue;
      // "Month of October" names no year: the latest that is not after today.
      const thisYear = Number(today.slice(0, 4));
      const year = `${thisYear}-${pad(number)}-01` <= today ? thisYear : thisYear - 1;
      const month = `${year}-${pad(number)}`;
      if (`${month}-01` >= today || !remarks) continue;
      for (const cells of report.rows) {
        const said = text(cells.get(remarks));
        if (said) found.months.push({ name: text(cells.get('A'))!, month, remarks: said });
      }
      continue;
    }
    // "OCTOBER 5-9, 2026", "NOVEMBER 2-6, 2026": the console's week is the one its first day is in.
    const weekOf = /^([a-z]+)\.?\s+(\d{1,2})\s*-\s*(\d{1,2}),?\s*(\d{4})$/i.exec(period);
    if (!weekOf) continue;
    const number = MONTH_NAMES.indexOf(weekOf[1]!.slice(0, 3).toLowerCase()) + 1;
    const first = number ? isoDay(Number(weekOf[4]), number, Number(weekOf[2])) : null;
    const week = first ? monthWeeks(first.slice(0, 7)).find((candidate) => candidate.from <= first && first <= candidate.to) : undefined;
    if (!week || week.from >= today) continue;
    const over = week.to < today;
    for (const cells of report.rows) {
      const entry: ImportedWeek = {
        name: text(cells.get('A'))!,
        weekStart: week.from,
        targetCents: over && target ? centsFrom(cells.get(target)) : null,
        actualCents: over && actual ? centsFrom(cells.get(actual)) : null,
        remarks: remarks ? text(cells.get(remarks)) : null,
      };
      if (entry.targetCents !== null || entry.actualCents !== null || entry.remarks) found.weeks.push(entry);
    }
  }
  found.budgets = newestTracker?.budgets ?? [];
  return found;
}

// ── Whose row it is ─────────────────────────────────────────────────────────

const words = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The workbook names a technician three ways: "Amy" on its tab and the
 * projections, "Amy Wilson" on the tracker, "THOMAS ALLEN KIVI" on the reports
 * for the console's "Thomas Allen". A full name, or one the console's name
 * begins, matches anyone; a first name alone matches only among the
 * technicians whose tabs are in the workbook, so "Allen" is not taken for
 * someone else called Allen.
 */
export function technicianMatcher(technicians: { id: string; name: string }[], tabNames: string[]) {
  const people = technicians.map((technician) => ({ ...technician, key: words(technician.name) }));
  const byFirst = (first: string, among: typeof people) => {
    const found = among.filter((person) => person.key.split(' ')[0] === first);
    return found.length === 1 ? found[0]! : null;
  };
  const current = tabNames.map((tab) => byFirst(words(tab), people)).filter((person): person is (typeof people)[number] => Boolean(person));
  return (name: string): { id: string; name: string } | null => {
    const key = words(name);
    if (!key) return null;
    const exact = people.filter((person) => person.key === key);
    if (exact.length === 1) return exact[0]!;
    const begun = people.filter((person) => person.key.includes(' ') && key.startsWith(`${person.key} `));
    if (begun.length === 1) return begun[0]!;
    if (!key.includes(' ')) return byFirst(key, current) ?? (tabNames.some((tab) => words(tab) === key) ? byFirst(key, people) : null);
    return null;
  };
}
