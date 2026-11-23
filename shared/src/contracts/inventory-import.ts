/**
 * Importing the office's stock from a spreadsheet (2026-11-23): the step
 * between having inventory and using it. Each row is an item at a place with
 * how many are there and what one cost. As the office chose:
 * - a row whose item code is new makes the code -- description, category,
 *   unit, company, price -- and then sets its opening stock; a row for a code
 *   already made only sets the stock;
 * - the file is an Excel workbook or a CSV, filled in from the console's
 *   template;
 * - nothing is saved until every row is right: the page checks the whole file
 *   first, lists what is wrong row by row, and Import saves it all at once.
 *
 * The page reads the file and sends its cells as text; the server parses and
 * checks them by the rules below, so a row means the same on both.
 */

/** A file of more rows is split in two: one import is one transaction. */
export const MOST_IMPORT_ROWS = 1000;

/** The columns of the template, in its order. `need`: always, only for a new code, or never. */
export const STOCK_IMPORT_COLUMNS = [
  { key: 'code', header: 'Item Code', need: 'always', note: 'Like FLT-16251: 2 to 24 capitals, digits and dashes. A code not in the console yet is made.' },
  { key: 'description', header: 'Description', need: 'new', note: 'What the item is.' },
  { key: 'category', header: 'Category', need: 'new', note: 'One of the categories on Inventory > Categories, by name or prefix.' },
  { key: 'unit', header: 'Unit of Measure', need: 'new', note: 'One of the units of measure, like each or box.' },
  { key: 'company', header: 'Company', need: 'new', note: 'The company it is bought for, by purchaser code (THMP) or name.' },
  { key: 'place', header: 'Location Code', need: 'always', note: 'Where it is: one of the places on Inventory > Places, by code or name.' },
  { key: 'quantity', header: 'Quantity', need: 'always', note: 'How many are there, a whole number above 0.' },
  { key: 'unitCost', header: 'Unit Cost', need: 'always', note: 'What one cost, in dollars, like 3.90.' },
  { key: 'price', header: 'Usual Price', need: 'never', note: 'What one usually costs to buy, in dollars: a new purchase request line starts from it.' },
  { key: 'reorderLevel', header: 'Reorder Level', need: 'never', note: 'At or below this many, it is low.' },
  { key: 'reorderQuantity', header: 'Reorder Quantity', need: 'never', note: 'How many are usually ordered.' },
  { key: 'vendor', header: 'Usual Vendor', need: 'never', note: 'The vendor it is usually bought from, by number (V-00003) or name.' },
] as const;
export type StockImportColumn = (typeof STOCK_IMPORT_COLUMNS)[number]['key'];

/** One row as the file has it: each cell as text, blank as ''. */
export type StockImportRow = { line: number } & Record<StockImportColumn, string>;

export interface StockImportInput {
  rows: StockImportRow[];
  /** The Texas day the stock is as of, YYYY-MM-DD; today when left out. */
  day?: string;
  /** The file's name, kept with the import. */
  fileName?: string | null;
  /** Made once by the page for this import, so a second press saves nothing twice. Needed to import, not to check. */
  requestKey?: string;
}

export interface StockImportRowCheck {
  line: number;
  code: string;
  /** NEW: the import makes the code; EXISTING: it only sets stock. */
  item: 'NEW' | 'EXISTING';
  place: string;
  quantity: number | null;
  unitCostCents: number | null;
  /** What is wrong with the row, in the office's words; empty when it is right. */
  problems: string[];
}

export interface StockImportCheck {
  rows: StockImportRowCheck[];
  /** What is wrong with the file as a whole, apart from its rows. */
  problems: string[];
  newItems: number;
  existingItems: number;
  totalQuantity: number;
  totalValueCents: number;
  /** Every row right and nothing else wrong: Import may be pressed. */
  ready: boolean;
}

export interface StockImportDone {
  rows: number;
  newItems: number;
  totalValueCents: number;
}

// ── Reading a sheet ─────────────────────────────────────────────────────────

