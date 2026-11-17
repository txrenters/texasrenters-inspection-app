import { cellText, type ExcelCell, type ExcelEditableField } from '../excel-layout';
import { centsFrom, clockFrom, dayFrom, secondsFrom, yesNo } from '../workbook-import';

/**
 * Reading the office's edits back out of its workbook (2026-11-18; the office
 * chose "Both ways"). A tab as Excel has it now is compared, cell by cell,
 * with what the console last wrote into it:
 *
 *  - a cell the office types in on the console's page -- a day's budget, work
 *    time or remarks, a week's target, actual or remarks, a month's remarks --
 *    changed in Excel comes back to the console;
 *  - but a cell found EMPTY in Excel never empties the console's (2026-11-17:
 *    Moses's 17518 row lost its drive time, time budgeted and budget this way,
 *    and the office uses them for payment). It is put back as the console has
 *    it; a value is cleared on the console's page, never from Excel;
 *  - unless the console changed that same cell since its last write: then the
 *    console's value stands, and Excel gets it back;
 *  - any other cell changed in Excel -- a total, a percentage, a drive time
 *    the log works out, a heading -- is put back as the console has it;
 *  - and when the tab's rows no longer line up with what was written (a row
 *    inserted, deleted or sorted), nothing is taken from it and all of it is
 *    put back: a cell cannot be told whose it is any more. A row has moved
 *    when its first cell is not what was written there, or when most of what
 *    was written in it is not there any more: a technician log's rows share
 *    their day, so the first cell alone cannot tell.
 *
 * Pure: the sync reads the tab, saves what this finds, and writes back.
 */

export interface WrittenTab {
  rows: ExcelCell[][];
  keys: (string | null)[];
  editable: Record<number, ExcelEditableField>;
}

export interface ExcelEdit {
  /** The record: "day|<technician>|<date>", "week|…", "month|…". */
  key: string;
  field: ExcelEditableField;
  /** What the console had there, and what the office typed, as Excel showed them. */
  from: string;
  to: string;
  value: number | string | boolean | null;
}

export interface TabRead {
  edits: ExcelEdit[];
  /** Cells changed in Excel that are the console's to work out, or that Excel holds something unreadable in. */
  putBack: number;
  /** Cells changed in both places since the last write: the console's value stands. */
  conflicts: number;
  /** The rows no longer line up with what was written: nothing is taken, all of it is put back. */
  moved: boolean;
}

type Value = string | number | boolean | null;

const same = (left: string, right: string) => left.trim() === right.trim();

const MONEY = new Set<ExcelEditableField>(['budgetCents', 'targetCents', 'actualCents', 'estimatedBudgetCents', 'laborCents', 'serviceCallFeeCents', 'materialsCents']);
const serialDay = (serial: number) => new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);

/** What the office typed into a cell, as the console stores it; undefined when it cannot be read. */
function valueOf(field: ExcelEditableField, text: string, value: Value): number | string | boolean | null | undefined {
  const blank = !text.trim() && (value === null || value === '');
  if (field === 'arrival' || field === 'leaving') {
    if (blank) return null;
    // A time is a fraction of a day.
    if (typeof value === 'number' && value >= 0 && value < 1) {
      const minutes = Math.round(value * 1440) % 1440;
      return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    }
    return clockFrom(text) ?? undefined;
  }
  if (field === 'workComplete' || field === 'rescheduleRequired') {
    if (blank) return null;
    return yesNo(text) ?? undefined;
  }
  if (field === 'rescheduleOn') {
    if (blank) return null;
    if (typeof value === 'number') return serialDay(value);
    return dayFrom(text) ?? undefined;
  }
  // "Date Posted in PW" is a day when Excel holds one, and whatever was typed ("N/A") when not.
  if (field === 'postedInPw' && typeof value === 'number') return serialDay(value);
  if (MONEY.has(field)) {
    if (blank) return null;
    if (typeof value === 'number') return value >= 0 ? Math.round(value * 100) : undefined;
    return centsFrom(text) ?? undefined;
  }
  if (field === 'workSeconds') {
    if (blank) return null;
    // A time is a fraction of a day; whole minutes, as the page shows them.
    if (typeof value === 'number') return value >= 0 ? Math.round(value * 1440) * 60 : undefined;
    return secondsFrom(text) ?? undefined;
  }
  return text.trim() || null;
}

export function readTab(written: WrittenTab, current: WrittenTab | undefined, excel: { text: string[][]; values: Value[][] }): TabRead {
  const result: TabRead = { edits: [], putBack: 0, conflicts: 0, moved: false };
  const writtenText = written.rows.map((row) => row.map(cellText));
  const width = Math.max(...written.rows.map((row) => row.length), ...excel.text.map((row) => row.length), 1);
  const textAt = (rows: string[][], row: number, column: number) => rows[row]?.[column] ?? '';
  const changed = (row: number, column: number) => {
    const was = written.rows[row]?.[column];
    const now = excel.values[row]?.[column] ?? null;
    // A number the console wrote is compared as a number: a whole-dollar cell shows "$406" for 405.50 and 406
    // alike, and how Excel spells a format is never mistaken for an edit.
    if (typeof was === 'object' && typeof now === 'number') return Math.abs(was.value - now) > 1e-9;
    return !same(textAt(writtenText, row, column), textAt(excel.text, row, column));
  };

  // Whose row is whose: each row's first cell where it was written, most of the rest of it too, and nothing typed
  // below the last row.
  const rows = Math.max(written.rows.length, excel.text.length);
  for (let row = 0; row < rows && !result.moved; row++) {
    if (row >= written.rows.length) {
      result.moved = excel.text[row]?.some((cell) => cell.trim()) ?? false;
      continue;
    }
    if (!written.keys[row]) continue;
    if (!same(textAt(writtenText, row, 0), textAt(excel.text, row, 0))) {
      result.moved = true;
      continue;
    }
    const filled = writtenText[row]!.map((cell, column) => [cell, column] as const).filter(([cell]) => cell.trim());
    const gone = filled.filter(([, column]) => changed(row, column)).length;
    if (filled.length >= 4 && gone * 2 > filled.length) result.moved = true;
  }
  if (result.moved) {
    for (let row = 0; row < rows; row++) for (let column = 0; column < width; column++) if (changed(row, column)) result.putBack += 1;
    return result;
  }

  const currentRowOf = new Map((current?.keys ?? []).flatMap((key, index) => (key ? [[key, index] as const] : [])));
  for (let row = 0; row < written.rows.length; row++)
    for (let column = 0; column < width; column++) {
      if (!changed(row, column)) continue;
      const key = written.keys[row];
      const field = written.editable[column];
      if (!key || !field) {
        result.putBack += 1;
        continue;
      }
      const to = textAt(excel.text, row, column);
      const from = textAt(writtenText, row, column);
      // The console changed this cell too since it wrote it: its value stands.
      const currentRow = currentRowOf.get(key);
      const consoleNow = currentRow === undefined ? from : cellText(current!.rows[currentRow]?.[column]);
      if (!same(consoleNow, from) && !same(consoleNow, to)) {
        result.conflicts += 1;
        continue;
      }
      const value = valueOf(field, to, excel.values[row]?.[column] ?? null);
      if (value === undefined || value === null) {
        result.putBack += 1;
        continue;
      }
      result.edits.push({ key, field, from, to, value });
    }
  return result;
}
