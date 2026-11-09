/**
 * @vitest-environment node
 *
 * Rendered as the receipts and report PDFs are tested, on @react-pdf's Node
 * build. The console renders an invoice in the browser, but it has no images
 * -- the one thing the two builds handle differently.
 */
import { invoiceTotalLines, type InvoiceDetail, type InvoiceExtraDetails } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import { invoiceFileName } from './download-invoice';
import { InvoiceDocument, InvoicesDocument, billTo, invoiceFacts } from './invoice-document';

const BRAND = { name: 'Example Company', addressLine1: '1 Example Plaza', addressLine2: null, phone: '555-0100', email: null };

const INVOICE = {
  id: 'inv-1',
  number: '8439',
  subject: 'For Services Rendered',
  status: 'AWAITING_PAYMENT',
  clientName: '100 Example Way',
  property: { id: 'b1', address: '100 Example Way', city: 'Sampletown' },
  inspectionId: null,
  jobNumber: '1207',
  issuedOn: '2026-11-01',
  dueOn: '2026-12-01',
  totalCents: 6499,
  balanceCents: 2500,
  jobberUrl: null,
  paymentTerms: 'Net 30',
  billingAddress: '9 Sample Road, Sampletown',
  lineItems: [
    { name: 'Filter Change', description: null, quantity: 1, unitPriceCents: 3999, totalCents: 3999 },
    { name: 'Pest Control', description: 'Front and back', quantity: 1, unitPriceCents: 2500, totalCents: 2500 },
  ],
  subtotalCents: 6499,
  taxCents: 0,
  payments: [],
  clientMessage: 'Thank you for your business.',
  accountBalanceCents: null,
  createdAt: '2026-11-01T14:00:00.000Z',
  paidCents: 3999,
  details: {
    billingName: 'Example Owner LLC',
    billingSameAsProperty: false,
    discountCents: 0,
    discountPercent: null,
    taxRateName: null,
    taxRatePercent: null,
    contractDisclaimer: 'Payment is due within 30 days.',
  } as unknown as InvoiceExtraDetails,
} as InvoiceDetail;

describe('an invoice PDF', () => {
  it('prints the days, the terms and the job beside who pays it', () => {
    expect(invoiceFacts(INVOICE)).toEqual([
      { label: 'Issued', value: 'Nov 1, 2026' },
      { label: 'Due', value: 'Dec 1, 2026' },
      { label: 'Terms', value: 'Net 30' },
      { label: 'Job', value: '#1207' },
    ]);
    expect(billTo(INVOICE)).toEqual(['Example Owner LLC', '9 Sample Road, Sampletown']);
    // The billing address left out when Jobber says it is the property's.
    expect(billTo({ ...INVOICE, details: { ...INVOICE.details!, billingSameAsProperty: true } })).toEqual(['Example Owner LLC']);
  });

  it('prints the same totals as its email, the balance due last', () => {
    expect(invoiceTotalLines(INVOICE)).toEqual([
      { label: 'Subtotal', value: '$64.99' },
      { label: 'Total', value: '$64.99' },
      { label: 'Paid', value: '-$39.99' },
      { label: 'Balance due', value: '$25.00', strong: true },
    ]);
  });

  it('is named like the reports the office files in Propertyware', () => {
    expect(invoiceFileName(INVOICE)).toBe('100 Example Way_Invoice 8439.pdf');
    expect(invoiceFileName({ ...INVOICE, number: null, property: null, clientName: 'a/b example' })).toBe('A B Example_Invoice 2026-11-01.pdf');
  });

  it('renders on one page, and over several when it has many lines', async () => {
    const { renderToBuffer } = await import('@react-pdf/renderer');
    const pages = async (invoice: InvoiceDetail) =>
      (await renderToBuffer(<InvoiceDocument brand={BRAND} invoice={invoice} />)).toString('latin1').match(/\/Type \/Page\b/g)?.length;

    const short = await renderToBuffer(<InvoiceDocument brand={BRAND} invoice={INVOICE} />);
    expect(short.toString('latin1').startsWith('%PDF-')).toBe(true);
    expect(await pages(INVOICE)).toBe(1);

    const many = Array.from({ length: 60 }, (_, index) => ({ ...INVOICE.lineItems[1]!, name: `Service ${index + 1}` }));
    expect(await pages({ ...INVOICE, lineItems: many })).toBeGreaterThan(1);
  });

  it('prints many invoices in one file, each on pages of its own (Batch Deliver)', async () => {
    const { renderToBuffer } = await import('@react-pdf/renderer');
    const pagesOf = async (invoices: InvoiceDetail[]) =>
      (
        await renderToBuffer(<InvoicesDocument brand={BRAND} invoices={invoices.map((invoice) => ({ invoice, brand: BRAND }))} />)
      )
        .toString('latin1')
        .match(/\/Type \/Page\b/g)?.length ?? 0;
    const many = Array.from({ length: 60 }, (_, index) => ({ ...INVOICE.lineItems[1]!, name: `Service ${index + 1}` }));
    const long = { ...INVOICE, id: 'inv-2', number: '8440', lineItems: many };

    expect(await pagesOf([INVOICE, { ...INVOICE, id: 'inv-3' }])).toBe(2);
    const longAlone = await pagesOf([long]);
    expect(longAlone).toBeGreaterThan(1);
    // Each starts a page of its own: the long one's pages, plus one each for the others.
    expect(await pagesOf([INVOICE, long, { ...INVOICE, id: 'inv-3' }])).toBe(longAlone + 2);
  });
});
