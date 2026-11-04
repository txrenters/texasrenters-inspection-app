import {
  applyJobberInvoice,
  jobberPageUrl,
  removeJobberInvoice,
  type JobberInvoiceCopy,
} from '../src/integrations/jobber/jobber-invoice-copy';

/**
 * The console's copy of Jobber's invoices (2026-11-05): replaced whole from
 * what Jobber says now, never with an older delivery, and matched to the visit
 * it bills only when that is certain. Ids and addresses invented.
 */

const ORG = '30000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-05T15:00:00.000Z');

const copy = (over: Partial<JobberInvoiceCopy> = {}): JobberInvoiceCopy => ({
  jobberInvoiceId: 'jobber-invoice-1',
  jobberClientId: 'jobber-client-1',
  number: '8439',
  subject: 'For Services Rendered',
  status: 'AWAITING_PAYMENT',
  clientName: '100 Example Way',
  billingAddress: '100 Example Way, Sampletown',
  jobberJobId: 'jobber-job-1',
  jobNumber: '20625',
  jobberVisitIds: ['jobber-visit-1'],
  issuedOn: '2026-10-01',
  dueOn: '2026-10-31',
  paymentTermsDays: 30,
  subtotalCents: 6499,
  taxCents: 0,
  totalCents: 6499,
  balanceCents: 2500,
  clientMessage: 'Thank you.',
  jobberWebUrl: 'https://secure.getjobber.com/invoices/8439',
  updatedAt: '2026-11-04T10:00:00.000Z',
  lines: [
    { name: 'Filter Change', description: null, quantity: 1, unitPriceCents: 3999, totalCents: 3999 },
    { name: 'Pest Control', description: null, quantity: 1, unitPriceCents: 2500, totalCents: 2500 },
  ],
  payments: [
    { jobberPaymentId: 'jobber-payment-1', paidOn: '2026-10-20', amountCents: 3999, method: 'CHECK', reference: '1042', note: null },
  ],
  ...over,
});

