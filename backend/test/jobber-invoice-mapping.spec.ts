import {
  invoiceProperty,
  isCutShort,
  jobberDay,
  toInvoiceCopy,
  toPaymentDetails,
} from '../src/integrations/jobber/jobber-invoice-mapping';
import {
  INVOICE_BY_ID_QUERY,
  INVOICE_PAGE_FILES,
  INVOICE_PAGE_LINES,
  INVOICE_PAGE_NOTES,
  INVOICE_PAGE_PAYMENTS,
  invoicesPageQuery,
  PAYMENT_RECORD_QUERY,
  PAYMENTS_PAGE_QUERY,
} from '../src/integrations/jobber/jobber.queries';
import {
  jobberInvoiceSchema,
  jobberPaymentRecordSchema,
  type JobberInvoice,
  type JobberPaymentRecord,
} from '../src/integrations/jobber/jobber.schemas';

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
  properties: {
    nodes: [{ id: 'jobber-property-1', address: { street1: '100 Example Way', street2: 'Unit B', city: 'Sampletown', province: 'TX', postalCode: '77000' } }],
  },
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

const NO_LINE_EXTRAS = { taxable: null, serviceOn: null, productName: null, category: null };

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
      jobberPropertyId: 'jobber-property-1',
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
        { ...NO_LINE_EXTRAS, name: 'Filter Change', description: null, quantity: 1, unitPriceCents: 3999, totalCents: 3999 },
        { ...NO_LINE_EXTRAS, name: 'Pest Control', description: 'Front and back', quantity: 1, unitPriceCents: 2450, totalCents: 2450 },
      ],
      payments: [
        { jobberPaymentId: 'jobber-payment-1', paidOn: '2026-10-05', amountCents: 3949, method: 'OTHER', reference: null, note: null },
      ],
      details: {
        contractDisclaimer: null,
        billingName: null,
        propertyAddress: '100 Example Way, Unit B, Sampletown, TX 77000',
        billingSameAsProperty: null,
        clientEmails: [],
        clientPhones: [],
        paidOn: null,
        viewedAt: null,
        salespersonName: null,
        jobTitle: null,
        discountCents: 0,
        discountRate: null,
        discountKind: null,
        depositCents: 0,
        tipsCents: 0,
        taxRateName: null,
        taxRatePercent: null,
        taxInclusive: null,
        customFields: [],
      },
      // Not asked for: left as the copy holds them.
      notes: undefined,
      files: undefined,
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

  it("names the one Jobber property it is for, as the property matcher takes it, and none for a batch", () => {
    expect(invoiceProperty(invoice())).toEqual({
      jobberPropertyId: 'jobber-property-1',
      jobberClientId: 'jobber-client-1',
      jobberClientName: ' 100 Example Way ',
      addressLine1: '100 Example Way',
      addressLine2: 'Unit B',
      city: 'Sampletown',
      state: 'TX',
      postalCode: '77000',
    });
    const batch = invoice({ properties: { nodes: [{ id: 'p-1' }, { id: 'p-2' }] } });
    expect(invoiceProperty(batch)).toBeNull();
    expect(toInvoiceCopy(batch).jobberPropertyId).toBeNull();
    expect(invoiceProperty(invoice({ properties: { nodes: [] } }))).toBeNull();
  });

  it('knows when a page cut its lines, payments, notes or files short', () => {
    expect(isCutShort(invoice())).toBe(false);
    expect(isCutShort(invoice({ lineItems: { totalCount: 12, nodes: invoice().lineItems.nodes } }))).toBe(true);
    expect(isCutShort(invoice({ paymentRecords: { totalCount: 11, nodes: invoice().paymentRecords.nodes } }))).toBe(true);
    expect(isCutShort(invoice({ notes: { totalCount: 6, nodes: [] } }))).toBe(true);
    expect(isCutShort(invoice({ noteAttachments: { totalCount: 6, nodes: [] } }))).toBe(true);
    expect(isCutShort(invoice({ notes: { totalCount: 0, nodes: [] }, noteAttachments: { totalCount: 0, nodes: [] } }))).toBe(false);
  });
});

