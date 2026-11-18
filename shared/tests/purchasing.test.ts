import { describe, expect, it } from 'vitest';

import { requisitionNumber, requisitionSubmitProblem, requisitionTotalCents } from '../src/contracts/purchasing';

// Purchase requisitions, phase 2 (2026-11-19). Every figure invented.
const SETTINGS = { approvalLimitCents: 50000, quotesAboveLimit: 2 };
const line = (quantity: number, estimatedUnitCostCents: number) => ({ quantity, estimatedUnitCostCents });
const quote = (chosen: boolean) => ({ chosen });

describe('a requisition\'s number', () => {
  it('is PR- and at least four digits', () => {
    expect(requisitionNumber(1)).toBe('PR-0001');
    expect(requisitionNumber(12)).toBe('PR-0012');
    expect(requisitionNumber(12345)).toBe('PR-12345');
  });
});

describe('what it comes to', () => {
  it('is each quantity at its estimated cost, added up', () => {
    expect(requisitionTotalCents([line(36, 390), line(48, 360), line(24, 185)])).toBe(35760);
    expect(requisitionTotalCents([])).toBe(0);
  });
});

describe('whether it can be submitted', () => {
  const ready = { reason: 'Filters are out.', lines: [line(36, 390)], quotes: [] as { chosen: boolean }[] };

  it('needs a reason and something asked for', () => {
    expect(requisitionSubmitProblem(ready, SETTINGS)).toBeNull();
    expect(requisitionSubmitProblem({ ...ready, reason: '  ' }, SETTINGS)).toBe('Say why it is needed.');
    expect(requisitionSubmitProblem({ ...ready, lines: [] }, SETTINGS)).toBe('Add at least one item.');
  });

  it('needs one of its quotes chosen, when it has any', () => {
    expect(requisitionSubmitProblem({ ...ready, quotes: [quote(false)] }, SETTINGS)).toBe('Mark one quote as the chosen one.');
    expect(requisitionSubmitProblem({ ...ready, quotes: [quote(true), quote(true)] }, SETTINGS)).toBe('Mark one quote as the chosen one.');
    expect(requisitionSubmitProblem({ ...ready, quotes: [quote(true)] }, SETTINGS)).toBeNull();
  });

  it('needs the office\'s number of quotes only above the limit', () => {
    const large = { ...ready, lines: [line(40, 1530)] };
    expect(requisitionSubmitProblem({ ...ready, lines: [line(1, 50000)] }, SETTINGS)).toBeNull();
    expect(requisitionSubmitProblem(large, SETTINGS)).toBe('Above the approval limit, 2 quotes are needed.');
    expect(requisitionSubmitProblem({ ...large, quotes: [quote(true)] }, { ...SETTINGS, quotesAboveLimit: 1 })).toBeNull();
    expect(requisitionSubmitProblem(large, { ...SETTINGS, quotesAboveLimit: 1 })).toBe('Above the approval limit, 1 quote is needed.');
    expect(requisitionSubmitProblem({ ...large, quotes: [quote(true), quote(false)] }, SETTINGS)).toBeNull();
    expect(requisitionSubmitProblem(large, { ...SETTINGS, quotesAboveLimit: 0 })).toBeNull();
  });
});