function transaction() {
  return {
    invoice: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'invoice-1' }),
      update: jest.fn().mockResolvedValue({ id: 'invoice-1' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoiceLine: { deleteMany: jest.fn(), createMany: jest.fn() },
    invoicePayment: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amountCents: null } }),
      deleteMany: jest.fn(),
      upsert: jest.fn(),
    },
    inspection: {
      findFirst: jest.fn().mockResolvedValue({ id: 'inspection-1', propertywareBuildingId: 'building-1' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

describe("writing Jobber's invoice into the copy", () => {
  it('makes a new copy with its lines and payments, matched to the visit it names', async () => {
    const tx = transaction();

    await expect(applyJobberInvoice(tx as never, ORG, copy(), NOW)).resolves.toBe('created');

    expect(tx.invoice.create.mock.calls[0][0].data).toMatchObject({
      organizationId: ORG,
      origin: 'JOBBER',
      jobberInvoiceId: 'jobber-invoice-1',
      status: 'AWAITING_PAYMENT',
      inspectionId: 'inspection-1',
      propertywareBuildingId: 'building-1',
      issuedOn: new Date('2026-10-01T00:00:00.000Z'),
      balanceCents: 2500,
      jobberUpdatedAt: new Date('2026-11-04T10:00:00.000Z'),
      syncedAt: NOW,
    });
    expect(tx.inspection.findFirst.mock.calls[0][0].where).toEqual({
      organizationId: ORG,
      jobberVisitId: { in: ['jobber-visit-1'] },
    });
    expect(tx.invoiceLine.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ organizationId: ORG, invoiceId: 'invoice-1', position: 0, name: 'Filter Change' }),
      expect.objectContaining({ position: 1, name: 'Pest Control' }),
    ]);
    expect(tx.invoicePayment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId_jobberPaymentId: { organizationId: ORG, jobberPaymentId: 'jobber-payment-1' } },
        create: expect.objectContaining({ origin: 'JOBBER', amountCents: 3999, method: 'CHECK' }),
      }),
    );
  });

  it('replaces the lines whole, and drops a payment Jobber no longer has', async () => {
    const tx = transaction();
    tx.invoice.findUnique.mockResolvedValue({ id: 'invoice-1', jobberUpdatedAt: new Date('2026-11-01T00:00:00.000Z') });

    await expect(applyJobberInvoice(tx as never, ORG, copy(), NOW)).resolves.toBe('updated');

    expect(tx.invoice.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'invoice-1' } }));
    expect(tx.invoiceLine.deleteMany).toHaveBeenCalledWith({ where: { invoiceId: 'invoice-1' } });
    // Only Jobber's own payments: one made in the console waits to be sent.
    expect(tx.invoicePayment.deleteMany).toHaveBeenCalledWith({
      where: { invoiceId: 'invoice-1', origin: 'JOBBER', jobberPaymentId: { notIn: ['jobber-payment-1'] } },
    });
  });

  it('ignores a delivery older than the copy it holds', async () => {
    const tx = transaction();
    tx.invoice.findUnique.mockResolvedValue({ id: 'invoice-1', jobberUpdatedAt: new Date('2026-11-04T11:00:00.000Z') });

    await expect(applyJobberInvoice(tx as never, ORG, copy(), NOW)).resolves.toBe('stale');

    expect(tx.invoice.update).not.toHaveBeenCalled();
    expect(tx.invoiceLine.deleteMany).not.toHaveBeenCalled();
    expect(tx.invoicePayment.upsert).not.toHaveBeenCalled();
  });

  it('takes the same delivery again, as Jobber sends it twice, as the same copy rather than a second', async () => {
    const tx = transaction();
    tx.invoice.findUnique.mockResolvedValue({ id: 'invoice-1', jobberUpdatedAt: new Date('2026-11-04T10:00:00.000Z') });

    await expect(applyJobberInvoice(tx as never, ORG, copy(), NOW)).resolves.toBe('updated');
    expect(tx.invoice.create).not.toHaveBeenCalled();
  });

  it("keeps past due as awaiting payment: the console works it out from the due day", async () => {
    const tx = transaction();
    await applyJobberInvoice(tx as never, ORG, copy({ status: 'PAST_DUE' }), NOW);
    expect(tx.invoice.create.mock.calls[0][0].data.status).toBe('AWAITING_PAYMENT');
  });

  it("still counts a console payment Jobber has not been sent yet against the balance", async () => {
    const tx = transaction();
    tx.invoice.findUnique.mockResolvedValue({ id: 'invoice-1', jobberUpdatedAt: null });
    tx.invoicePayment.aggregate.mockResolvedValue({ _sum: { amountCents: 1000 } });

    await applyJobberInvoice(tx as never, ORG, copy(), NOW);

    expect(tx.invoicePayment.aggregate.mock.calls[0][0].where).toEqual({
      invoiceId: 'invoice-1',
      origin: 'CONSOLE',
      jobberPaymentId: null,
    });
    expect(tx.invoice.update.mock.calls[0][0].data.balanceCents).toBe(1500);
  });

  it("matches the only visit on the job when it names none, and leaves a quarter's zone job unmatched", async () => {
    const single = transaction();
    single.inspection.findMany.mockResolvedValue([{ id: 'inspection-2', propertywareBuildingId: 'building-2' }]);
    await applyJobberInvoice(single as never, ORG, copy({ jobberVisitIds: [] }), NOW);
    expect(single.inspection.findFirst).not.toHaveBeenCalled();
    expect(single.invoice.create.mock.calls[0][0].data).toMatchObject({ inspectionId: 'inspection-2', propertywareBuildingId: 'building-2' });

    const zone = transaction();
    zone.inspection.findMany.mockResolvedValue([
      { id: 'inspection-3', propertywareBuildingId: 'building-3' },
      { id: 'inspection-4', propertywareBuildingId: 'building-4' },
    ]);
    await applyJobberInvoice(zone as never, ORG, copy({ jobberVisitIds: [] }), NOW);
    expect(zone.invoice.create.mock.calls[0][0].data).toMatchObject({ inspectionId: null, propertywareBuildingId: null });
  });

  it('removes an invoice Jobber deleted, in its own organization only', async () => {
    const tx = transaction();
    await expect(removeJobberInvoice(tx as never, ORG, 'jobber-invoice-1')).resolves.toBe(true);
    expect(tx.invoice.deleteMany).toHaveBeenCalledWith({ where: { organizationId: ORG, jobberInvoiceId: 'jobber-invoice-1' } });
  });
});

describe("Jobber's page for an invoice", () => {
  it('is kept only when it is an HTTPS address on getjobber.com', () => {
    expect(jobberPageUrl('https://secure.getjobber.com/invoices/8439')).toBe('https://secure.getjobber.com/invoices/8439');
    expect(jobberPageUrl('http://secure.getjobber.com/invoices/8439')).toBeNull();
    expect(jobberPageUrl('https://getjobber.com.example.net/invoices/8439')).toBeNull();
    expect(jobberPageUrl('javascript:alert(1)')).toBeNull();
    expect(jobberPageUrl('not a url')).toBeNull();
    expect(jobberPageUrl(null)).toBeNull();
  });
});
