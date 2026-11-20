/**
 * @vitest-environment node
 *
 * Rendered as the order PDF is tested, on @react-pdf's Node build: the console
 * makes it in the browser, but it has no images -- the one thing the two
 * builds handle differently.
 */
import { renderToBuffer } from '@react-pdf/renderer';
import type { RequisitionDetail } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import { requisitionFileName } from './download-requisition';
import { navAmount, navDay, navMoment, navMomentDay } from '../nav-pdf/nav-pdf';
import { RequisitionDocument, orderedAs, requisitionFacts, requisitionLineCells } from './requisition-document';

/** Every name, code and price invented. */
const CODES = { lineType: { code: 'ITEM', name: 'Item', keepsStock: true }, place: null, expectedOn: null, vendor: null, department: { id: 'd', code: 'MAINT', name: 'Maintenance' }, notes: null };
const REQUISITION = {
  id: 'req-42',
  number: 'PR-00042',
  status: 'ORDERED',
  requestedBy: { id: 'user-asker', name: 'Sample Requester', code: 'SREQUESTER' },
  submittedAt: '2026-11-19T16:42:00.000Z',
  createdAt: '2026-11-19T16:30:00.000Z',
  company: { tenantId: 'tenant-thmp', name: 'Example Company', purchaserCode: 'THMP' },
  neededBy: '2026-11-24',
  summary: 'Filter 16x25x1 × 48, Duct cleaning × 1',
  lineCount: 2,
  quoteCount: 0,
  estimatedTotalCents: 34416,
  decisionNote: null,
  reason: '',
  deliverTo: { id: 'place-store', name: 'Office Storeroom', code: 'STORE' },
  requestCode: { id: 'rc', code: 'RESTOCK', name: 'Restock the storeroom' },
  costCenter: { id: 'cc', code: 'MAINTENANCE', name: 'Maintenance' },
  requisitionDate: '2026-11-19',
  documentDate: '2026-11-19',
  lines: [
    { id: 'l-1', item: { id: 'i-1', code: 'FLT-16251', name: 'Filter 16x25x1', unit: 'pcs' }, description: 'Filter 16x25x1', quantity: 48, estimatedUnitCostCents: 342, onHand: 0, reorderLevel: 12, ...CODES, vendor: { id: 'v-hill', number: 'V00003', name: 'Hill Country Supply' } },
    {
      id: 'l-2',
      item: { id: 'i-2', code: 'SVC-0002', name: 'Duct cleaning, one unit', unit: 'job' },
      description: null,
      quantity: 1,
      estimatedUnitCostCents: 18000,
      onHand: null,
      reorderLevel: null,
      ...CODES,
      lineType: { code: 'SERVICE', name: 'Service', keepsStock: false },
      place: { id: 'p-yard', code: 'YARD', name: 'Back yard' },
      expectedOn: '2026-12-02',
      notes: 'Unit at the back of the yard',
    },
  ],
  quotes: [],
  decidedBy: 'Sample Owner',
  decidedAt: '2026-11-19T21:38:00.000Z',
  history: [],
  orders: [
    { id: 'o-31', number: 'PO-0031', status: 'SENT', vendor: { id: 'v-hill', number: 'V00003', name: 'Hill Country Supply' } },
    { id: 'o-32', number: null, status: 'DRAFT', vendor: null },
  ],
  from: { name: 'Example Company', addressLine1: '1 Example Plaza', addressLine2: 'Austin, TX 78701', phone: '555-0100', email: null },
  files: [],
  notes: [],
  comments: [],
  links: [],
  can: { edit: false, submit: false, cancel: false, approve: false, sendBack: false, reject: false, order: false, approveBlocked: null, attach: true, recall: false, reopen: false },
  settings: { approvalLimitCents: 50000, quotesAboveLimit: 2 },
} satisfies RequisitionDetail;

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

