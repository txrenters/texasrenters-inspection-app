import { describe, expect, it } from 'vitest';

import { STOCK_PREFIX, averageCostCents, stockCode, stockKey, stockStatus, stockSummary } from '../src/contracts/inventory';

// Inventory, phase 1 (2026-11-19). Every figure invented.
describe('how much stock is enough', () => {
  it('is out at nothing, low at or below the reorder level, else enough', () => {
    expect(stockStatus(0, 24)).toBe('OUT');
    expect(stockStatus(11, 24)).toBe('LOW');
    expect(stockStatus(24, 24)).toBe('LOW');
    expect(stockStatus(25, 24)).toBe('ENOUGH');
  });

  it('is never low for an item with no reorder level, only out', () => {
    expect(stockStatus(1, 0)).toBe('ENOUGH');
    expect(stockStatus(0, 0)).toBe('OUT');
  });
});

describe('what one unit cost', () => {
  it('is the value on hand over the units on hand, to the cent', () => {
    expect(averageCostCents(18 * 342 + 5 * 360, 23)).toBe(346);
    expect(averageCostCents(0, 0)).toBeNull();
  });
});

describe('one entry per code', () => {
  it('whatever its case or spacing', () => {
    expect(stockKey('  FLT  16251 ')).toBe('flt 16251');
    expect(stockKey('flt 16251')).toBe(stockKey('FLT 16251'));
  });
});

describe('the figures above the list', () => {
  it('count the items in use, those low or out, and what is on hand is worth', () => {
    expect(
      stockSummary([
        { active: true, status: 'ENOUGH', valueCents: 6156 },
        { active: true, status: 'LOW', valueCents: 1800 },
        { active: true, status: 'OUT', valueCents: 0 },
        { active: false, status: 'OUT', valueCents: 0 },
      ]),
    ).toEqual({ items: 3, lowOrOut: 2, valueCents: 7956 });
  });
});

describe('an item code', () => {
  it('is its category prefix and the next number, at least four digits', () => {
    expect(stockCode('FLT', 1)).toBe('FLT-0001');
    expect(stockCode('PST', 312)).toBe('PST-0312');
    expect(stockCode('A1', 12345)).toBe('A1-12345');
  });

  it('starts with a letter and then one to five letters or digits, upper case', () => {
    for (const prefix of ['FLT', 'PST', 'A1', 'ABCDEF']) expect(STOCK_PREFIX.test(prefix)).toBe(true);
    for (const prefix of ['F', 'flt', '9AB', 'F-1', 'ABCDEFG', '']) expect(STOCK_PREFIX.test(prefix)).toBe(false);
  });
});

// Item codes the stock keeper types (2026-11-19).
describe('a typed item code', () => {
  it('is capitals, digits and dashes, two to twenty-four of them', async () => {
    const { STOCK_CODE, normalizeStockCode, MOST_ITEM_PRICE_CENTS } = await import('../src/index.js');
    for (const code of ['FLT-16251', 'BAT-9V', 'A1', '9V', 'X'.repeat(24)]) expect(STOCK_CODE.test(code)).toBe(true);
    for (const code of ['F', '-FLT', 'flt-16251', 'FLT 16251', 'FLT_1', 'FLT-16251!', 'X'.repeat(25), '']) expect(STOCK_CODE.test(code)).toBe(false);
    expect(normalizeStockCode('  flt - 16251 ')).toBe('FLT-16251');
    expect(MOST_ITEM_PRICE_CENTS).toBe(10_000_000);
  });
});