describe('every other detail Jobber keeps on an invoice', () => {
  const full = () =>
    invoice({
      contractDisclaimer: ' Thank you for your business. ',
      receivedDate: '2026-10-20T00:00:00Z',
      dateViewedInClientHub: '2026-10-02T15:30:00Z',
      billingIsSameAsPropertyAddress: false,
      taxCalculationMethod: 'exclusive',
      amounts: { subtotal: 64.49, discountAmount: 6.45, taxAmount: 0, depositAmount: 10, tipsTotal: 2, total: 58.04, invoiceBalance: 0 },
      discount: { rate: 10, type: 'Percent' },
      taxRate: { name: 'Texas', tax: 8.25 },
      salesperson: { name: { full: 'Example Salesperson' } },
      customFields: [
        { __typename: 'CustomFieldText', label: 'Gate code', valueText: '1234' },
        { __typename: 'CustomFieldNumeric', label: 'Units', valueNumeric: 2, unit: 'doors' },
        { __typename: 'CustomFieldDropdown', label: 'Pets', valueDropdown: 'Dog' },
        { __typename: 'CustomFieldTrueFalse', label: 'Lockbox', valueTrueFalse: false },
        { __typename: 'CustomFieldArea', label: 'Lot' },
        { __typename: 'CustomFieldText', label: 'Empty', valueText: ' ' },
      ],
      billingAddress: { name: 'Example Owner', street1: '9 Billing Rd', city: 'Sampletown', province: 'TX', postalCode: '77001' },
      client: {
        id: 'jobber-client-1',
        name: '100 Example Way',
        emails: [
          { address: 'second@example.com', primary: false },
          { address: ' owner@example.com ', primary: true },
          { address: 'second@example.com', primary: false },
        ],
        phones: [{ number: '555-0100', primary: null }],
      },
      jobs: { nodes: [{ id: 'jobber-job-1', jobNumber: 20625, title: ' Quarterly service ' }] },
      lineItems: {
        totalCount: 1,
        nodes: [
          {
            name: 'Filter Change',
            description: null,
            quantity: 1,
            unitPrice: 39.99,
            totalPrice: 39.99,
            taxable: false,
            date: '2026-10-01T00:00:00Z',
            category: 'SERVICE',
            linkedProductOrService: { name: 'Filter Change' },
          },
        ],
      },
      notes: {
        totalCount: 3,
        nodes: [
          { __typename: 'InvoiceNote', id: 'note-1', message: ' Paid by the owner ', pinned: true, createdAt: '2026-10-03T12:00:00Z' },
          { __typename: 'JobNote', id: 'note-2', message: 'Gate sticks', pinned: null, createdAt: '2026-09-30T12:00:00Z' },
          // A kind this query asks nothing of comes back as its type alone.
          { __typename: 'ClientNote' },
        ],
      },
      noteAttachments: {
        totalCount: 1,
        nodes: [
          { id: 'file-1', fileName: 'receipt.pdf', contentType: 'application/pdf', fileSize: 2048, url: 'https://files.example.com/receipt.pdf', createdAt: '2026-10-03T12:00:00Z' },
        ],
      },
    });

  it('keeps the disclaimer, contacts, days, discount, deposit, tips, tax and custom fields', () => {
    expect(jobberInvoiceSchema.safeParse(full()).success).toBe(true);
    expect(toInvoiceCopy(full()).details).toEqual({
      contractDisclaimer: 'Thank you for your business.',
      billingName: 'Example Owner',
      propertyAddress: '100 Example Way, Unit B, Sampletown, TX 77000',
      billingSameAsProperty: false,
      // Primary first, each once.
      clientEmails: ['owner@example.com', 'second@example.com'],
      clientPhones: ['555-0100'],
      paidOn: '2026-10-20',
      viewedAt: '2026-10-02T15:30:00Z',
      salespersonName: 'Example Salesperson',
      jobTitle: 'Quarterly service',
      discountCents: 645,
      discountRate: 10,
      discountKind: 'PERCENT',
      depositCents: 1000,
      tipsCents: 200,
      taxRateName: 'Texas',
      taxRatePercent: 8.25,
      taxInclusive: false,
      // Area fields carry no plain value, and an empty one is left out.
      customFields: [
        { label: 'Gate code', value: '1234' },
        { label: 'Units', value: '2 doors' },
        { label: 'Pets', value: 'Dog' },
        { label: 'Lockbox', value: 'No' },
      ],
    });
  });

  it("takes an amount discount as one, and Jobber's inclusive tax as prices that include it", () => {
    const details = toInvoiceCopy(invoice({ discount: { rate: 5, type: 'Unit' }, taxCalculationMethod: 'INCLUSIVE' })).details!;
    expect(details).toMatchObject({ discountKind: 'AMOUNT', discountRate: 5, taxInclusive: true });
  });

  it("keeps each line's tax, service day, product and kind", () => {
    expect(toInvoiceCopy(full()).lines[0]).toMatchObject({
      taxable: false,
      serviceOn: '2026-10-01',
      productName: 'Filter Change',
      category: 'SERVICE',
    });
  });

  it("keeps the invoice's notes and the job's, and its files", () => {
    const copy = toInvoiceCopy(full());
    expect(copy.notes).toEqual([
      { jobberNoteId: 'note-1', kind: 'INVOICE', message: 'Paid by the owner', pinned: true, writtenAt: '2026-10-03T12:00:00Z' },
      { jobberNoteId: 'note-2', kind: 'JOB', message: 'Gate sticks', pinned: false, writtenAt: '2026-09-30T12:00:00Z' },
    ]);
    expect(copy.files).toEqual([
      {
        jobberFileId: 'file-1',
        fileName: 'receipt.pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
        jobberUrl: 'https://files.example.com/receipt.pdf',
        uploadedAt: '2026-10-03T12:00:00Z',
      },
    ]);
  });
});

