import { isCutShort, jobberDay, toInvoiceCopy } from '../src/integrations/jobber/jobber-invoice-mapping';
import {
  INVOICE_BY_ID_QUERY,
  INVOICE_PAGE_LINES,
  INVOICE_PAGE_PAYMENTS,
  invoicesPageQuery,
  PAYMENT_RECORD_INVOICE_QUERY,
} from '../src/integrations/jobber/jobber.queries';
import { jobberInvoiceSchema, type JobberInvoice } from '../src/integrations/jobber/jobber.schemas';

/**
 * Jobber's invoice turned into the console's copy (2026-11-05). Field names are
 * the ones Jobber's schema returned by introspection on the pinned version;
 * ids, names and addresses here are invented.
 */

const invoice = (over: Partial<JobberInvoice> = {}): JobberInvoice => ({
  id: 'jobber-invoice-1',
  invoiceNumber: '8439',
  subject: 'For Services Rendered',
  invoiceStatus: 'awaiting_payment',
  issuedDate: '2026-10-01T00:00:00Z',
  dueDate: '2026-10-31T00:00:00Z',
  message: 'Thank you for your business.',
  jobberWebUri: 'https://secure.getjobber.com/invoices/8439',
  updatedAt: '2026-11-04T16:20:00Z',
  amounts: { subtotal: 64.49, taxAmount: 0, total: 64.49, invoiceBalance: 25 },
  billingAddress: { street1: '100 Example Way', street2: '', city: 'Sampletown', province: 'TX', postalCode: '77000' },
  client: { id: 'jobber-client-1', name: ' 100 Example Way ' },
  jobs: { nodes: [{ id: 'jobber-job-1', jobNumber: 20625 }] },
  visits: { nodes: [{ id: 'jobber-visit-1' }] },
  lineItems: {
    totalCount: 2,
    nodes: [
      { name: 'Filter Change', description: '', quantity: 1, unitPrice: 39.99, totalPrice: 39.99 },
      { name: 'Pest Control', description: 'Front and back', quantity: 1, unitPrice: 24.5, totalPrice: 24.5 },
    ],
  },
  paymentRecords: {
    totalCount: 1,
    nodes: [{ id: 'jobber-payment-1', amount: 39.49, entryDate: '2026-10-05T00:00:00Z', adjustmentType: 'PAYMENT' }],
  },
  ...over,
});

describe("Jobber's invoice as the console's copy", () => {
  it('keeps the invoice, its client, job, visits, terms and money, in cents', () => {
    expect(toInvoiceCopy(invoice())).toEqual({
      jobberInvoiceId: 'jobber-invoice-1',
      jobberClientId: 'jobber-client-1',
      number: '8439',
      subject: 'For Services Rendered',
      status: 'AWAITING_PAYMENT',
      clientName: '100 Example Way',
      billingAddress: '100 Example Way, Sampletown, TX 77000',
      jobberJobId: 'jobber-job-1',
      jobNumber: '20625',
      jobberVisitIds: ['jobber-visit-1'],
      issuedOn: '2026-10-01',
      dueOn: '2026-10-31',
      paymentTermsDays: 30,
      subtotalCents: 6449,
      taxCents: 0,
      totalCents: 6449,
      balanceCents: 2500,
      clientMessage: 'Thank you for your business.',
      jobberWebUrl: 'https://secure.getjobber.com/invoices/8439',
      updatedAt: '2026-11-04T16:20:00Z',
      lines: [
        { name: 'Filter Change', description: null, quantity: 1, unitPriceCents: 3999, totalCents: 3999 },
        { name: 'Pest Control', description: 'Front and back', quantity: 1, unitPriceCents: 2450, totalCents: 2450 },
      ],
      payments: [
        { jobberPaymentId: 'jobber-payment-1', paidOn: '2026-10-05', amountCents: 3949, method: 'OTHER', reference: null, note: null },
      ],
    });
  });

  it("files Jobber's statuses as the console's, past due worked out again from the due day", () => {
    const status = (invoiceStatus: JobberInvoice['invoiceStatus']) => toInvoiceCopy(invoice({ invoiceStatus })).status;
    expect(status('draft')).toBe('DRAFT');
    expect(status('awaiting_payment')).toBe('AWAITING_PAYMENT');
    expect(status('sent_not_due')).toBe('AWAITING_PAYMENT');
    expect(status('past_due')).toBe('PAST_DUE');
    expect(status('paid')).toBe('PAID');
    expect(status('bad_debt')).toBe('BAD_DEBT');
  });

  it('refuses a status outside the pinned enum rather than guessing at it', () => {
    expect(jobberInvoiceSchema.safeParse({ ...invoice(), invoiceStatus: 'voided' }).success).toBe(false);
    expect(jobberInvoiceSchema.safeParse(invoice()).success).toBe(true);
  });

  it('takes a day written as midnight as written, and an instant as the day in Texas', () => {
    expect(jobberDay('2026-10-01T00:00:00Z')).toBe('2026-10-01');
    expect(jobberDay('2026-10-01T00:00:00.000-05:00')).toBe('2026-10-01');
    // 03:00 UTC is still the evening before in Houston.
    expect(jobberDay('2026-10-01T03:00:00Z')).toBe('2026-09-30');
    expect(jobberDay('2026-10-01T15:00:00Z')).toBe('2026-10-01');
    expect(jobberDay(null)).toBeNull();
    expect(jobberDay('not a day')).toBeNull();
  });

  it('works the terms out from issue to due, and gives none without both or when due comes first', () => {
    expect(toInvoiceCopy(invoice({ dueDate: '2026-10-01T00:00:00Z' })).paymentTermsDays).toBe(0);
    expect(toInvoiceCopy(invoice({ dueDate: null })).paymentTermsDays).toBeNull();
    expect(toInvoiceCopy(invoice({ dueDate: '2026-09-20T00:00:00Z' })).paymentTermsDays).toBeNull();
  });

  it('names a job only when the invoice bills exactly one', () => {
    const batch = toInvoiceCopy(invoice({ jobs: { nodes: [{ id: 'job-a', jobNumber: 1 }, { id: 'job-b', jobNumber: 2 }] } }));
    expect(batch).toMatchObject({ jobberJobId: null, jobNumber: null });
    expect(toInvoiceCopy(invoice({ jobs: { nodes: [] } })).jobberJobId).toBeNull();
  });

  it('counts payments and deposits in, refunds and failed bank payments out, and leaves ledger entries alone', () => {
    const records = (adjustmentType: string, amount: number) => ({
      id: `p-${adjustmentType}`,
      amount,
      entryDate: '2026-10-05T00:00:00Z',
      adjustmentType,
    });
    const copy = toInvoiceCopy(
      invoice({
        paymentRecords: {
          totalCount: 6,
          nodes: [
            records('PAYMENT', 20),
            records('DEPOSIT', 5),
            records('REFUND', 10),
            records('FAILED_ACH_PAYMENT', -3),
            records('INVOICE', 64.49),
            records('CORRECTION', 1),
          ],
        },
      }),
    );
    expect(copy.payments.map((paid) => [paid.jobberPaymentId, paid.amountCents])).toEqual([
      ['p-PAYMENT', 2000],
      ['p-DEPOSIT', 500],
      ['p-REFUND', -1000],
      ['p-FAILED_ACH_PAYMENT', -300],
    ]);
  });

  it('turns empty text into nothing, and a numbered invoice into its number as text', () => {
    const copy = toInvoiceCopy(
      invoice({ invoiceNumber: 8439, message: '  ', billingAddress: { street1: '', city: null }, client: null, amounts: null }),
    );
    expect(copy).toMatchObject({
      number: '8439',
      clientMessage: null,
      billingAddress: null,
      clientName: '',
      jobberClientId: null,
      totalCents: 0,
      balanceCents: 0,
    });
  });

  it('knows when a page cut its lines or payments short', () => {
    expect(isCutShort(invoice())).toBe(false);
    expect(isCutShort(invoice({ lineItems: { totalCount: 12, nodes: invoice().lineItems.nodes } }))).toBe(true);
    expect(isCutShort(invoice({ paymentRecords: { totalCount: 11, nodes: invoice().paymentRecords.nodes } }))).toBe(true);
  });
});