describe('a purchase requisition as a PDF (2026-11-20)', () => {
  it('renders to a PDF, a few lines or many, and stays small', async () => {
    const one = await renderToBuffer(<RequisitionDocument printedAt={new Date('2026-11-19T22:02:00.000Z')} printedBy="Sample Purchaser" requisition={REQUISITION} />);
    expect(one.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const many = { ...REQUISITION, lines: Array.from({ length: 80 }, (_, index) => ({ ...REQUISITION.lines[index % 2]!, id: `l-${index}` })) };
    const long = await renderToBuffer(<RequisitionDocument requisition={many} />);
    expect(long.length).toBeGreaterThan(one.length);
    expect(long.length).toBeLessThan(200_000);

    // Every page is signed off with who printed it and which page it is. A line height set on the
    // page once made @react-pdf drop this footer without a word.
    const pages = await pageTexts(long);
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((text, index) => expect(text).toContain(`PR-00042 · Page ${index + 1} of ${pages.length}`));
    expect((await pageTexts(one))[0]).toContain('Printed 11/19/2026, 4:02 PM Texas time · Sample Purchaser');

    // A draft: no number, nobody has approved it, nothing ordered.
    const draft = await renderToBuffer(<RequisitionDocument requisition={{ ...REQUISITION, number: null, status: 'DRAFT', submittedAt: null, decidedBy: null, decidedAt: null, orders: [] }} />);
    expect(draft.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('heads it with the board\'s facts, read across three columns', () => {
    expect(requisitionFacts(REQUISITION)).toEqual([
      { label: 'Requisitioner ID', value: 'SREQUESTER' },
      { label: 'Request Code', value: 'RESTOCK · Restock the storeroom' },
      { label: 'Requisition Date', value: '11/19/2026' },
      { label: 'Requisitioner Name', value: 'Sample Requester' },
      { label: 'Location Code', value: 'STORE · Office Storeroom' },
      { label: 'Document Date', value: '11/19/2026' },
      { label: 'Purchaser Code', value: 'THMP · Example Company' },
      { label: 'Cost Center Code', value: 'MAINTENANCE' },
      { label: 'Expected Receipt', value: '11/24/2026' },
    ]);
    expect(requisitionFacts({ ...REQUISITION, requestCode: null, costCenter: null, deliverTo: null, company: null, neededBy: null, documentDate: null }).filter((fact) => fact.value).map((fact) => fact.label)).toEqual([
      'Requisitioner ID',
      'Requisition Date',
      'Requisitioner Name',
    ]);
  });

  it('prints each line with its codes, taking the requisition\'s place and day when the line names none', () => {
    expect(requisitionLineCells(REQUISITION.lines[0]!, REQUISITION)).toEqual(['Item', 'FLT-16251', 'Filter 16x25x1', 'STORE', '48', 'PCS', '3.42', '164.16', '11/24/2026', 'V00003', 'MAINT']);
    expect(requisitionLineCells(REQUISITION.lines[1]!, REQUISITION)).toEqual(['Service', 'SVC-0002', 'Duct cleaning, one unit', 'YARD', '1', 'JOB', '180.00', '180.00', '12/02/2026', '', 'MAINT']);
  });

  it('says what it was ordered as, one line an order', () => {
    expect(orderedAs(REQUISITION)).toEqual(['PO-0031 · V00003 Hill Country Supply', 'Draft order · vendor to choose']);
    expect(orderedAs({ orders: [] })).toEqual([]);
  });

  it('writes days as NAV does and moments in Texas time', () => {
    expect(navDay('2026-11-24')).toBe('11/24/2026');
    expect(navDay(null)).toBe('');
    // 4:42 PM UTC is 10:42 AM in Texas in November.
    expect(navMoment('2026-11-19T16:42:00.000Z')).toBe('11/19/2026, 10:42 AM');
    // An evening in Texas is the next day in UTC: the day printed is Texas's.
    expect(navMomentDay('2026-11-20T03:30:00.000Z')).toBe('11/19/2026');
    expect(navAmount(123450)).toBe('1,234.50');
  });

  it('is filed under its number', () => {
    expect(requisitionFileName(REQUISITION)).toBe('PR-00042.pdf');
    expect(requisitionFileName({ number: null })).toBe('Purchase requisition draft.pdf');
  });
});
