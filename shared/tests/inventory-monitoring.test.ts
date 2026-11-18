import { describe, expect, it } from 'vitest';

import { daysOfStock, suggestedOrder, usagePeriodSpan } from '../src/index.js';

/** Reorder and usage, phase 7 (2026-11-19). Every figure invented. */

describe('a period', () => {
  it('is the last 30 days, today included', () => {
    expect(usagePeriodSpan('30d', '2026-11-19')).toEqual({ from: '2026-10-21', days: 30 });
    expect(usagePeriodSpan('30d', '2026-01-10')).toEqual({ from: '2025-12-12', days: 30 });
  });

  it('is the quarter or the year so far, by the days that have gone by', () => {
    expect(usagePeriodSpan('quarter', '2026-11-19')).toEqual({ from: '2026-10-01', days: 50 });
    expect(usagePeriodSpan('quarter', '2026-10-01')).toEqual({ from: '2026-10-01', days: 1 });
    expect(usagePeriodSpan('quarter', '2026-03-31')).toEqual({ from: '2026-01-01', days: 90 });
    expect(usagePeriodSpan('year', '2026-11-19')).toEqual({ from: '2026-01-01', days: 323 });
    expect(usagePeriodSpan('year', '2028-12-31')).toEqual({ from: '2028-01-01', days: 366 });
  });
});

describe('how long stock lasts', () => {
  it('is what is on hand over what was used a day, in whole days', () => {
    expect(daysOfStock(5, 13, 30)).toBe(11);
    expect(daysOfStock(11, 36, 30)).toBe(9);
    expect(daysOfStock(0, 30, 30)).toBe(0);
  });

  it('is not said when none was used', () => {
    expect(daysOfStock(5, 0, 30)).toBeNull();
    expect(daysOfStock(5, -2, 30)).toBeNull();
  });
});

describe('what to ask for', () => {
  it('is the usual order, or else enough to get back above the reorder level', () => {
    expect(suggestedOrder({ onHand: 0, reorderLevel: 18, reorderQuantity: 36 })).toBe(36);
    expect(suggestedOrder({ onHand: 5, reorderLevel: 12, reorderQuantity: 0 })).toBe(8);
    expect(suggestedOrder({ onHand: 12, reorderLevel: 12, reorderQuantity: 0 })).toBe(1);
  });
});
