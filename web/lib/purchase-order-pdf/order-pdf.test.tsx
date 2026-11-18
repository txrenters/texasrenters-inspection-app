/**
 * @vitest-environment node
 *
 * Rendered as the invoice PDF is tested, on @react-pdf's Node build. The
 * console renders an order in the browser, but it has no images -- the one
 * thing the two builds handle differently.
 */
import { renderToBuffer } from '@react-pdf/renderer';
import type { PurchaseOrderDetail } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import { orderFileName } from './download-order';
import { PurchaseOrderDocument, orderFacts, orderVendorLines } from './order-document';

/** Every name, address and price invented. */
const ORDER = {
  id: 'order-9',
  number: 'PO-0009',
  status: 'APPROVED',
  vendor: { id: 'vendor-hill', name: 'Hill Country Supply' },
  requisition: { id: 'req-12', number: 'PR-0012' },
  company: { tenantId: 'tenant-thmp', name: 'Example Company' },
  expectedOn: '2026-11-24',
  lineCount: 2,
  totalCents: 20005,
  madeBy: { id: 'user-buyer', name: 'Sample Purchaser' },
  createdAt: '2026-11-18T16:02:00.000Z',
  sentAt: null,
  vendorContact: { contactName: 'A Person', email: 'orders@hill.example', phone: null },
  deliverTo: { id: 'place-stockroom', name: 'Stockroom' },
  terms: 'Net 30',
  taxBasisPoints: 825,
  notes: 'Deliver to the back door.',
  lines: [
    { id: 'ol-1', item: { id: 'item-filter', code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each' }, quantity: 36, unitPriceCents: 390, requestedQuantity: 36 },
    { id: 'ol-2', item: { id: 'item-glue', code: 'PST-0001', name: 'Glue boards', unit: 'pack' }, quantity: 24, unitPriceCents: 185, requestedQuantity: 24 },
  ],
  subtotalCents: 18480,
  taxCents: 1525,
  approvedBy: 'Sample Owner',
  approvedAt: '2026-11-19T15:38:00.000Z',
  decisionNote: null,
  cancelReason: null,
  from: { name: 'Example Company', addressLine1: '1 Example Plaza', addressLine2: null, phone: '555-0100', email: null },
  deliveries: [],
  history: [],
  can: { edit: false, submit: false, approve: false, sendBack: false, send: true, cancel: true, approveBlocked: null },
  approvalLimitCents: 50000,
} satisfies PurchaseOrderDetail;

describe('a purchase order as a PDF', () => {
  it('renders to a PDF, one line or many', async () => {
    const one = await renderToBuffer(<PurchaseOrderDocument order={ORDER} />);
    expect(one.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const many = { ...ORDER, lines: Array.from({ length: 70 }, (_, index) => ({ ...ORDER.lines[0], id: `ol-${index}` })) };
    const long = await renderToBuffer(<PurchaseOrderDocument order={many} />);
    expect(long.length).toBeGreaterThan(one.length);
    // What rides on the email must stay under the server's limit for an order's PDF, even a long one.
    expect(long.length).toBeLessThan(200_000);
  });

  it('prints the day it was approved, when it is expected, and where it goes', () => {
    expect(orderFacts(ORDER)).toEqual([
      { label: 'Ordered', value: 'Nov 19, 2026' },
      { label: 'Expected by', value: 'Nov 24, 2026' },
      { label: 'Terms', value: 'Net 30' },
      { label: 'Deliver to', value: 'Stockroom' },
      { label: 'Requisition', value: 'PR-0012' },
    ]);
    expect(orderFacts({ ...ORDER, approvedAt: null, expectedOn: null, terms: null, deliverTo: null })).toEqual([
      { label: 'Ordered', value: 'Nov 18, 2026' },
      { label: 'Requisition', value: 'PR-0012' },
    ]);
  });

  it('names the vendor and whoever the office deals with there', () => {
    expect(orderVendorLines(ORDER)).toEqual(['Hill Country Supply', 'A Person', 'orders@hill.example']);
    expect(orderVendorLines({ ...ORDER, vendor: null, vendorContact: null })).toEqual(['No vendor chosen']);
  });

  it('is filed under its number and its vendor', () => {
    expect(orderFileName(ORDER)).toBe('PO-0009 Hill Country Supply.pdf');
    expect(orderFileName({ number: null, vendor: { id: 'v', name: 'A/B: Supply' } })).toBe('Purchase order draft A B Supply.pdf');
  });
});
