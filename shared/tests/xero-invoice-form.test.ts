import { describe, expect, it } from 'vitest';

import { invoiceLinesProblem, invoiceTotals, lineTotalCents, type InvoiceLineInput } from '../src/contracts/invoices';
import { invoiceTaxCents, lineTaxCents, trackingPicked, xeroLineDefaults, xeroLineProblem, type XeroInvoiceFormCompany } from '../src/contracts/xero-invoice-form';

/** The New invoice laid out as Xero's (2026-11-13, PR B). Everything invented. */

const COMPANY: XeroInvoiceFormCompany = {
  tenantId: 'homes',
  name: 'Example Home Services',
  currency: 'USD',
  accounts: [
    { accountId: 'a-400', code: '400', name: 'Service revenue' },
    { accountId: 'a-4305', code: '4305', name: 'Service: HVAC Inspection & Filter Change' },
  ],
  taxRates: [
    { taxType: 'NONE', name: 'Tax Exempt', rate: 0 },
    { taxType: 'TAX001', name: 'Tax on Sales', rate: 8.25 },
  ],
  tracking: [
    { trackingCategoryId: 'cat-1', name: 'Income by Employee', options: ['HVAC Inspection Income: Moses', 'Air Filter Income: Moses'] },
    { trackingCategoryId: 'cat-2', name: 'Expenses', options: ['Truck'] },
  ],
  items: [{ code: 'HVAC', name: 'HVAC' }],
  salesAccountId: 'a-400',
  salesTaxType: 'NONE',
  taxMode: 'EXCLUSIVE',
  trackingCategoryId: 'cat-1',
  products: { 'hvac inspection & filter change': { accountId: 'a-4305', itemCode: 'HVAC', trackingGroup: 'HVAC Inspection Income' } },
};
const line = (over: Partial<InvoiceLineInput> = {}): InvoiceLineInput => ({ name: 'HVAC Inspection & Filter Change', quantity: 1, unitPriceCents: 6450, ...over });

describe('a line filled in from its item, as Xero fills one', () => {
  it('takes the product’s account and item, the company’s tax rate, and the technician’s option in its group', () => {
    expect(xeroLineDefaults(COMPANY, ' HVAC Inspection & Filter Change ', 'Moses Example')).toEqual({
      xeroAccountId: 'a-4305',
      xeroItemCode: 'HVAC',
      xeroTaxType: 'NONE',
      xeroTracking: [{ trackingCategoryId: 'cat-1', option: 'HVAC Inspection Income: Moses' }],
    });
  });

  it('falls back to the company’s default account, and tags nothing without a technician or a group', () => {
    expect(xeroLineDefaults(COMPANY, 'Trip charge', 'Moses Example')).toEqual({ xeroAccountId: 'a-400', xeroItemCode: null, xeroTaxType: 'NONE', xeroTracking: [] });
    expect(xeroLineDefaults(COMPANY, 'HVAC Inspection & Filter Change', null).xeroTracking).toEqual([]);
  });
});

describe('a line’s amount and tax', () => {
  it('takes the discount off, as Xero works a line out, and changes nothing without one', () => {
    expect(lineTotalCents({ quantity: 1, unitPriceCents: 6450, discountRate: 10 })).toBe(5805);
    expect(lineTotalCents({ quantity: 2, unitPriceCents: 3999 })).toBe(7998);
    expect(invoiceTotals([line({ discountRate: 50 }), line()])).toEqual({ subtotalCents: 9675, totalCents: 9675 });
    expect(invoiceLinesProblem([line({ discountRate: 101 })])).toBe('HVAC Inspection & Filter Change: the discount is a percent from 0 to 100.');
  });

  it('works the tax out inside a price that includes it, on top of one that does not, and none with no tax', () => {
    // Crystal Creek Pest's $39.00 at 8.25%: $2.97 of it is tax.
    expect(lineTaxCents(3900, 8.25, 'INCLUSIVE')).toBe(297);
    expect(lineTaxCents(3900, 8.25, 'EXCLUSIVE')).toBe(322);
    expect(lineTaxCents(3900, 8.25, 'NO_TAX')).toBe(0);
    expect(invoiceTaxCents(COMPANY, [line({ unitPriceCents: 3900, xeroTaxType: 'TAX001' }), line()], 'INCLUSIVE')).toBe(297);
  });
});

describe('what the company’s books can take', () => {
  it('takes a line naming what Xero has', () => {
    expect(xeroLineProblem(line(xeroLineDefaults(COMPANY, 'HVAC Inspection & Filter Change', 'Moses')), COMPANY, 'EXCLUSIVE')).toBeNull();
  });

  it.each([
    [{ xeroAccountId: 'a-999' }, 'that account is not one of Example Home Services’s sales accounts in Xero.'],
    [{ xeroItemCode: 'GONE' }, 'Xero does not sell the item “GONE”.'],
    [{ xeroTaxType: 'OLD' }, 'that tax rate is not one of Example Home Services’s in Xero.'],
    [{ xeroTaxType: 'TAX001' }, '8.25% would go on top of the price, and the console sends no tax on top. Choose a rate with no tax, or Tax inclusive.'],
    [{ xeroTracking: [{ trackingCategoryId: 'cat-9', option: 'Truck' }] }, 'that tracking category is not an active one in Xero.'],
    [{ xeroTracking: [{ trackingCategoryId: 'cat-2', option: 'Van' }] }, 'Expenses has no option “Van”.'],
    [
      {
        xeroTracking: [
          { trackingCategoryId: 'cat-2', option: 'Truck' },
          { trackingCategoryId: 'cat-2', option: 'Truck' },
        ],
      },
      'one option in Expenses, not two.',
    ],
  ])('refuses what it does not have, or tax on top of a price that leaves it out (%#)', (over, problem) => {
    expect(xeroLineProblem(line(over), COMPANY, 'EXCLUSIVE')).toBe(`HVAC Inspection & Filter Change: ${problem}`);
  });

  it('takes a taxed rate inside a price that includes it', () => {
    expect(xeroLineProblem(line({ xeroTaxType: 'TAX001' }), COMPANY, 'INCLUSIVE')).toBeNull();
  });

  it('leaves out a tracking pick with no option', () => {
    expect(trackingPicked([{ trackingCategoryId: 'cat-1', option: ' ' }, { trackingCategoryId: 'cat-2', option: ' Truck ' }])).toEqual([{ trackingCategoryId: 'cat-2', option: 'Truck' }]);
  });
});
