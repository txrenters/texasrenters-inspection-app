import { cellText, type ExcelCell, type ExcelEditableField } from '../excel-layout';
import { dayFrom, text, type ImportedLogCells } from '../workbook-import';
import { isFormula } from './excel-formats';
import { valueOf, type ExcelEdit } from './excel-read';

/**
 * A technician's log tab kept in step with the console row by row, each row
 * found by WHAT it is -- its day and Job#, or its day and address -- never by
 * where it sits (2026-11-17: the office adds and moves rows in its tabs, and a
 * tab matched by position would have had ~180 of the office's cells written
 * over). The office's typing is never written over:
 *
 *  - a cell the office changed in Excel comes into the console, even when the
 *    console changed it too (the console's value stays in the save history);
 *    a cell the office emptied is left as it is, both sides;
 *  - a cell only the console changed is written into that cell of the row,
 *    wherever the row is now;
 *  - a console row Excel has not had from the console yet, found on the tab
 *    all the same (the office typed it), takes the office's cells, and the
 *    console fills only the cells the office left empty;
 *  - a row the office added (not the console's) comes into the console, once
 *    its day is one of the console's -- a later day's row waits for its day;
 *  - a console row Excel has never had is added at the foot of the tab; one the
 *    office deleted stays deleted;
 *  - a row the console wrote that is no longer the console's (its visit moved
 *    to another day) is emptied, when the office has not typed in it;
 *  - Total rows are the office's: only it knows where its totals sit;
 *  - a cell holding a formula -- the office's Actual Time, its sums -- is the
 *    office's: never written over (2026-11-18).
 *
 * Pure: the sync reads the tab, and does what this plans.
 */

type Value = string | number | boolean | null;

/** A console row as the tab shows it: its record, and its 19 cells. */
export interface ConsoleLogRow {
  key: string;
  cells: ExcelCell[];
}

export interface LogTabPlan {
  /** The office's cell edits, to take into the console. */
  edits: ExcelEdit[];
  /** Rows the office added in Excel, to bring into the console. */
  added: { date: string; cells: ImportedLogCells }[];
  /** Console changes: a run of cells side by side in one row (0-based row of the region read). */
  writes: { row: number; column: number; cells: ExcelCell[] }[];
  /** Console rows Excel has never had, added at the foot. */
  appends: ConsoleLogRow[];
  /** Rows the console wrote that are not the console's any more, untouched by the office: emptied (0-based row of the region read). */
  clears: number[];
  /** What Excel holds in each console row after this: the next run's "last written". */
  written: Record<string, ExcelCell[]>;
  conflicts: number;
  /** Console rows the office deleted in Excel: left deleted. */
  deleted: number;
  /** Rows the office added for a visit already on the tab, or that cannot be told apart: not brought in. */
  skipped: number;
}