const HEADERS = new Map<string, StockImportColumn>(STOCK_IMPORT_COLUMNS.map((column) => [squash(column.header), column.key]));
// The words the office may have used instead.
for (const [said, key] of [
  ['code', 'code'],
  ['itemno', 'code'],
  ['itemnumber', 'code'],
  ['name', 'description'],
  ['item', 'description'],
  ['unit', 'unit'],
  ['uom', 'unit'],
  ['purchasercode', 'company'],
  ['location', 'place'],
  ['place', 'place'],
  ['qty', 'quantity'],
  ['onhand', 'quantity'],
  ['cost', 'unitCost'],
  ['unitprice', 'unitCost'],
  ['price', 'price'],
  ['vendor', 'vendor'],
  ['vendorno', 'vendor'],
] as const)
  HEADERS.set(said, key);

function squash(header: string): string {
  return header.toLowerCase().replace(/[^a-z]/g, '');
}

/** A cell as text: a number as Excel shows it plainly, a date as its day, blank as ''. */
export function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? '' : cell.toISOString().slice(0, 10);
  if (typeof cell === 'number') return Number.isFinite(cell) ? String(Math.round(cell * 1e6) / 1e6) : '';
  return String(cell).trim();
}

/**
 * The rows of a sheet: the first row naming an Item Code is the headers, and
 * every row under it with anything in it is a row. `line` is the row's number
 * in the sheet, counting from 1, as Excel numbers it.
 */
export function stockImportRows(sheet: readonly (readonly unknown[])[]): { rows: StockImportRow[]; problem: string | null } {
  const at = sheet.findIndex((row) => row.some((cell) => HEADERS.get(squash(cellText(cell))) === 'code'));
  if (at < 0) return { rows: [], problem: 'No row names an "Item Code" column. Fill in the template, keeping its first row.' };
  const columns = sheet[at]!.map((cell) => HEADERS.get(squash(cellText(cell))) ?? null);
  const missing = STOCK_IMPORT_COLUMNS.filter((column) => column.need === 'always' && !columns.includes(column.key)).map((column) => `"${column.header}"`);
  if (missing.length) return { rows: [], problem: `The file has no ${missing.join(', ')} column. Fill in the template, keeping its first row.` };
  const rows: StockImportRow[] = [];
  sheet.slice(at + 1).forEach((cells, index) => {
    if (!cells.some((cell) => cellText(cell) !== '')) return;
    const row = { line: at + index + 2 } as StockImportRow;
    for (const column of STOCK_IMPORT_COLUMNS) row[column.key] = '';
    columns.forEach((key, column) => {
      if (key && !row[key]) row[key] = cellText(cells[column]);
    });
    rows.push(row);
  });
  if (!rows.length) return { rows, problem: 'The file has its headers but no rows under them.' };
  if (rows.length > MOST_IMPORT_ROWS) return { rows: [], problem: `The file has ${rows.length} rows; one import takes ${MOST_IMPORT_ROWS}. Split it in two.` };
  return { rows, problem: null };
}

/** A CSV's cells, as Excel writes them: commas, quotes around a cell that has them, "" for a quote. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  // Excel starts a CSV saved as UTF-8 with a byte order mark.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let at = 0; at < source.length; at += 1) {
    const char = source[at]!;
    if (quoted) {
      if (char === '"' && source[at + 1] === '"') {
        cell += '"';
        at += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[at + 1] === '\n') at += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ── A cell's value, as the server reads it ─────────────────────────────────

/** A whole number from "24" or "1,200"; null when the cell is not one. */
export function importWhole(text: string): number | null {
  const plain = text.replace(/,/g, '').trim();
  if (!/^\d+(\.0+)?$/.test(plain)) return null;
  const value = Number(plain);
  return Number.isSafeInteger(value) ? value : null;
}

/** Cents from "$1,234.50", "3.9" or "0"; null when the cell is not an amount of dollars. */
export function importCents(text: string): number | null {
  const plain = text.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(plain)) return null;
  const cents = Math.round(Number(plain) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}
