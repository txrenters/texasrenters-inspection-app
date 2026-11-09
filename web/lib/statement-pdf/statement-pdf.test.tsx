/**
 * @vitest-environment node
 *
 * Rendered as the invoice and receipt PDFs are tested, on @react-pdf's Node
 * build. Everything invented.
 */
import type { StatementView } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import { statementFileName } from './download-statement';
import { StatementDocument, statementLines } from './statement-document';

const VIEW: StatementView = {
  propertyId: 'b1',
  clientName: '100 Example Way',
  address: '100 Example Way, Sampletown',
  period: 'FROM',
  from: '2026-10-16',
  on: '2026-11-20',
  openingBalanceCents: 5999,
  closingBalanceCents: 4499,
  entries: [
    { key: 'payment:pay-3', kind: 'REFUND', on: '2026-10-20', invoiceId: 'inv-2', invoiceNumber: '8440', paymentId: 'pay-3', amountCents: 1000, balanceCents: 6999, status: null, method: 'CHECK', reference: null },
    { key: 'invoice:inv-3', kind: 'INVOICE', on: '2026-11-02', invoiceId: 'inv-3', invoiceNumber: '8441', paymentId: null, amountCents: 2500, balanceCents: 9499, status: 'AWAITING_PAYMENT', method: null, reference: null },
  ],
  newestFirst: true,
  disclaimer: 'Payment is due on receipt.',
  brand: { name: 'Example Company', addressLine1: '1 Example Plaza', addressLine2: null, phone: null, email: null },
};

describe('a statement PDF', () => {
  it("lists the office's order, the balance carried forward where the period began", () => {
    expect(statementLines(VIEW).map((line) => (line.forward ? 'forward' : line.entry.key))).toEqual(['invoice:inv-3', 'payment:pay-3', 'forward']);
    expect(statementLines({ ...VIEW, newestFirst: false }).map((line) => (line.forward ? 'forward' : line.entry.key))).toEqual([
      'forward',
      'payment:pay-3',
      'invoice:inv-3',
    ]);
    // Nothing carried forward on a lifetime statement.
    expect(statementLines({ ...VIEW, period: 'LIFETIME', openingBalanceCents: 0 }).some((line) => line.forward)).toBe(false);
  });

  it('is named like the reports the office files', () => {
    expect(statementFileName(VIEW)).toBe('100 Example Way_Statement 2026-11-20.pdf');
  });

  it('renders, and over several pages for a long account', async () => {
    const { renderToBuffer } = await import('@react-pdf/renderer');
    const pages = async (view: StatementView) =>
      (await renderToBuffer(<StatementDocument view={view} />)).toString('latin1').match(/\/Type \/Page\b/g)?.length;
    expect(await pages(VIEW)).toBe(1);
    const many = Array.from({ length: 80 }, (_, index) => ({ ...VIEW.entries[1]!, key: `invoice:${index}` }));
    expect(await pages({ ...VIEW, entries: many })).toBeGreaterThan(1);
    expect(await pages({ ...VIEW, entries: [] })).toBe(1);
  });
});
