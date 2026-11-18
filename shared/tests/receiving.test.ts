import { describe, expect, it } from 'vitest';

import { billProblems, receiptNumber, type BillMatchLine } from '../src/contracts/receiving';

// Receiving and the vendor's bill, phase 4 (2026-11-19). Every figure invented.
const line = (over: Partial<BillMatchLine> = {}): BillMatchLine => ({ name: 'Filter 20x25x1', ordered: 36, received: 36, unitPriceCents: 390, billedQuantity: 36, billedUnitPriceCents: 390, ...over });
const batteries = (over: Partial<BillMatchLine> = {}): BillMatchLine => line({ name: 'Battery, 9 V', ordered: 24, received: 24, unitPriceCents: 185, billedQuantity: 24, billedUnitPriceCents: 185, ...over });

describe('a receipt\'s number', () => {
  it('is RCV- and at least four digits', () => {
    expect(receiptNumber(7)).toBe('RCV-0007');
    expect(receiptNumber(12345)).toBe('RCV-12345');
  });
});

describe('matching a bill to its order and its receipts', () => {
  it('finds nothing wrong when it bills what arrived, at the order\'s prices, for the right total', () => {
    expect(billProblems([line(), batteries()], 20005, 825)).toEqual([]);
    expect(billProblems([line(), batteries()], 18480, 0)).toEqual([]);
  });

  it('says so when more is billed than has arrived', () => {
    expect(billProblems([line(), batteries({ received: 20 })], 20005, 825)).toEqual(['Battery, 9 V: billed for 24, and 20 have arrived.']);
    expect(billProblems([line({ received: 1, billedQuantity: 2 })], 844, 825)).toEqual(['Filter 20x25x1: billed for 2, and 1 has arrived.']);
  });

  it('passes a bill for part of what arrived, and one that leaves a line out', () => {
    // 36 filters and 20 of the 24 batteries: $177.40 and $14.64 of tax.
    expect(billProblems([line(), batteries({ billedQuantity: 20 })], 19204, 825)).toEqual([]);
    expect(billProblems([line(), batteries({ billedQuantity: 0, billedUnitPriceCents: null })], 15198, 825)).toEqual([]);
  });

  it('says so when a price is not the order\'s, and when the total is not its lines with tax', () => {
    expect(billProblems([line({ billedUnitPriceCents: 400 })], 15588, 825)).toEqual(['Filter 20x25x1: billed at $4.00 each, ordered at $3.90.']);
    expect(billProblems([line()], 21000, 825)).toEqual(["The bill's total is $210.00; its lines with 8.25% tax come to $151.98."]);
    expect(billProblems([line()], 15000, 0)).toEqual(["The bill's total is $150.00; its lines come to $140.40."]);
  });

  it('holds a bill with no lines', () => {
    expect(billProblems([line({ billedQuantity: 0, billedUnitPriceCents: null })], 0, 825)).toEqual(['The bill has no lines.']);
    expect(billProblems([], 100, 0)).toEqual(['The bill has no lines.']);
  });
});