export const LOG_WIDTH = 19;
const DATE = 0;
const ADDRESS = 1;
const JOB = 3;
const SERIAL_ZERO = Date.UTC(1899, 11, 30);
/** A row's street, as both write it first: "17518 Autumn Hills Dr - Zone 2 - …" and "17518 Autumn Hills Dr - 17518 …" alike. */
const addressKey = (value: string | undefined) => (value ?? '').split(/\s+[-–]\s+/)[0]!.trim().toLowerCase().replace(/\s+/g, ' ');
const jobKey = (value: string | undefined) => (value ?? '').trim().replace(/^#/, '');

/** A row's day: a day's number as Excel keeps it, or "11/17/2026". */
function dayOf(shown: string | undefined, value: Value): string | null {
  if (typeof value === 'number' && value > 30000) return new Date(SERIAL_ZERO + Math.floor(value) * 86_400_000).toISOString().slice(0, 10);
  return dayFrom(shown);
}
const dayOfCell = (cell: ExcelCell | undefined) => (typeof cell === 'object' ? dayOf(undefined, cell.value) : dayOf(cell, null));

/**
 * Excel's cell holds what the console's cell says. A number is compared as a
 * number -- how Excel spells a format is never an edit -- and text as text.
 */
export function holds(cell: ExcelCell | undefined, shown: string, value: Value): boolean {
  if (typeof cell === 'object' && typeof value === 'number') return Math.abs(cell.value - value) < 1e-9;
  return cellText(cell).trim() === shown.trim();
}
/** Two of the console's cells say the same. */
export const sameCell = (left: ExcelCell | undefined, right: ExcelCell | undefined) =>
  typeof left === 'object' && typeof right === 'object' ? Math.abs(left.value - right.value) < 1e-9 : cellText(left).trim() === cellText(right).trim();
/** What Excel holds, as a cell of the console's: the next run compares with it. */
const asCell = (shown: string, value: Value): ExcelCell => (typeof value === 'number' ? { value, format: '' } : shown);

/** A row the office typed, as a row of the console's own. */
function officeRow(texts: string[], values: Value[]): ImportedLogCells {
  const at = (column: number) => texts[column] ?? '';
  const read = <T>(field: ExcelEditableField, column: number) => (valueOf(field, at(column), values[column] ?? null) ?? null) as T | null;
  return {
    address: text(at(1)),
    workOrder: text(at(2)),
    jobNumber: jobKey(at(3)) || null,
    driveTime: text(at(4)),
    timeBudgeted: text(at(5)),
    estimatedBudgetCents: read<number>('estimatedBudgetCents', 6),
    arrival: read<string>('arrival', 7),
    leaving: read<string>('leaving', 8),
    workComplete: read<boolean>('workComplete', 10),
    rescheduleRequired: read<boolean>('rescheduleRequired', 11),
    rescheduleOn: read<string>('rescheduleOn', 12),
    laborCents: read<number>('laborCents', 13),
    serviceCallFeeCents: read<number>('serviceCallFeeCents', 14),
    materialsCents: read<number>('materialsCents', 15),
    invoiceNumber: text(at(16)),
    postedInPw: read<string>('postedInPw', 17),
    notes: text(at(18)),
  };
}

export function planLogTab(input: {
  consoleRows: ConsoleLogRow[];
  /** What Excel held in each console row after the console's last run; absent for a row it never wrote. */
  written: Record<string, ExcelCell[]>;
  /** The tab's rows, from where the console's begin down to its last row: what Excel shows, and holds. */
  excel: { text: string[][]; values: Value[][]; formulas?: unknown[][] };
  editable: Record<number, ExcelEditableField>;
  /** The first day that is the console's on this tab: an office row before it is left alone. */
  from: string;
  /**
   * The last day of the console's rows on this tab (tomorrow). A row the office
   * typed for a later day -- Monday's, typed on Friday -- waits until its day is
   * the console's: none of the console's rows can be it yet, so brought in now it
   * would be brought in again on every run (2026-11-23: Moses's Monday came into
   * the console once a run, all weekend), and its visit written beside it.
   */
  to: string;
}): LogTabPlan {
  const plan: LogTabPlan = { edits: [], added: [], writes: [], appends: [], clears: [], written: {}, conflicts: 0, deleted: 0, skipped: 0 };
  const rows = input.excel.text.map((texts, index) => {
    const values = input.excel.values[index] ?? [];
    return {
      index,
      texts,
      values,
      day: dayOf(texts[DATE], values[DATE] ?? null),
      total: /^total/i.test((texts[DATE] ?? '').trim()),
      blank: texts.every((cell) => !(cell ?? '').trim()),
    };
  });
  type Row = (typeof rows)[number];
  const candidates = rows.filter((row) => !row.blank && !row.total && row.day);
  const taken = new Set<number>();
  /** Each record's row on the tab: by day and Job#, then by day and address -- as it is now, or as it was written. */
  const match = (records: { key: string; cells: (ExcelCell[] | undefined)[] }[]) => {
    const found = new Map<string, Row>();
    for (const pass of ['job', 'address'] as const)
      for (const record of records) {
        if (found.has(record.key)) continue;
        const known = record.cells.filter((cells): cells is ExcelCell[] => Boolean(cells));
        const days = known.map((cells) => dayOfCell(cells[DATE])).filter(Boolean);
        const names = known.map((cells) => (pass === 'job' ? jobKey(cellText(cells[JOB])) : addressKey(cellText(cells[ADDRESS])))).filter(Boolean);
        const row = candidates.find(
          (candidate) =>
            !taken.has(candidate.index) &&
            days.includes(candidate.day) &&
            names.includes(pass === 'job' ? jobKey(candidate.texts[JOB]) : addressKey(candidate.texts[ADDRESS])),
        );
        if (!row) continue;
        found.set(record.key, row);
        taken.add(row.index);
      }
    return found;
  };
  const matched = match(input.consoleRows.map((row) => ({ key: row.key, cells: [row.cells, input.written[row.key]] })));
  const consoleKeys = new Set(input.consoleRows.map((row) => row.key));
  const gone = match(Object.entries(input.written).flatMap(([key, cells]) => (consoleKeys.has(key) ? [] : [{ key, cells: [cells] }])));

  for (const row of input.consoleRows) {
    const excelRow = matched.get(row.key);
    const before = input.written[row.key];
    if (!excelRow) {
      // The console wrote it before and it is gone: the office deleted it. Never written: a new row, at the foot.
      if (before) {
        // Remembered, so it is never added again.
        plan.deleted += 1;
        plan.written[row.key] = Array.from({ length: LOG_WIDTH }, (_, column) => row.cells[column] ?? '');
      } else {
        plan.appends.push(row);
        plan.written[row.key] = Array.from({ length: LOG_WIDTH }, (_, column) => row.cells[column] ?? '');
      }
      continue;
    }
    const after: ExcelCell[] = [];
    let run: { column: number; cells: ExcelCell[] } | null = null;
    const flush = () => {
      if (run) plan.writes.push({ row: excelRow.index, ...run });
      run = null;
    };
    for (let column = 0; column < LOG_WIDTH; column++) {
      const shown = (excelRow.texts[column] ?? '').trim();
      const value = excelRow.values[column] ?? null;
      const mine = row.cells[column] ?? '';
      if (holds(mine, shown, value)) {
        flush();
        after.push(mine);
        continue;
      }
      // Never written by the console: what the office typed is the office's, and only an empty cell is the console's to fill.
      const officeChanged = before ? !holds(before[column], shown, value) : shown !== '';
      const consoleChanged = before ? !sameCell(mine, before[column]) : true;
      if (officeChanged) {
        flush();
        // An emptied cell is left as it is, both sides: remembered as it was, so the next run does not write it back.
        after.push(shown || !before ? asCell(shown, value) : (before[column] ?? ''));
        // Taken in when it is a cell the office types in on the page.
        const field = input.editable[column];
        if (!field || !shown) continue;
        const typed = valueOf(field, shown, value);
        if (typed === undefined || typed === null) continue;
        if (before && consoleChanged) plan.conflicts += 1;
        plan.edits.push({ key: row.key, field, from: cellText(mine), to: shown, value: typed });
        continue;
      }
      if (consoleChanged && !isFormula(input.excel.formulas?.[excelRow.index]?.[column], value)) {
        // Only the console changed it: into this cell of the row, wherever the row is -- unless the office works it out there.
        run ??= { column, cells: [] };
        run.cells.push(mine);
        after.push(mine);
        continue;
      }
      flush();
      after.push(asCell(shown, value));
    }
    flush();
    plan.written[row.key] = after;
  }

  // Rows the console wrote and no longer has: emptied when they still hold only what it wrote; the office's otherwise.
  for (const [key, excelRow] of gone) {
    const before = input.written[key]!;
    // A row holding a formula is never emptied, whatever it shows (2026-11-18, the office: "all the formulas from the
    // spreadsheet should not be removed").
    const untouched = Array.from({ length: LOG_WIDTH }, (_, column) => column).every(
      (column) =>
        holds(before[column], excelRow.texts[column] ?? '', excelRow.values[column] ?? null) &&
        !isFormula(input.excel.formulas?.[excelRow.index]?.[column], excelRow.values[column] ?? null),
    );
    if (untouched) plan.clears.push(excelRow.index);
    // The office typed in it: the office's now, left as it is -- remembered, so it is never brought in as the office's own row.
    else plan.written[key] = before;
  }

  // Rows the office added from the console's first day to its last: into the console -- but not a second row for a
  // visit the tab already has, nor a row with neither Job# nor address, which could never be found again.
  const onTab = new Set([...matched.values(), ...gone.values()].map((row) => `${row.day}|${jobKey(row.texts[JOB])}`));
  for (const row of candidates) {
    if (taken.has(row.index) || row.day! < input.from || row.day! > input.to) continue;
    const job = jobKey(row.texts[JOB]);
    if ((job && onTab.has(`${row.day}|${job}`)) || (!job && !addressKey(row.texts[ADDRESS]))) {
      plan.skipped += 1;
      continue;
    }
    plan.added.push({ date: row.day!, cells: officeRow(row.texts, row.values) });
  }
  return plan;
}

/** What the console last wrote into a log tab, by row, from its snapshot -- either kind. */
export function writtenOf(snapshot: { rows: unknown; keys: unknown } | undefined): Record<string, ExcelCell[]> {
  if (!snapshot) return {};
  const rows = (snapshot.rows ?? []) as ExcelCell[][];
  const keys = (snapshot.keys ?? []) as (string | null)[];
  return Object.fromEntries(keys.flatMap((key, index) => (key && rows[index] ? [[key, rows[index]!] as const] : [])));
}
