import { describe, expect, it } from 'vitest';

import { XERO_INVOICE_STATUS_LABEL, xeroInvoiceUrl } from '../src/contracts/invoices.js';

/** Opening an invoice in its company's books in Xero (2026-11-12). Ids invented. */
describe('an invoice’s page in Xero', () => {
  it('opens a draft to edit and any other to read, in the right company through its short code', () => {
    expect(xeroInvoiceUrl('x-1', 'DRAFT', '!abc12')).toBe(
      'https://go.xero.com/organisationlogin/default.aspx?shortcode=!abc12&redirecturl=%2FAccountsReceivable%2FEdit.aspx%3FInvoiceID%3Dx-1',
    );
    expect(xeroInvoiceUrl('x-1', 'AUTHORISED', null)).toBe('https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=x-1');
    expect(xeroInvoiceUrl('x-1', 'SUBMITTED', null)).toContain('/Edit.aspx');
  });

  it('says each of Xero’s statuses in the office’s words', () => {
    expect(XERO_INVOICE_STATUS_LABEL.DRAFT).toBe('Draft in Xero');
    expect(XERO_INVOICE_STATUS_LABEL.PAID).toBe('Paid');
  });
});
