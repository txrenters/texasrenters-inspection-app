import { describe, expect, it } from 'vitest';

import { billedLines, billingRuleProblem, billingRuleWhen, type BillingProduct, type NewBillingRule } from '../src/contracts/invoice-billing-rules.js';

/**
 * What a finished visit bills (2026-11-12): the office's rules, as THMP's six
 * months of invoices suggest them, and the pest control the office adds for
 * Crystal Creek Pest. Prices as the office charges them; ids invented.
 */

const PRODUCTS: BillingProduct[] = [
  { id: 'filter', name: 'Filter Change', unitPriceCents: 3999, active: true },
  { id: 'hvac', name: 'HVAC Inspection & Filter Change', unitPriceCents: 6450, active: true },
  { id: 'move-out', name: 'Move Out Inspection', unitPriceCents: 7500, active: true },
  { id: 'pest', name: 'Pest Control', unitPriceCents: 3900, active: true },
  { id: 'flea', name: 'Flea Treatment', unitPriceCents: 0, active: true },
  { id: 'old', name: 'Occupied Inspection', unitPriceCents: 2500, active: false },
];
const RULES: NewBillingRule[] = [
  { inspectionType: 'OCCUPIED', service: null, productId: 'filter' },
  { inspectionType: 'HVAC', service: null, productId: 'hvac' },
  { inspectionType: 'MOVE_OUT', service: null, productId: 'move-out' },
  // Added first among them, and still billed after the visit's own type.
  { inspectionType: null, service: 'pestControl', productId: 'pest' },
  { inspectionType: null, service: 'fleaTreatment', productId: 'flea' },
];
const line = (name: string, unitPriceCents: number) => ({ name, description: null, quantity: 1, unitPriceCents });

describe("a finished visit's lines", () => {
  it('are what its type bills, whatever the report says', () => {
    expect(billedLines({ inspectionType: 'OCCUPIED', services: [] }, RULES, PRODUCTS)).toEqual({ lineItems: [line('Filter Change', 3999)], problem: null });
    expect(billedLines({ inspectionType: 'MOVE_OUT', services: [] }, RULES, PRODUCTS).lineItems).toEqual([line('Move Out Inspection', 7500)]);
  });

  it('add what a service done bills, after the type, each product once', () => {
    const rules = [{ inspectionType: null, service: 'pestControl' as const, productId: 'pest' }, ...RULES];
    expect(billedLines({ inspectionType: 'HVAC', services: ['filterChange', 'pestControl'] }, rules, PRODUCTS)).toEqual({
      lineItems: [line('HVAC Inspection & Filter Change', 6450), line('Pest Control', 3900)],
      problem: null,
    });
  });

  it('take a rule for a type and a service only when both hold', () => {
    const rules: NewBillingRule[] = [{ inspectionType: 'HVAC', service: 'filterChange', productId: 'filter' }];
    expect(billedLines({ inspectionType: 'HVAC', services: ['filterChange'] }, rules, PRODUCTS).lineItems).toEqual([line('Filter Change', 3999)]);
    expect(billedLines({ inspectionType: 'OCCUPIED', services: ['filterChange'] }, rules, PRODUCTS).lineItems).toEqual([]);
    expect(billedLines({ inspectionType: 'HVAC', services: [] }, rules, PRODUCTS).lineItems).toEqual([]);
  });

  it('are none, with the reason, when no rule covers the visit: never billed at $0', () => {
    expect(billedLines({ inspectionType: 'ROOF', services: [] }, RULES, PRODUCTS)).toEqual({
      lineItems: [],
      problem: 'No rule says what this visit bills (Roof inspection). Add one under Invoices → Settings.',
    });
  });

  it('keep a line with no price yet for the editor to ask, and say so', () => {
    expect(billedLines({ inspectionType: 'OCCUPIED', services: ['fleaTreatment'] }, RULES, PRODUCTS)).toEqual({
      lineItems: [line('Filter Change', 3999), line('Flea Treatment', 0)],
      problem: 'No price yet for Flea Treatment. Set one under Invoices → Settings.',
    });
  });

  it('bill nothing for a product set aside, and say so', () => {
    const rules: NewBillingRule[] = [{ inspectionType: 'OCCUPIED', service: null, productId: 'old' }];
    expect(billedLines({ inspectionType: 'OCCUPIED', services: [] }, rules, PRODUCTS)).toEqual({
      lineItems: [],
      problem: 'Occupied Inspection is set aside. Offer it again, or change the rule, under Invoices → Settings.',
    });
  });
});

describe('a rule, in words', () => {
  it('says which visits it is for', () => {
    expect(billingRuleWhen({ inspectionType: 'MOVE_OUT', service: null })).toBe('Move-out inspection visits');
    expect(billingRuleWhen({ inspectionType: null, service: 'pestControl' })).toBe('Visits with pest control done');
    expect(billingRuleWhen({ inspectionType: 'HVAC', service: 'filterChange' })).toBe('HVAC inspection visits with AC filter change done');
  });

  it('must be for some visits in particular', () => {
    expect(billingRuleProblem({ inspectionType: null, service: null })).toBe('Say which visits it is for: their type, a service done, or both.');
    expect(billingRuleProblem({ inspectionType: 'HVAC', service: null })).toBeNull();
  });
});
