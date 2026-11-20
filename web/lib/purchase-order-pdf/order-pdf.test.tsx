/**
 * @vitest-environment node
 *
 * Rendered as the invoice PDF is tested, on @react-pdf's Node build. The
 * console renders an order in the browser, but it has no images -- the one
 * thing the two builds handle differently.
 */
import { renderToBuffer } from '@react-pdf/renderer';
import { stepsFromLimit, type PurchaseOrderDetail } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import { orderFileName } from './download-order';
import { PurchaseOrderDocument, orderFacts, orderShipToLines, orderVendorLines } from './order-document';

/** Every name, address and price invented. */
const ORDER = {
  id: 'order-9',
  number: 'PO-0009',
  status: 'APPROVED',
  vendor: { id: 'vendor-hill', number: 'V00003', name: 'Hill Country Supply' },
  requisition: { id: 'req-12', number: 'PR-0012' },
  company: { tenantId: 'tenant-thmp', name: 'Example Company', purchaserCode: 'THMP' },
  expectedOn: '2026-11-24',
  lineCount: 2,
  totalCents: 20005,
  madeBy: { id: 'user-buyer', name: 'Sample Purchaser' },
  createdAt: '2026-11-18T16:02:00.000Z',
  sentAt: null,
  vendorContact: { contactName: 'A Person', email: 'orders@hill.example', phone: null },
  deliverTo: { id: 'place-stockroom', name: 'Stockroom', code: 'STORE' },
  terms: 'Net 30',
  taxBasisPoints: 825,
  notes: 'Deliver to the back door.',
  lines: [
    { id: 'ol-1', item: { id: 'item-filter', code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each' }, quantity: 36, unitPriceCents: 390, requestedQuantity: 36, receivedQuantity: 0 },
    { id: 'ol-2', item: { id: 'item-glue', code: 'PST-0001', name: 'Glue boards', unit: 'pack' }, quantity: 24, unitPriceCents: 185, requestedQuantity: 24, receivedQuantity: 0 },
  ],
  subtotalCents: 18480,
  taxCents: 1525,
  approvedBy: 'Sample Owner',
  approvedAt: '2026-11-19T15:38:00.000Z',
  decisionNote: null,
  cancelReason: null,
  from: { name: 'Example Company', addressLine1: '1 Example Plaza', addressLine2: null, phone: '555-0100', email: null },
  vendorFiles: [],
  deliveries: [],
  receipts: [],
  bill: null,
  shortCloseReason: null,
  history: [],
  can: { edit: false, change: false, submit: false, approve: false, sendBack: false, send: true, cancel: true, receive: false, reverseReceipt: false, bill: false, approveBill: false, overrideBill: false, pay: false, closeShort: false, approveBlocked: null },
  approvalSteps: stepsFromLimit(50000, 2),
  reapproveChangedOrders: false,
} satisfies PurchaseOrderDetail;

/** Every page's text, as a reader of the PDF would see it. */
async function pageTexts(pdf: Buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await getDocument({ data: new Uint8Array(pdf) }).promise;
  const pages: string[] = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    const content = await (await document.getPage(number)).getTextContent();
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }
  return pages;
}

describe('a purchase order as a PDF', () => {
  it('renders to a PDF, one line or many', async () => {
    const one = await renderToBuffer(<PurchaseOrderDocument order={ORDER} />);
    expect(one.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const many = { ...ORDER, lines: Array.from({ length: 70 }, (_, index) => ({ ...ORDER.lines[0], id: `ol-${index}` })) };
    const long = await renderToBuffer(<PurchaseOrderDocument order={many} />);
    expect(long.length).toBeGreaterThan(one.length);
    // What rides on the email must stay under the server's limit for an order's PDF, even a long one.
    expect(long.length).toBeLessThan(200_000);

    // Each page names the company and the order, and which page it is (2026-11-20).
    const pages = await pageTexts(long);
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((text, index) => {
      expect(text).toContain('Example Company · PO-0009');
      expect(text).toContain(`Page ${index + 1} of ${pages.length}`);
    });
  });

  // Laid out as the PoPdf board since 2026-11-20: two columns of facts, each printed even when empty.
  it('prints the board\'s facts: the day it was approved, the codes, and who ordered it', () => {
    expect(orderFacts(ORDER)).toEqual([
      { label: 'Order Date', value: '11/19/2026' },
      { label: 'Vendor No.', value: 'V00003' },
      { label: 'Expected Receipt', value: '11/24/2026' },
      { label: 'Purchaser Code', value: 'THMP' },
      { label: 'Payment Terms', value: 'Net 30' },
      { label: 'Location Code', value: 'STORE' },
      { label: 'Requisition No.', value: 'PR-0012' },
      { label: 'Ordered by', value: 'Sample Purchaser' },
    ]);
    const bare = orderFacts({ ...ORDER, approvedAt: null, expectedOn: null, terms: null, deliverTo: null, vendor: null, company: null });
    expect(bare.filter((fact) => fact.value)).toEqual([
      { label: 'Order Date', value: '11/18/2026' },
      { label: 'Requisition No.', value: 'PR-0012' },
      { label: 'Ordered by', value: 'Sample Purchaser' },
    ]);
  });

  it('names the vendor by number, and whoever the office deals with there', () => {
    expect(orderVendorLines(ORDER)).toEqual(['V00003 · Hill Country Supply', 'Attn: A Person', 'orders@hill.example']);
    expect(orderVendorLines({ ...ORDER, vendor: null, vendorContact: null })).toEqual(['No vendor chosen']);
  });

  it('ships to the place by its code, at the office, for the order\'s company', () => {
    expect(orderShipToLines(ORDER)).toEqual(['STORE · Stockroom', 'Example Company', '1 Example Plaza', 'Receiving: 555-0100']);
    expect(orderShipToLines({ ...ORDER, deliverTo: null, company: null, from: { ...ORDER.from, phone: null } })).toEqual(['The office', 'Example Company', '1 Example Plaza']);
  });

  it('is filed under its number and its vendor', () => {
    expect(orderFileName(ORDER)).toBe('PO-0009 Hill Country Supply.pdf');
    expect(orderFileName({ number: null, vendor: { id: 'v', name: 'A/B: Supply' } })).toBe('Purchase order draft A B Supply.pdf');
  });
});