describe("a payment in Jobber's payment list", () => {
  const record = (over: Partial<JobberPaymentRecord> = {}): JobberPaymentRecord => ({
    id: 'record-1',
    amount: 39.99,
    entryDate: '2026-10-20T00:00:00Z',
    paymentType: 'ACH_BANK_PAYMENT',
    details: ' From the owner ledger ',
    invoice: { id: 'jobber-invoice-1' },
    confirmationNumber: 'ACH-77',
    ...over,
  });

  it('says how it was paid, its reference and its details, for the invoice and day it names', () => {
    expect(jobberPaymentRecordSchema.safeParse(record()).success).toBe(true);
    expect(toPaymentDetails(record())).toEqual({
      jobberRecordId: 'record-1',
      jobberInvoiceId: 'jobber-invoice-1',
      paidOn: '2026-10-20',
      amountCents: 3999,
      method: 'BANK_TRANSFER',
      jobberPaymentType: 'ACH_BANK_PAYMENT',
      reference: 'ACH-77',
      note: 'From the owner ledger',
    });
  });

  it("files each of Jobber's payment types, and any other as Other with Jobber's spelling kept", () => {
    const method = (paymentType: string) => toPaymentDetails(record({ paymentType }))!.method;
    expect(method('CASH')).toBe('CASH');
    expect(method('CHEQUE')).toBe('CHECK');
    expect(method('CREDIT_CARD')).toBe('CARD');
    expect(method('JOBBER_PAYMENTS')).toBe('CARD');
    expect(method('E_TRANSFER')).toBe('BANK_TRANSFER');
    expect(method('ZELLE')).toBe('ZELLE');
    expect(method('VENMO')).toBe('VENMO');
    expect(method('MONEY_ORDER')).toBe('MONEY_ORDER');
    expect(method('OTHER')).toBe('OTHER');
    expect(toPaymentDetails(record({ paymentType: 'CONSUMER_FINANCING' }))).toMatchObject({
      method: 'OTHER',
      jobberPaymentType: 'CONSUMER_FINANCING',
    });
    expect(toPaymentDetails(record({ paymentType: null }))!.method).toBe('OTHER');
  });

  it("takes a check's number, or a card's transaction, as the reference", () => {
    expect(toPaymentDetails(record({ paymentType: 'CHEQUE', confirmationNumber: null, checkNumber: '1042' }))!.reference).toBe('1042');
    expect(toPaymentDetails(record({ confirmationNumber: null, ccTransactionNumber: 'txn-9' }))!.reference).toBe('txn-9');
    expect(toPaymentDetails(record({ confirmationNumber: null, details: null }))).toMatchObject({ reference: null, note: null });
  });

  it('is nothing to pair when it names no invoice', () => {
    expect(toPaymentDetails(record({ invoice: null }))).toBeNull();
  });
});

