import { describe, expect, it } from 'vitest';

import { averageCostCents, stockKey, stockStatus, stockSummary } from '../src/contracts/inventory';

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
