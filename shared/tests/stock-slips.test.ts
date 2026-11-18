import { describe, expect, it } from 'vitest';

import { MACHINE_FORBIDDEN_PERMISSIONS, PERMISSION_KEYS, STOCK_MOVEMENT_KINDS, STOCK_SLIP_KINDS, stockSlipNumber, stockSlipProblem, stockSlipSeries, type PostStockSlipInput } from '../src/index.js';

/** Withdrawals, returns and moves, phase 5 (2026-11-19). Every id and code invented. */

const onHand = new Map([
  ['filter', 40],
  ['battery', 1],
]);
const name = (itemId: string) => (itemId === 'filter' ? 'FLT-0003' : 'PRT-0001');
const slip = (over: Partial<PostStockSlipInput> = {}) => ({ kind: 'WITHDRAWAL' as const, technicianId: 'tech', fromPlaceId: 'stockroom', toPlaceId: null, lines: [{ itemId: 'filter', quantity: 4 }], ...over });
const problem = (over: Partial<PostStockSlipInput> = {}, there: ReadonlyMap<string, number> = onHand) => stockSlipProblem(slip(over), there, name);

describe('a slip number', () => {
  it('has a series a kind', () => {
    expect(STOCK_SLIP_KINDS.map((kind) => stockSlipNumber(kind, 31))).toEqual(['WD-0031', 'RT-0031', 'TR-0031']);
    expect(STOCK_SLIP_KINDS.map(stockSlipSeries)).toEqual(['WD', 'RT', 'TR']);
    expect(stockSlipNumber('WITHDRAWAL', 12345)).toBe('WD-12345');
  });

  it('is a kind of stock movement too', () => {
    for (const kind of STOCK_SLIP_KINDS) expect(STOCK_MOVEMENT_KINDS).toContain(kind);
  });
});

describe('why a slip cannot be posted', () => {
  it('is nothing when it can', () => {
    expect(problem()).toBeNull();
    expect(problem({ lines: [{ itemId: 'filter', quantity: 40 }] })).toBeNull();
  });

  it('asks who, from where and to where, by kind', () => {
    expect(problem({ technicianId: null })).toBe('Say who is taking it.');
    expect(problem({ kind: 'RETURN', technicianId: null })).toBe('Say who is bringing it back.');
    expect(problem({ fromPlaceId: null })).toBe('Choose where it is taken from.');
    expect(problem({ kind: 'RETURN', fromPlaceId: null })).toBe('Choose where it goes.');
    expect(problem({ kind: 'TRANSFER', technicianId: null })).toBe('Choose where it goes.');
    expect(problem({ kind: 'TRANSFER', technicianId: null, toPlaceId: 'stockroom' })).toBe('Choose two different places.');
    expect(problem({ kind: 'TRANSFER', technicianId: null, toPlaceId: 'van' })).toBeNull();
    expect(problem({ lines: [] })).toBe('Add at least one item.');
  });

  it('never lets more leave a place than is there', () => {
    expect(problem({ lines: [{ itemId: 'filter', quantity: 41 }] })).toBe('Only 40 of FLT-0003 are there.');
    expect(problem({ lines: [{ itemId: 'battery', quantity: 2 }] })).toBe('Only 1 of PRT-0001 is there.');
    expect(problem({}, new Map())).toBe('None of FLT-0003 is there.');
    expect(problem({ kind: 'TRANSFER', technicianId: null, toPlaceId: 'van', lines: [{ itemId: 'battery', quantity: 2 }] })).toBe('Only 1 of PRT-0001 is there.');
  });

  it('does not ask what is there of a return', () => {
    expect(problem({ kind: 'RETURN', fromPlaceId: null, toPlaceId: 'stockroom', lines: [{ itemId: 'battery', quantity: 99 }] }, new Map())).toBeNull();
  });
});

describe('recording withdrawals', () => {
  it('is a permission of its own that no API key may hold', () => {
    expect(PERMISSION_KEYS).toContain('inventory:withdraw');
    expect(MACHINE_FORBIDDEN_PERMISSIONS).toContain('inventory:withdraw');
  });
});
