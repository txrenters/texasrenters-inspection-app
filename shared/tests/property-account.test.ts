import { describe, expect, it } from 'vitest';

import { runningBalance, statementQueryProblem, statementSlice } from '../src/contracts/property-account';

const entry = (on: string, amountCents: number, kind: 'INVOICE' | 'PAYMENT' = amountCents > 0 ? 'INVOICE' : 'PAYMENT') => ({
  kind,
  on,
  amountCents,
  order: kind === 'INVOICE' ? 0 : 2,
});

describe("a property's running balance", () => {
  it('adds invoices and takes payments away, oldest first, the invoice before a payment the same day', () => {
    const rows = runningBalance([entry('2026-10-15', -2000), entry('2026-10-15', 3999), entry('2026-09-01', 7500), entry('2026-09-30', -7500)]);
    expect(rows.map((row) => [row.on, row.amountCents, row.balanceCents])).toEqual([
      ['2026-09-01', 7500, 7500],
      ['2026-09-30', -7500, 0],
      ['2026-10-15', 3999, 3999],
      ['2026-10-15', -2000, 1999],
    ]);
  });
});

describe('what a statement covers', () => {
  const ledger = runningBalance([entry('2026-09-01', 7500), entry('2026-09-30', -7500), entry('2026-10-15', 3999), entry('2026-10-20', -2000)]);

  it('a lifetime statement is everything', () => {
    expect(statementSlice(ledger, { period: 'LIFETIME' })).toMatchObject({ openingBalanceCents: 0, from: '2026-09-01' });
    expect(statementSlice(ledger, { period: 'LIFETIME' }).entries).toHaveLength(4);
  });

  it('since the last zero balance starts after the account last stood at nothing', () => {
    const slice = statementSlice(ledger, { period: 'SINCE_ZERO' });
    expect(slice.entries.map((row) => row.on)).toEqual(['2026-10-15', '2026-10-20']);
    expect(slice.openingBalanceCents).toBe(0);
  });

  it('from a day carries forward what was owed before it, even with nothing after', () => {
    expect(statementSlice(ledger, { period: 'FROM', from: '2026-10-16' })).toMatchObject({ openingBalanceCents: 3999, from: '2026-10-16' });
    expect(statementSlice(ledger, { period: 'FROM', from: '2026-11-01' })).toEqual({ entries: [], openingBalanceCents: 1999, from: '2026-11-01' });
    expect(statementSlice(ledger, { period: 'FROM', from: '2026-01-01' }).openingBalanceCents).toBe(0);
  });

  it('an account with nothing in it is an empty statement', () => {
    expect(statementSlice([], { period: 'SINCE_ZERO' })).toEqual({ entries: [], openingBalanceCents: 0, from: null });
  });

  it('needs a first day that has come', () => {
    expect(statementQueryProblem({ period: 'FROM' }, '2026-11-20')).toBe('Pick the day the statement starts.');
    expect(statementQueryProblem({ period: 'FROM', from: '2026-11-21' }, '2026-11-20')).toBe('A statement cannot start after today.');
    expect(statementQueryProblem({ period: 'FROM', from: '2026-11-20' }, '2026-11-20')).toBeNull();
    expect(statementQueryProblem({ period: 'LIFETIME' }, '2026-11-20')).toBeNull();
  });
});
