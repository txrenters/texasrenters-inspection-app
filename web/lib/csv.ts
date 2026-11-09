/**
 * A table as CSV, made in the browser from rows the page already holds
 * (2026-11-09, the invoice reports): nothing is asked of the server.
 */

export type CsvCell = string | number | null | undefined;

/**
 * One cell: quoted when it holds a comma, a quote or a line break. Text that
 * starts like a formula (= + - @) is prefixed with an apostrophe, so a
 * spreadsheet shows it rather than running it; numbers are left as numbers.
 */
export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvText(headers: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/** Dollars and cents as a number a spreadsheet adds up: 3999 is 39.99. */
export const csvMoney = (cents: number | null | undefined) => (cents === null || cents === undefined ? null : Number((cents / 100).toFixed(2)));

/** Saved under its name. The byte-order mark tells Excel it is UTF-8. */
export function downloadCsv(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}
