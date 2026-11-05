import { describe, expect, it } from 'vitest';

import {
  canDeleteInvoice,
  invoiceAmounts,
  invoiceEditProblem,
  invoiceStatusActionProblem,
  invoiceStatusActions,
  isEditableInvoiceStatus,
  type EditInvoiceInput,
} from '../src/contracts/invoice-edits';

/** Editing an invoice (2026-11-06): its totals worked out from the lines, and what may be done to its state. */

const filter = { name: 'Filter Change', quantity: 1, unitPriceCents: 3999 };
const pest = { name: 'Pest Control', quantity: 1, unitPriceCents: 2500 };

describe("an invoice's money", () => {
  it('is its lines with nothing off and no tax', () => {
    expect(invoiceAmounts([filter, pest], null, null)).toEqual({ subtotalCents: 6499, discountCents: 0, taxCents: 0, totalCents: 6499 });
  });

  it('takes a percent or an amount off the subtotal', () => {
    expect(invoiceAmounts([filter, pest], { kind: 'PERCENT', percent: 10 }, null)).toMatchObject({ discountCents: 650, totalCents: 5849 });
    expect(invoiceAmounts([filter, pest], { kind: 'AMOUNT', amountCents: 500 }, null)).toMatchObject({ discountCents: 500, totalCents: 5999 });
  });

  it('taxes the taxed lines after their share of the discount, and leaves untaxed lines alone', () => {
    // 8.25% of the $39.99 filter only.
    expect(invoiceAmounts([filter, { ...pest, taxable: false }], null, { name: 'Texas', percent: 8.25 })).toMatchObject({
      taxCents: 330,
      totalCents: 6829,
    });
    // $10.00 off $64.99; the filter's share is $6.15, so the tax is on $33.84: $2.79.
    expect(
      invoiceAmounts([filter, { ...pest, taxable: false }], { kind: 'AMOUNT', amountCents: 1000 }, { name: 'Texas', percent: 8.25 }),
    ).toEqual({ subtotalCents: 6499, discountCents: 1000, taxCents: 279, totalCents: 5778 });
  });
});

describe('what an edit may be', () => {
  const edit = (over: Partial<EditInvoiceInput> = {}) => ({
    subject: 'For Services Rendered',
    number: '8439',
    issuedOn: '2026-11-01',
    dueOn: '2026-12-01',
    lineItems: [filter, pest],
    discount: null,
    tax: null,
    ...over,
  });

  it('is fine as it stands', () => {
    expect(invoiceEditProblem(edit(), 0)).toBeNull();
    // A draft never numbered stays unnumbered.
    expect(invoiceEditProblem(edit({ number: null }), 0)).toBeNull();
  });

  it('says what is missing or wrong, in words', () => {
    expect(invoiceEditProblem(edit({ subject: ' ' }), 0)).toBe('Give the invoice a subject.');
    expect(invoiceEditProblem(edit({ number: ' ' }), 0)).toBe('Give the invoice a number.');
    expect(invoiceEditProblem(edit({ dueOn: '2026-10-31' }), 0)).toBe('It cannot be due before it is issued.');
    expect(invoiceEditProblem(edit({ lineItems: [] }), 0)).toBe('Add at least one line.');
    expect(invoiceEditProblem(edit({ lineItems: [{ ...filter, serviceOn: 'soon' }] }), 0)).toBe('Give each service day as a date.');
    expect(invoiceEditProblem(edit({ discount: { kind: 'PERCENT', percent: 120 } }), 0)).toBe('A discount is between 0 and 100 percent.');
    expect(invoiceEditProblem(edit({ discount: { kind: 'AMOUNT', amountCents: 7000 } }), 0)).toBe('The discount is more than the $64.99 subtotal.');
    expect(invoiceEditProblem(edit({ tax: { name: '', percent: 8.25 } }), 0)).toBe('Name the tax, as it prints on the invoice.');
    expect(invoiceEditProblem(edit({ tax: { name: 'Texas', percent: 40 } }), 0)).toBe('A tax is between 0 and 25 percent.');
  });

  it('never comes to less than what has been paid on it', () => {
    expect(invoiceEditProblem(edit({ lineItems: [pest] }), 3999)).toBe(
      'It would come to $25.00, less than the $39.99 already paid. Change or remove a payment first.',
    );
    expect(invoiceEditProblem(edit(), 6499)).toBeNull();
  });
});

describe("an invoice's state", () => {
  const invoice = (status: Parameters<typeof isEditableInvoiceStatus>[0], balanceCents = 3999, paidCents = 0) => ({
    status,
    balanceCents,
    paidCents,
  });

  it('offers what Jobber offers for each state', () => {
    expect(invoiceStatusActions(invoice('DRAFT'))).toEqual(['MARK_SENT', 'VOID']);
    expect(invoiceStatusActions(invoice('AWAITING_PAYMENT'))).toEqual(['VOID', 'BAD_DEBT']);
    expect(invoiceStatusActions(invoice('PAST_DUE', 1000, 2999))).toEqual(['BAD_DEBT']);
    expect(invoiceStatusActions(invoice('PAID', 0, 3999))).toEqual([]);
    expect(invoiceStatusActions(invoice('VOIDED', 0))).toEqual(['REOPEN']);
    expect(invoiceStatusActions(invoice('BAD_DEBT'))).toEqual(['REOPEN']);
  });

  it('says why an action is not open', () => {
    expect(invoiceStatusActionProblem('VOID', invoice('AWAITING_PAYMENT', 1000, 2999))).toBe(
      'It has payments. Remove them first, or close it as bad debt.',
    );
    expect(invoiceStatusActionProblem('VOID', invoice('PAID', 0, 3999))).toBe('A paid invoice is not voided.');
    expect(invoiceStatusActionProblem('REOPEN', invoice('PAID', 0, 3999))).toBe('Only a voided or bad-debt invoice is reopened.');
  });

  it('is edited while it is a draft, owing or paid; reopened first otherwise', () => {
    expect(['DRAFT', 'AWAITING_PAYMENT', 'PAST_DUE', 'PAID'].every((status) => isEditableInvoiceStatus(status as never))).toBe(true);
    expect(isEditableInvoiceStatus('VOIDED')).toBe(false);
    expect(isEditableInvoiceStatus('BAD_DEBT')).toBe(false);
  });

  it('is deleted only as a draft nobody paid anything on', () => {
    expect(canDeleteInvoice({ status: 'DRAFT', paidCents: 0 })).toBe(true);
    expect(canDeleteInvoice({ status: 'DRAFT', paidCents: 100 })).toBe(false);
    expect(canDeleteInvoice({ status: 'AWAITING_PAYMENT', paidCents: 0 })).toBe(false);
  });
});
