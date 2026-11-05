/**
 * @vitest-environment node
 *
 * Rendered as the report PDFs are tested, on @react-pdf's Node build. The
 * console renders a receipt in the browser, but it has no images -- the one
 * thing the two builds handle differently (see render-report-pdf.test.ts).
 */
import type { PaymentDetail } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import { receiptFileName } from './download-receipt';
import { ReceiptDocument, receiptRows } from './receipt-document';

const PAYMENT: PaymentDetail = {
  id: 'pay-1',
  paidOn: '2026-10-20',
  amountCents: 3999,
  method: 'BANK_TRANSFER',
  reference: 'ACH-77',
  note: 'From the owner ledger',
  recordedBy: null,
  recordedAt: '2026-10-20T16:00:00.000Z',
  origin: 'JOBBER',
  jobberPaymentType: 'ACH_BANK_PAYMENT',
  invoice: { id: 'inv-1', number: '8439', subject: 'For Services Rendered', clientName: '100 Example Way' },
  property: { id: 'b1', address: '100 Example Way', city: 'Sampletown' },
  invoiceTotalCents: 6499,
  invoiceBalanceCents: 2500,
  invoiceStatus: 'AWAITING_PAYMENT',
  updatedAt: '2026-10-20T16:00:00.000Z',
  writesEnabled: false,
  brand: { name: 'Example Company', addressLine1: '1 Example Plaza', addressLine2: null, phone: '555-0100', email: null },
};

describe('a payment receipt', () => {
  it('prints the day, the method, the reference, the invoice and what is left owing', () => {
    expect(receiptRows(PAYMENT)).toEqual([
      { label: 'Payment date', value: 'Oct 20, 2026' },
      { label: 'Method', value: 'Bank payment' },
      { label: 'Reference', value: 'ACH-77' },
      { label: 'Applied to invoice', value: '#8439' },
      { label: 'Invoice total', value: '$64.99' },
      { label: 'Balance remaining', value: '$25.00', strong: true },
    ]);
    // No reference row when there is none, and the subject for an unnumbered invoice.
    const plain = receiptRows({ ...PAYMENT, reference: null, invoice: { ...PAYMENT.invoice, number: null } });
    expect(plain.map((row) => row.label)).not.toContain('Reference');
    expect(plain.find((row) => row.label === 'Applied to invoice')?.value).toBe('For Services Rendered');
  });

  it('is named like the reports the office files in Propertyware', () => {
    expect(receiptFileName(PAYMENT)).toBe('100 Example Way_Receipt 2026-10-20.pdf');
    expect(receiptFileName({ ...PAYMENT, property: null, invoice: { ...PAYMENT.invoice, clientName: 'a/b example' } })).toBe(
      'A B Example_Receipt 2026-10-20.pdf',
    );
  });

  it('renders as a one-page PDF', async () => {
    const { renderToBuffer } = await import('@react-pdf/renderer');
    const bytes = await renderToBuffer(<ReceiptDocument payment={PAYMENT} />);
    const text = bytes.toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text.match(/\/Type \/Page\b/g)).toHaveLength(1);
  });
});
