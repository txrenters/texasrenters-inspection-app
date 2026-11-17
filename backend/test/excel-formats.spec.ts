import { formatOf, isFormula, needsText, repairFormats } from '../src/admin/excel/excel-formats';

/** The formats the console writes in, so the office's formulas work in its cells (2026-11-18). */
describe('the formats the console writes in', () => {
  it('writes words as General, an empty cell too; Text only for words Excel would read as something else', () => {
    expect(['', 'Start', '10–15 min', 'Gate code', '20373', '-', 'AMY WILSON'].map(formatOf)).toEqual(Array(7).fill('General'));
    expect(['037826', '11/16/2026', '10:15', '8:30 AM', 'TRUE', '1e5', '45%', '1234567890123456789'].map(formatOf)).toEqual(Array(8).fill('@'));
    // Kept from running as a formula by Excel's apostrophe, which only shows as such under General.
    expect(formatOf("'=not a formula")).toBe('General');
    expect(formatOf({ value: 78.99, format: '#,##0.00' })).toBe('#,##0.00');
    expect(needsText('  ')).toBe(false);
  });

  it('tells a formula Excel works out from words beginning with "="', () => {
    expect(isFormula('=SUM(G12:G14)', 42)).toBe(true);
    expect(isFormula("='Amy'!E418", "='Amy'!E418")).toBe(false);
    expect(isFormula('Start', 'Start')).toBe(false);
  });

  it('puts right a range written before: Text made General where it need not be, a formula kept as words entered again', () => {
    const repair = repairFormats({
      numberFormat: [
        ['@', '@', '@', '#,##0.00'],
        ['@', 'General', '@', '@'],
      ],
      values: [
        ['', 'Start', "='Amy'!E418", 78.99],
        ['037826', '=x', '11/16/2026', ' = '],
      ],
      formulas: [
        ['', 'Start', "='Amy'!E418", 78.99],
        ['037826', '=x', '11/16/2026', ' = '],
      ],
    });
    expect(repair.formats).toEqual([
      ['General', 'General', 'General', '#,##0.00'],
      ['@', 'General', '@', 'General'],
    ]);
    expect(repair.formulas).toEqual([{ row: 0, column: 2, formula: "='Amy'!E418" }]);
    expect(repairFormats({ numberFormat: [['General', '@']], values: [['x', '037826']], formulas: [['x', '037826']] })).toEqual({ formats: null, formulas: [] });
  });
});
