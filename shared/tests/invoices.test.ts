import { describe, expect, it } from 'vitest';

import {
  acceptsPayment,
  dueOnFor,
  formatMoney,
  formatMoneyShort,
  invoiceLinesProblem,
  invoiceStatusOn,
  invoiceTotals,
  parseMoney,
  paymentProblem,
  paymentTermsLabel,
} from '../src/contracts/invoices';

/** Past due is worked out on the day it is read, never stored. */
describe('the status on a day', () => {
  it('is past due once the due day has gone, and only for an invoice awaiting payment', () => {
    expect(invoiceStatusOn('AWAITING_PAYMENT', '2026-11-04', '2026-11-05')).toBe('PAST_DUE');
    // Due today is not past due yet.
    expect(invoiceStatusOn('AWAITING_PAYMENT', '2026-11-05', '2026-11-05')).toBe('AWAITING_PAYMENT');
    expect(invoiceStatusOn('AWAITING_PAYMENT', null, '2026-11-05')).toBe('AWAITING_PAYMENT');
    expect(invoiceStatusOn('PAID', '2026-01-01', '2026-11-05')).toBe('PAID');
    expect(invoiceStatusOn('DRAFT', '2026-01-01', '2026-11-05')).toBe('DRAFT');
  });

  it("names the terms as Jobber does", () => {
    expect(paymentTermsLabel(30)).toBe('Net 30');
    expect(paymentTermsLabel(0)).toBe('Due upon receipt');
    expect(paymentTermsLabel(21)).toBe('Net 21');
    expect(paymentTermsLabel(null)).toBeNull();
  });
});

/** Money in the console: whole cents, never floating-point dollars. */
describe('money', () => {
  it('reads as dollars and cents', () => {
    expect(formatMoney(3999)).toBe('$39.99');
    expect(formatMoney(123456)).toBe('$1,234.56');
    expect(formatMoney(-3999)).toBe('-$39.99');
    expect(formatMoney(0)).toBe('$0.00');
  });

  it('shortens past ten thousand, as Jobber’s Overview does', () => {
    expect(formatMoneyShort(957600)).toBe('$9,576');
    expect(formatMoneyShort(1_360_000)).toBe('$13.6k');
    expect(formatMoneyShort(398000)).toBe('$3,980');
  });

  it('takes what is typed, and refuses what is not an amount', () => {
    expect(parseMoney('39.99')).toBe(3999);
    expect(parseMoney('$1,250')).toBe(125000);
    expect(parseMoney('40.5')).toBe(4050);
    expect(parseMoney(' 0.10 ')).toBe(10);
    expect(parseMoney('39.999')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('-5')).toBeNull();
    expect(parseMoney('')).toBeNull();
  });

  /** $0.10 three times is $0.30 exactly, which floating-point dollars cannot promise. */
  it('adds lines up in whole cents', () => {
    expect(invoiceTotals([{ quantity: 3, unitPriceCents: 10 }])).toEqual({ subtotalCents: 30, totalCents: 30 });
    expect(
      invoiceTotals([
        { quantity: 1, unitPriceCents: 3999 },
        { quantity: 2, unitPriceCents: 1250 },
      ]).totalCents,
    ).toBe(6499);
  });

  it('works out the due day from the terms', () => {
    expect(dueOnFor('2026-09-30', 30)).toBe('2026-10-30');
    expect(dueOnFor('2026-12-15', 30)).toBe('2027-01-14');
    expect(dueOnFor('2026-11-05', 0)).toBe('2026-11-05');
  });
});

describe('what may be invoiced', () => {
  const line = { name: 'Filter Change', quantity: 1, unitPriceCents: 3999 };

  it('takes ordinary lines', () => {
    expect(invoiceLinesProblem([line])).toBeNull();
  });

  it('says what is wrong, in words', () => {
    expect(invoiceLinesProblem([])).toBe('Add at least one line.');
    expect(invoiceLinesProblem([{ ...line, name: ' ' }])).toBe('Every line needs a name.');
    expect(invoiceLinesProblem([{ ...line, quantity: 0 }])).toMatch(/quantity/);
    expect(invoiceLinesProblem([{ ...line, unitPriceCents: 39.99 }])).toMatch(/dollars and cents/);
    expect(invoiceLinesProblem([{ ...line, unitPriceCents: 0 }])).toBe('The invoice comes to nothing.');
    // A typo, caught before Jobber has it.
    expect(invoiceLinesProblem([{ ...line, unitPriceCents: 399_900_000 }])).toMatch(/Check the prices/);
  });
});

describe('what may be recorded as paid', () => {
  const today = '2026-11-05';

  it('takes a payment up to what is still owed, today or before', () => {
    expect(paymentProblem({ amountCents: 3999, paidOn: today }, 3999, today)).toBeNull();
    expect(paymentProblem({ amountCents: 2000, paidOn: '2026-10-31' }, 3999, today)).toBeNull();
  });

  it('refuses more than is owed, nothing, and a day still to come', () => {
    expect(paymentProblem({ amountCents: 4000, paidOn: today }, 3999, today)).toBe(
      'That is more than the $39.99 this invoice still owes.',
    );
    expect(paymentProblem({ amountCents: 0, paidOn: today }, 3999, today)).toBe('Give the amount paid.');
    expect(paymentProblem({ amountCents: 3999, paidOn: '2026-11-06' }, 3999, today)).toMatch(/still to come/);
  });

  it('is offered only on a sent invoice that still owes something', () => {
    expect(acceptsPayment({ status: 'PAST_DUE', balanceCents: 3999 })).toBe(true);
    expect(acceptsPayment({ status: 'AWAITING_PAYMENT', balanceCents: 3999 })).toBe(true);
    expect(acceptsPayment({ status: 'PAID', balanceCents: 0 })).toBe(false);
    expect(acceptsPayment({ status: 'DRAFT', balanceCents: 3999 })).toBe(false);
    expect(acceptsPayment({ status: 'VOIDED', balanceCents: 3999 })).toBe(false);
  });
});