describe('the invoice queries', () => {
  /**
   * Every name the queries may use, as Jobber's schema returned them. A query
   * naming anything else fails whole, so a typo here would stop every read.
   */
  const SCHEMA_NAMES = new Set([
    // operations, arguments and variables
    'query', 'ConsoleInvoices', 'ConsoleInvoice', 'ConsoleInvoicePayment', 'invoices', 'invoice', 'paymentRecord',
    'first', 'after', 'sort', 'key', 'direction', 'filter', 'updatedAt', 'id', 'updatedAfter',
    'Int', 'String', 'ISO8601DateTime', 'EncodedId', 'CREATED_AT', 'UPDATED_AT', 'ASCENDING',
    // Invoice
    'invoiceNumber', 'subject', 'invoiceStatus', 'issuedDate', 'dueDate', 'message', 'jobberWebUri',
    'amounts', 'subtotal', 'taxAmount', 'total', 'invoiceBalance',
    'billingAddress', 'street1', 'street2', 'city', 'province', 'postalCode',
    'client', 'name', 'jobs', 'jobNumber', 'visits', 'nodes', 'totalCount', 'pageInfo', 'hasNextPage', 'endCursor',
    'lineItems', 'description', 'quantity', 'unitPrice', 'totalPrice',
    'paymentRecords', 'amount', 'entryDate', 'adjustmentType',
  ]);
  const names = (document: string) => [...new Set(document.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])];

  it.each([
    ['the first read', invoicesPageQuery('all')],
    ['what changed', invoicesPageQuery('changed')],
    ['one invoice', INVOICE_BY_ID_QUERY],
    ["a payment's invoice", PAYMENT_RECORD_INVOICE_QUERY],
  ])('%s names only what Jobber has', (_label, document) => {
    expect(names(document).filter((name) => !SCHEMA_NAMES.has(name))).toEqual([]);
  });

  it('reads the first time by creation, and after that only what changed, oldest first', () => {
    expect(invoicesPageQuery('all')).toMatch(/key: CREATED_AT, direction: ASCENDING/);
    expect(invoicesPageQuery('all')).not.toMatch(/updatedAfter/);
    expect(invoicesPageQuery('changed')).toMatch(/key: UPDATED_AT, direction: ASCENDING/);
    expect(invoicesPageQuery('changed')).toMatch(/filter: \{ updatedAt: \{ after: \$updatedAfter \} \}/);
  });

  it('asks a page for a few lines and payments, and one invoice for all of them', () => {
    expect(invoicesPageQuery('all')).toContain(`lineItems(first: ${INVOICE_PAGE_LINES})`);
    expect(invoicesPageQuery('all')).toContain(`paymentRecords(first: ${INVOICE_PAGE_PAYMENTS})`);
    expect(INVOICE_BY_ID_QUERY).toContain('lineItems(first: 100)');
    expect(INVOICE_BY_ID_QUERY).toContain('paymentRecords(first: 100)');
  });

  it('asks Jobber for nothing that changes anything', () => {
    for (const document of [invoicesPageQuery('all'), invoicesPageQuery('changed'), INVOICE_BY_ID_QUERY, PAYMENT_RECORD_INVOICE_QUERY])
      expect(document).not.toMatch(/\bmutation\b/);
  });
});
