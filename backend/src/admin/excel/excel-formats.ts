import type { ExcelCell } from '../excel-layout';

/**
 * The office's formulas keep working in the cells the console writes
 * (2026-11-18; the office: they "can't use the formulas").
 *
 * Since v2.5.245 the console set every text cell it wrote -- an empty one
 * too -- to Excel's Text format ("@"). Excel never works out a formula typed
 * into a Text cell: "=SUM(G12:G14)" stays on the sheet as those letters. So:
 *
 *  - a cell the console writes is Text only when Excel would otherwise read
 *    its words as something else -- "037826" losing its zero, "11/16/2026" a
 *    day, "10:15" a time; anything else is General, and an empty cell always;
 *  - the cells written before are put right once (`repairFormats`): Text made
 *    General where it need not be, and a formula already typed into one, kept
 *    as words, is entered again so Excel works it out;
 *  - a cell holding a formula is the office's: never written over.
 */

const TEXT = '@';
const GENERAL = 'General';

/** Words Excel would read as something else -- a number losing its zeros, a day, a time, TRUE -- under General. */
export function needsText(words: string): boolean {
  const value = words.trim();
  if (!value) return false;
  return (
    /^[+-]?0\d/.test(value) ||
    /^\d{1,4}[/.-]\d{1,2}([/.-]\d{1,4})?$/.test(value) ||
    /^\d{1,2}:\d{2}(:\d{2})?(\s*[ap]\.?m?\.?)?$/i.test(value) ||
    /^(true|false)$/i.test(value) ||
    /^[+-]?\d+(\.\d+)?e[+-]?\d+$/i.test(value) ||
    /^[+-]?[\d,]*\.?\d+\s?%$/.test(value) ||
    /^\d{16,}$/.test(value) ||
    /^\(\d[\d,.]*\)$/.test(value)
  );
}

/** The format a cell is written in: a number's own; Text only for words that need it; General otherwise. */
export function formatOf(cell: ExcelCell): string {
  if (typeof cell !== 'string') return cell.format;
  // Kept from running as a formula by Excel's leading apostrophe, which shows under General.
  if (cell.startsWith("'")) return GENERAL;
  return needsText(cell) ? TEXT : GENERAL;
}

type Value = string | number | boolean | null;

/** Excel holds a formula here -- one it works out, not words that begin with "=". */
export const isFormula = (formula: unknown, value: Value | undefined) => typeof formula === 'string' && formula.startsWith('=') && formula !== value;

export interface FormatRepair {
  /** The range's formats as they should be, every cell -- null when none changes. */
  formats: string[][] | null;
  /** Formulas typed into a Text cell, kept as words: entered again, at their row and column in the range. */
  formulas: { row: number; column: number; formula: string }[];
}

/**
 * What to put right in a range the console wrote: each Text cell that need
 * not be Text is made General -- what it holds stays as it is -- and words
 * beginning with "=" in one are entered again as the formula they were meant
 * to be.
 */
export function repairFormats(read: { numberFormat: string[][]; values: Value[][]; formulas: unknown[][] }): FormatRepair {
  const formulas: FormatRepair['formulas'] = [];
  let changed = false;
  const formats = read.numberFormat.map((row, r) =>
    row.map((format, c) => {
      if (format !== TEXT) return format;
      const value = read.values[r]?.[c] ?? null;
      const words = typeof value === 'string' ? value : value === null ? '' : String(value);
      if (words.trim().startsWith('=') && words.trim().length > 1) {
        formulas.push({ row: r, column: c, formula: words.trim() });
        changed = true;
        return GENERAL;
      }
      if (needsText(words)) return format;
      changed = true;
      return GENERAL;
    }),
  );
  return { formats: changed ? formats : null, formulas };
}
