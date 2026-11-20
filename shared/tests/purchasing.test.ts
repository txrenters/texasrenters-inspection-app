import { describe, expect, it } from 'vitest';

import { formatTaxRate, orderSubmitProblem, orderTaxCents, orderTotals, purchaseOrderNumber } from '../src/contracts/purchase-orders';
import { requisitionNumber, requisitionSubmitProblem, requisitionTotalCents } from '../src/contracts/purchasing';
import { DEFAULT_FILE_RULES, stepsFromLimit } from '../src/contracts/purchasing-setup';

// Purchase requisitions, phase 2 (2026-11-19). Every figure invented.
// The office before Purchasing Setup: $500.00, and two quotes above it, read as two steps.
const SETTINGS = { steps: stepsFromLimit(50000, 2), files: DEFAULT_FILE_RULES };
const quotesAbove = (quotes: number) => ({ ...SETTINGS, steps: stepsFromLimit(50000, quotes) });
const line = (quantity: number, estimatedUnitCostCents: number) => ({ quantity, estimatedUnitCostCents });
const quote = (chosen: boolean) => ({ chosen });

describe('a requisition\'s number', () => {
  // Five digits since 2026-11-20, as NAV writes them (PR-00000).
  it('is PR- and at least five digits', () => {
    expect(requisitionNumber(1)).toBe('PR-00001');
    expect(requisitionNumber(12)).toBe('PR-00012');
    expect(requisitionNumber(12345)).toBe('PR-12345');
    expect(requisitionNumber(123456)).toBe('PR-123456');
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

  // The reason is optional since 2026-11-20: it sits under "Show more fields" on the NAV-style page.
  it('needs something asked for, and no reason', () => {
    expect(requisitionSubmitProblem(ready, SETTINGS)).toBeNull();
    expect(requisitionSubmitProblem({ ...ready, reason: '  ' }, SETTINGS)).toBeNull();
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
    expect(requisitionSubmitProblem(large, SETTINGS)).toBe('At this amount, 2 quotes are needed.');
    expect(requisitionSubmitProblem({ ...large, quotes: [quote(true)] }, quotesAbove(1))).toBeNull();
    expect(requisitionSubmitProblem(large, quotesAbove(1))).toBe('At this amount, 1 quote is needed.');
    expect(requisitionSubmitProblem({ ...large, quotes: [quote(true), quote(false)] }, SETTINGS)).toBeNull();
    expect(requisitionSubmitProblem(large, quotesAbove(0))).toBeNull();
  });

  // Purchasing Setup, 2026-11-20: each step says its own quotes; and above an amount, a file must be attached.
  it('needs the quotes of the step its amount falls in, and the quote attached above the amount the office set', () => {
    const steps = [
      { upToCents: 50000, approver: 'ANY_APPROVER' as const, quotesNeeded: 0, reminderDays: 1 },
      { upToCents: 500000, approver: 'ANY_APPROVER' as const, quotesNeeded: 1, reminderDays: 1 },
      { upToCents: null, approver: 'ANY_AMOUNT' as const, quotesNeeded: 2, reminderDays: 2 },
    ];
    const settings = { steps, files: { ...DEFAULT_FILE_RULES, quoteFileAboveCents: 50000 } };
    const middle = { ...ready, lines: [line(10, 10000)] };
    expect(requisitionSubmitProblem(ready, settings)).toBeNull();
    expect(requisitionSubmitProblem(middle, settings)).toBe('At this amount, 1 quote is needed.');
    expect(requisitionSubmitProblem({ ...middle, quotes: [quote(true)] }, settings)).toBe('Above $500.00, attach the quote before sending it.');
    expect(requisitionSubmitProblem({ ...middle, quotes: [quote(true)], files: [{}] }, settings)).toBeNull();
    expect(requisitionSubmitProblem({ ...ready, lines: [line(1, 500001)], quotes: [quote(true)], files: [{}] }, settings)).toBe('At this amount, 2 quotes are needed.');
  });
});

describe('a purchase order', () => {
  it('is numbered PO- and at least four digits', () => {
    expect(purchaseOrderNumber(9)).toBe('PO-0009');
    expect(purchaseOrderNumber(12345)).toBe('PO-12345');
  });

  it('adds its lines up and puts the sales tax on top, to the cent', () => {
    const lines = [{ quantity: 36, unitPriceCents: 390 }, { quantity: 24, unitPriceCents: 185 }];
    expect(orderTotals(lines, 825)).toEqual({ subtotalCents: 18480, taxCents: 1525, totalCents: 20005 });
    expect(orderTotals(lines, 0)).toEqual({ subtotalCents: 18480, taxCents: 0, totalCents: 18480 });
    expect(orderTaxCents(49920, 825)).toBe(4118);
  });

  it('says its tax rate as the office writes one', () => {
    expect(formatTaxRate(825)).toBe('8.25%');
    expect(formatTaxRate(800)).toBe('8%');
    expect(formatTaxRate(850)).toBe('8.5%');
    expect(formatTaxRate(0)).toBe('0%');
  });

  it('needs its vendor and a line before it is submitted', () => {
    expect(orderSubmitProblem({ vendorId: null, lines: [{}] })).toBe('Choose the vendor.');
    expect(orderSubmitProblem({ vendorId: 'v', lines: [] })).toBe('An order needs at least one line.');
    expect(orderSubmitProblem({ vendorId: 'v', lines: [{}] })).toBeNull();
  });
});