describe('the invoice queries', () => {
  /**
   * Every name the queries may use, as Jobber's schema returned them. A query
   * naming anything else fails whole, so a typo here would stop every read.
   */
  const SCHEMA_NAMES = new Set([
    // operations, arguments and variables
    'query', 'ConsoleInvoices', 'ConsoleInvoice', 'ConsolePayments', 'ConsolePayment', 'invoices', 'invoice', 'paymentRecord',
    'first', 'after', 'sort', 'key', 'direction', 'filter', 'updatedAt', 'id', 'updatedAfter',
    'Int', 'String', 'ISO8601DateTime', 'EncodedId', 'CREATED_AT', 'UPDATED_AT', 'ASCENDING', 'on', '__typename',
    // Invoice
    'invoiceNumber', 'subject', 'invoiceStatus', 'issuedDate', 'dueDate', 'message', 'jobberWebUri',
    'receivedDate', 'dateViewedInClientHub', 'contractDisclaimer', 'billingIsSameAsPropertyAddress', 'taxCalculationMethod',
    'amounts', 'subtotal', 'taxAmount', 'total', 'invoiceBalance', 'discountAmount', 'depositAmount', 'tipsTotal',
    // Invoice.discount: CostModifier; Invoice.taxRate: TaxRateBase; Invoice.salesperson: User
    'discount', 'rate', 'type', 'taxRate', 'tax', 'salesperson', 'full',
    // Invoice.customFields: CustomFieldUnion
    'customFields', 'label', 'CustomFieldText', 'valueText', 'CustomFieldNumeric', 'valueNumeric', 'unit',
    'CustomFieldDropdown', 'valueDropdown', 'CustomFieldTrueFalse', 'valueTrueFalse', 'CustomFieldArea', 'CustomFieldLink',
    'billingAddress', 'street1', 'street2', 'city', 'province', 'postalCode',
    'client', 'name', 'emails', 'phones', 'primary', 'number',
    'jobs', 'jobNumber', 'title', 'visits', 'nodes', 'totalCount', 'pageInfo', 'hasNextPage', 'endCursor',
    // Invoice.properties: PropertyConnection; Property.address as the visit sync reads it
    'properties', 'address',
    'lineItems', 'description', 'quantity', 'unitPrice', 'totalPrice', 'taxable', 'date', 'category', 'linkedProductOrService',
    'paymentRecords', 'amount', 'entryDate', 'adjustmentType',
    // Invoice.notes: InvoiceNotesUnion; Invoice.noteAttachments: InvoiceNoteFile
    'notes', 'InvoiceNote', 'JobNote', 'pinned', 'createdAt',
    'noteAttachments', 'fileName', 'contentType', 'fileSize', 'url',
    // Query.paymentRecords: PaymentRecordInterface and its kinds
    'PAYMENT', 'paymentType', 'details', 'CheckPaymentRecord', 'checkNumber', 'OtherPaymentRecord', 'confirmationNumber',
    'BankTransferPaymentRecord', 'AchBankPaymentPaymentRecord', 'CreditCardPaymentRecord', 'ccTransactionNumber',
  ]);
  const names = (document: string) => [...new Set(document.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])];
  const ALL = [invoicesPageQuery('all'), invoicesPageQuery('changed'), INVOICE_BY_ID_QUERY, PAYMENTS_PAGE_QUERY, PAYMENT_RECORD_QUERY];

  it.each([
    ['the first read', invoicesPageQuery('all')],
    ['what changed', invoicesPageQuery('changed')],
    ['one invoice', INVOICE_BY_ID_QUERY],
    ['the payment list', PAYMENTS_PAGE_QUERY],
    ['one payment', PAYMENT_RECORD_QUERY],
  ])('%s names only what Jobber has', (_label, document) => {
    expect(names(document).filter((name) => !SCHEMA_NAMES.has(name))).toEqual([]);
  });

  it('reads the payment list payments only, in the order they were recorded', () => {
    expect(PAYMENTS_PAGE_QUERY).toMatch(/filter: \{ adjustmentType: PAYMENT \}/);
    expect(PAYMENTS_PAGE_QUERY).toMatch(/key: CREATED_AT, direction: ASCENDING/);
  });

  it('reads the first time by creation, and after that only what changed, oldest first', () => {
    expect(invoicesPageQuery('all')).toMatch(/key: CREATED_AT, direction: ASCENDING/);
    expect(invoicesPageQuery('all')).not.toMatch(/updatedAfter/);
    expect(invoicesPageQuery('changed')).toMatch(/key: UPDATED_AT, direction: ASCENDING/);
    expect(invoicesPageQuery('changed')).toMatch(/filter: \{ updatedAt: \{ after: \$updatedAfter \} \}/);
  });

  it('asks a page for a few lines, payments, notes and files, and one invoice for all of them', () => {
    expect(invoicesPageQuery('all')).toContain(`lineItems(first: ${INVOICE_PAGE_LINES})`);
    expect(invoicesPageQuery('all')).toContain(`paymentRecords(first: ${INVOICE_PAGE_PAYMENTS})`);
    expect(invoicesPageQuery('all')).toContain(`notes(first: ${INVOICE_PAGE_NOTES})`);
    expect(invoicesPageQuery('all')).toContain(`noteAttachments(first: ${INVOICE_PAGE_FILES})`);
    expect(INVOICE_BY_ID_QUERY).toContain('lineItems(first: 100)');
    expect(INVOICE_BY_ID_QUERY).toContain('paymentRecords(first: 100)');
    expect(INVOICE_BY_ID_QUERY).toContain('notes(first: 50)');
    expect(INVOICE_BY_ID_QUERY).toContain('noteAttachments(first: 50)');
  });

  it('asks Jobber for nothing that changes anything', () => {
    for (const document of ALL) expect(document).not.toMatch(/\bmutation\b/);
  });
});
