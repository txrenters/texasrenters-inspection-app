import { describe, expect, it } from 'vitest';

import {
  MACHINE_FORBIDDEN_PERMISSIONS,
  PERMISSION_KEYS,
  RECOUNT_OVER_CENTS,
  STOCK_COUNT_OPEN_STATUSES,
  STOCK_MOVEMENT_KINDS,
  startStockCountProblem,
  stockCountCoversPeriod,
  stockCountDifference,
  stockCountDue,
  stockCountNumber,
  stockCountReasonsFor,
  stockCountTitle,
} from '../src/index.js';

/** Inventory counts, phase 6 (2026-11-19). Every figure invented. */

describe('a count', () => {
  it('is numbered CNT- and at least four digits', () => {
    expect(stockCountNumber(7)).toBe('CNT-0007');
    expect(stockCountNumber(12345)).toBe('CNT-12345');
  });

  it('is named for the month, the quarter or the year it was started in', () => {
    expect(stockCountTitle('MONTHLY', '2026-11-19')).toBe('Monthly count, November 2026');
    expect(stockCountTitle('QUARTERLY', '2026-11-19')).toBe('Quarterly count, Q4 2026');
    expect(stockCountTitle('QUARTERLY', '2027-03-31')).toBe('Quarterly count, Q1 2027');
    expect(stockCountTitle('YEARLY', '2026-01-02')).toBe('Yearly count, 2026');
  });

  it('is due on the last day of its month, quarter or year', () => {
    expect(stockCountDue('MONTHLY', '2026-11-19')).toBe('2026-11-30');
    expect(stockCountDue('MONTHLY', '2028-02-10')).toBe('2028-02-29');
    expect(stockCountDue('MONTHLY', '2026-12-31')).toBe('2026-12-31');
    expect(stockCountDue('QUARTERLY', '2026-11-19')).toBe('2026-12-31');
    expect(stockCountDue('QUARTERLY', '2026-04-01')).toBe('2026-06-30');
    expect(stockCountDue('YEARLY', '2026-02-01')).toBe('2026-12-31');
  });

  it('is this period\'s count when it was started in the same month, quarter or year', () => {
    expect(stockCountCoversPeriod('MONTHLY', '2026-11-01', '2026-11-30')).toBe(true);
    expect(stockCountCoversPeriod('MONTHLY', '2026-10-31', '2026-11-01')).toBe(false);
    expect(stockCountCoversPeriod('QUARTERLY', '2026-10-02', '2026-12-30')).toBe(true);
    expect(stockCountCoversPeriod('QUARTERLY', '2026-09-30', '2026-10-01')).toBe(false);
    expect(stockCountCoversPeriod('YEARLY', '2026-01-01', '2026-12-31')).toBe(true);
    expect(stockCountCoversPeriod('YEARLY', '2025-12-31', '2026-01-01')).toBe(false);
  });

  it('holds its place until it is posted or cancelled', () => {
    expect(STOCK_COUNT_OPEN_STATUSES).toEqual(['OPEN', 'COUNTING', 'REVIEW']);
  });
});

describe('a difference', () => {
  it('is what was counted less what was expected, at what one costs', () => {
    expect(stockCountDifference(40, 38, 400)).toEqual({ difference: -2, valueCents: -800, needsRecount: false });
    expect(stockCountDifference(14, 15, 910)).toEqual({ difference: 1, valueCents: 910, needsRecount: false });
    expect(stockCountDifference(6, 6, 185)).toEqual({ difference: 0, valueCents: 0, needsRecount: false });
  });

  it('is counted a second time when it is worth more than the limit, short or over', () => {
    expect(RECOUNT_OVER_CENTS).toBe(2500);
    expect(stockCountDifference(10, 5, 500).needsRecount).toBe(false);
    expect(stockCountDifference(10, 5, 501).needsRecount).toBe(true);
    expect(stockCountDifference(5, 10, 501).needsRecount).toBe(true);
    // Worth nothing on paper: no second count however many are missing.
    expect(stockCountDifference(100, 0, 0).needsRecount).toBe(false);
  });

  it('takes only a reason that fits it', () => {
    expect(stockCountReasonsFor(-2)).toEqual(['TAKEN_WITHOUT_WITHDRAWAL', 'DAMAGED', 'MISCOUNTED_BEFORE', 'NOT_KNOWN']);
    expect(stockCountReasonsFor(1)).toEqual(['RETURNED_WITHOUT_RETURN', 'MISCOUNTED_BEFORE', 'NOT_KNOWN']);
  });
});

describe('starting a count', () => {
  it('needs a place unless it is yearly, and items when it is monthly', () => {
    expect(startStockCountProblem({ kind: 'MONTHLY', placeId: null, itemIds: ['a'] })).toBe('Choose the place to count.');
    expect(startStockCountProblem({ kind: 'MONTHLY', placeId: 'p', itemIds: [] })).toBe('Choose at least one item to count.');
    expect(startStockCountProblem({ kind: 'MONTHLY', placeId: 'p', itemIds: ['a'] })).toBeNull();
    expect(startStockCountProblem({ kind: 'QUARTERLY', placeId: 'p', itemIds: [] })).toBeNull();
    expect(startStockCountProblem({ kind: 'YEARLY', placeId: null, itemIds: [] })).toBeNull();
  });

  it('and approving one are permissions of their own that no API key may hold', () => {
    for (const permission of ['inventory:count', 'inventory:count-approve'] as const) {
      expect(PERMISSION_KEYS).toContain(permission);
      expect(MACHINE_FORBIDDEN_PERMISSIONS).toContain(permission);
    }
    expect(STOCK_MOVEMENT_KINDS).toContain('COUNT_ADJUSTMENT');
  });
});
