import { STOCK_IMPORT_COLUMNS, parseCsv, stockImportRows, type StockImportRow, type StockList } from '@texasrenters/shared';

import { csvText, downloadCsv } from '@/lib/csv';

/**
 * The stock import's file, read and written in the browser (2026-11-23): the
 * template to fill in, and the rows of the file the office chose. The Excel
 * libraries are loaded only when one is needed, not with the page.
 */

const NEED: Record<(typeof STOCK_IMPORT_COLUMNS)[number]['need'], string> = { always: 'Every row', new: 'A new item code', never: 'If you have it' };

/** The template: the headers to fill in under, and in Excel a second sheet saying what each column takes, with the office's own codes. */
export async function downloadImportTemplate(kind: 'xlsx' | 'csv', stock: Pick<StockList, 'places' | 'categories' | 'units' | 'companies' | 'vendors'>) {
  const headers = STOCK_IMPORT_COLUMNS.map((column) => column.header);
  if (kind === 'csv') {
    downloadCsv('stock-import.csv', csvText(headers, []));
    return;
  }
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const heading = (value: string) => ({ value, fontWeight: 'bold' as const });
  const list = (title: string, rows: readonly (readonly string[])[]) => (rows.length ? [[heading(title)], ...rows.map((row) => [...row]), []] : []);
  const notes = [
    [heading('Column'), heading('Needed on'), heading('What to put')],
    ...STOCK_IMPORT_COLUMNS.map((column) => [column.header, NEED[column.need], column.note]),
    [],
    ['One row an item at a place. A code already in the console only takes the stock; a new one is made from its row.'],
    ['Nothing is saved until every row is right: the console lists what to fix first.'],
    [],
    ...list('Location codes', stock.places.filter((place) => place.active).map((place) => [place.code, place.name])),
    ...list('Categories', stock.categories.filter((category) => category.active).map((category) => [category.prefix, category.name])),
    ...list('Units of measure', (stock.units ?? []).map((unit) => [unit.name])),
    ...list('Companies', stock.companies.map((company) => [company.name])),
    ...list('Vendors', stock.vendors.map((vendor) => [vendor.name])),
  ];
  await writeXlsxFile(
    [
      { sheet: 'Stock', data: [headers.map(heading)], columns: headers.map((header) => ({ width: Math.max(14, header.length + 4) })) },
      { sheet: 'How to fill it in', data: notes, columns: [{ width: 22 }, { width: 18 }, { width: 90 }] },
    ],
    {},
  ).toFile('stock-import.xlsx');
}

/** A file's text, read as UTF-8. */
function textOf(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.readAsText(file);
  });
}

/** The rows of the file chosen, or why it cannot be read. Its first sheet is read; a CSV is read as Excel writes one. */
export async function readImportFile(file: File): Promise<{ rows: StockImportRow[]; problem: string | null }> {
  try {
    if (/\.csv$/i.test(file.name) || file.type === 'text/csv') return stockImportRows(parseCsv(await textOf(file)));
    if (!/\.xlsx$/i.test(file.name)) return { rows: [], problem: 'Choose an Excel workbook (.xlsx) or a CSV file.' };
    const { readSheet } = await import('read-excel-file/browser');
    return stockImportRows(await readSheet(file));
  } catch {
    return { rows: [], problem: 'That file could not be read. Save it again from Excel as a workbook (.xlsx) or a CSV, and choose it again.' };
  }
}
