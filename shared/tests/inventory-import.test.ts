import { describe, expect, it } from 'vitest';

import { MOST_IMPORT_ROWS, STOCK_IMPORT_COLUMNS, cellText, importCents, importWhole, parseCsv, stockImportRows } from '../src/contracts/inventory-import';

// 2026-11-23, the office: the stock comes in from a spreadsheet, filled in from the console's template.
describe('a stock import sheet', () => {
  const headers = STOCK_IMPORT_COLUMNS.map((column) => column.header);

  it("reads the template's rows under its headers, numbering each as Excel does, and skips blank rows", () => {
    const { rows, problem } = stockImportRows([
      ['Stock as of today'],
      headers,
      ['FLT-16251', 'Filter 16x25x1', 'Filters', 'each', 'THMP', 'STORE', 24, 3.9, '', '', '', ''],
      [],
      [' bat-9v ', '', '', '', '', 'Truck 1', '6', '$1.85'],
    ]);
    expect(problem).toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ line: 3, code: 'FLT-16251', description: 'Filter 16x25x1', place: 'STORE', quantity: '24', unitCost: '3.9' });
    expect(rows[1]).toMatchObject({ line: 5, code: 'bat-9v', place: 'Truck 1', unitCost: '$1.85', vendor: '' });
  });

  it("takes the office's own words for a column, in any order", () => {
    const { rows } = stockImportRows([
      ['Qty', 'Location', 'Item No.', 'Cost'],
      [3, 'STORE', 'GLU-1', '9.10'],
    ]);
    expect(rows[0]).toMatchObject({ code: 'GLU-1', place: 'STORE', quantity: '3', unitCost: '9.10' });
  });

  it('says what is missing rather than guessing', () => {
    expect(stockImportRows([['Name', 'Qty']]).problem).toMatch(/Item Code/);
    expect(stockImportRows([['Item Code', 'Quantity']]).problem).toBe('The file has no "Location Code", "Unit Cost" column. Fill in the template, keeping its first row.');
    expect(stockImportRows([headers]).problem).toBe('The file has its headers but no rows under them.');
    const many = [headers, ...Array.from({ length: MOST_IMPORT_ROWS + 1 }, (_, n) => [`IT-${n}`, '', '', '', '', 'STORE', 1, 1])];
    expect(stockImportRows(many).problem).toMatch(/one import takes 1000/);
  });

  it('reads a CSV as Excel writes one, quotes and all', () => {
    expect(parseCsv('﻿Item Code,Description\r\nFLT-1,"Filter, 16"" wide"\r\n\r\nBAT-9V,Battery\n')).toEqual([['Item Code', 'Description'], ['FLT-1', 'Filter, 16" wide'], [''], ['BAT-9V', 'Battery']]);
  });

  it('reads cells as text, numbers as Excel shows them plainly', () => {
    expect(cellText(3.9)).toBe('3.9');
    expect(cellText(0.1 + 0.2)).toBe('0.3');
    expect(cellText(null)).toBe('');
    expect(cellText(new Date('2026-11-23T00:00:00.000Z'))).toBe('2026-11-23');
  });

  it('parses whole numbers and dollars, and nothing else', () => {
    expect(importWhole('1,200')).toBe(1200);
    expect(importWhole('24.0')).toBe(24);
    expect(importWhole('2.5')).toBeNull();
    expect(importWhole('-3')).toBeNull();
    expect(importCents('$1,234.50')).toBe(123450);
    expect(importCents('3.9')).toBe(390);
    expect(importCents('0')).toBe(0);
    expect(importCents('about 4')).toBeNull();
    expect(importCents('')).toBeNull();
  });
});
