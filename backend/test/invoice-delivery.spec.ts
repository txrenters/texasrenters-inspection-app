import { recipientsProblem, type InvoiceDetail } from '@texasrenters/shared';
import { Prisma, UserRole } from '@prisma/client';

import { InvoiceDeliveryController } from '../src/admin/invoice-delivery.controller';
import { InvoiceDeliveryService } from '../src/admin/invoice-delivery.service';
import { historyEvent } from '../src/admin/invoice-edits.service';
import { invoiceEmail } from '../src/admin/invoice-email';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Sending an invoice by email (2026-11-06, phase 5). A billed call each, so:
 * on a press only, five people at most, under a daily ceiling counted from
 * what was sent, once per press however often it is repeated, and off until
 * the cutover. Addresses, names and ids invented.
 */

const ORG = '20000000-0000-4000-8000-000000000001';
const INVOICE = '20000000-0000-4000-8000-000000000020';
const office: AuthenticatedUser = {
  id: '20000000-0000-4000-8000-000000000009',
  authUserId: 'auth-office',
  organizationId: ORG,
  displayName: 'Office Coordinator',
  roles: [UserRole.INSPECTION_SUPERVISOR],
  permissions: ['invoices:read', 'invoices:manage'],
  mustChangePassword: false,
  principalType: 'USER',
} as AuthenticatedUser;

const INVOICE_DETAIL = {
  id: INVOICE,
  number: '8439',
  subject: 'For Services Rendered',
  status: 'AWAITING_PAYMENT',
  clientName: '100 Example Way',
  property: { id: 'b1', address: '100 Example Way', city: 'Sampletown' },
  inspectionId: null,
  jobNumber: null,
  issuedOn: '2026-11-01',
  dueOn: '2026-12-01',
  totalCents: 6499,
  balanceCents: 2500,
  jobberUrl: null,
  paymentTerms: 'Net 30',
  billingAddress: null,
  lineItems: [
    { name: 'Filter Change', description: null, quantity: 1, unitPriceCents: 3999, totalCents: 3999 },
    { name: 'Pest <Control>', description: 'Front & back', quantity: 1, unitPriceCents: 2500, totalCents: 2500 },
  ],
  subtotalCents: 6499,
  taxCents: 0,
  payments: [],
  clientMessage: 'Thank you for your business.',
  accountBalanceCents: null,
  createdAt: '2026-11-01T14:00:00.000Z',
  paidCents: 3999,
  brand: { name: 'Example Company', addressLine1: '1 Example Plaza', addressLine2: null, phone: '555-0100', email: null },
} as unknown as InvoiceDetail;

function setup(detail: Partial<InvoiceDetail> = {}, sentToday: string[][] = []) {
  const db = {
    // Jobber still holds the invoices: not taken over (phase 8).
    invoiceSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    invoiceDelivery: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue(sentToday.map((recipients) => ({ recipients }))),
      create: jest.fn().mockResolvedValue({ id: 'delivery-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([{ locked: '' }]),
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((work: (tx: typeof db) => unknown) => work(db));
  const invoices = { one: jest.fn().mockResolvedValue({ ...INVOICE_DETAIL, ...detail }) };
  const mail = { sendInvoice: jest.fn().mockResolvedValue({ status: 'SENT', message: 'Email sent successfully.' }) };
  const service = new InvoiceDeliveryService(db as never, invoices as never, mail as never);
  return { db, invoices, mail, service };
}

const input = { to: ['owner@example.com', ' second@example.com '], message: 'Here is this quarter.', clientRequestId: 'web-send-0001' };

beforeEach(() => {
  process.env.JOBBER_INVOICE_WRITES_ENABLED = 'true';
  delete process.env.INVOICE_EMAIL_DAILY_CEILING;
});
afterEach(() => {
  delete process.env.JOBBER_INVOICE_WRITES_ENABLED;
});

describe('sending an invoice', () => {
  it('claims the send first, emails each person once, and puts it on the record', async () => {
    const { db, mail, service } = setup();

    await service.send(office, INVOICE, input);

    // Counted and claimed under the office's email lock.
    expect((db.$queryRaw.mock.calls[0][0] as string[]).join('?')).toContain('pg_advisory_xact_lock');
    expect(db.$queryRaw.mock.calls[0]).toContain(`invoice-email:${ORG}`);
    expect(db.invoiceDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: ORG,
        invoiceId: INVOICE,
        channel: 'EMAIL',
        recipients: ['owner@example.com', 'second@example.com'],
        message: 'Here is this quarter.',
        status: 'PENDING',
        sentById: office.id,
        clientRequestId: 'web-send-0001',
      }),
      select: { id: true },
    });
    expect(mail.sendInvoice.mock.calls.map(([sent]) => sent.to)).toEqual(['owner@example.com', 'second@example.com']);
    expect(mail.sendInvoice.mock.calls[0][0].subject).toBe('Invoice #8439 from Example Company');
    expect(db.invoiceDelivery.update).toHaveBeenCalledWith({
      where: { id: 'delivery-1' },
      data: { status: 'SENT', failure: null, sentAt: expect.any(Date) },
    });
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'INVOICE_SENT',
      entityType: 'Invoice',
      entityId: INVOICE,
      actorUserId: office.id,
      metadata: { deliveryId: 'delivery-1', channel: 'EMAIL', to: ['owner@example.com', 'second@example.com'], status: 'SENT' },
    });
  });

  it('sends nothing past the daily ceiling, counted from what the office sent today', async () => {
    process.env.INVOICE_EMAIL_DAILY_CEILING = '3';
    const { db, mail, service } = setup({}, [['a@example.com', 'b@example.com']]);

    await expect(service.send(office, INVOICE, input)).rejects.toMatchObject({
      code: 'INVOICE_EMAIL_CEILING',
      message: 'The office has sent 2 of its 3 invoice emails today. More can go tomorrow.',
    });
    expect(db.invoiceDelivery.findMany.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      createdAt: { gte: expect.any(Date) },
      status: { in: ['PENDING', 'SENT'] },
    });
    expect(db.invoiceDelivery.create).not.toHaveBeenCalled();
    expect(mail.sendInvoice).not.toHaveBeenCalled();
  });

  it('answers a repeated press with the invoice, sending nothing again', async () => {
    const { db, mail, service } = setup();
    db.invoiceDelivery.findFirst.mockResolvedValue({ invoiceId: INVOICE, status: 'SENT', failure: null });
    await service.send(office, INVOICE, input);
    expect(mail.sendInvoice).not.toHaveBeenCalled();
    await expect(service.send(office, '20000000-0000-4000-8000-000000000021', input)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('answers a repeated press of a send that failed with the same failure, sending nothing', async () => {
    const { db, mail, service } = setup();
    db.invoiceDelivery.findFirst.mockResolvedValue({ invoiceId: INVOICE, status: 'FAILED', failure: 'Email is not set up for the console yet.' });
    await expect(service.send(office, INVOICE, input)).rejects.toMatchObject({
      code: 'INVOICE_EMAIL_FAILED',
      message: 'Email is not set up for the console yet.',
    });
    expect(mail.sendInvoice).not.toHaveBeenCalled();
  });

  it('sends nothing when the same press arrives twice at once', async () => {
    const { db, mail, service } = setup();
    db.invoiceDelivery.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ invoiceId: INVOICE, status: 'PENDING', failure: null });
    db.invoiceDelivery.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
    );
    await service.send(office, INVOICE, input);
    expect(mail.sendInvoice).not.toHaveBeenCalled();
  });

  it('records a send that did not go, and says why', async () => {
    const { db, mail, service } = setup();
    mail.sendInvoice.mockResolvedValue({ status: 'NOT_CONFIGURED', message: 'Microsoft Graph mail is not fully configured.' });

    await expect(service.send(office, INVOICE, input)).rejects.toMatchObject({
      code: 'INVOICE_EMAIL_FAILED',
      message: 'Email is not set up for the console yet. Not sent to owner@example.com, second@example.com.',
    });
    expect(db.invoiceDelivery.update.mock.calls[0][0].data).toMatchObject({ status: 'FAILED', sentAt: null });
    expect(db.auditLog.create.mock.calls[0][0].data.metadata).toMatchObject({ status: 'FAILED' });
  });

  it('counts a send that reached some of its people as sent, naming who it missed', async () => {
    const { db, mail, service } = setup();
    mail.sendInvoice.mockResolvedValueOnce({ status: 'SENT' }).mockResolvedValueOnce({ status: 'FAILED' });
    await service.send(office, INVOICE, input);
    expect(db.invoiceDelivery.update.mock.calls[0][0].data).toMatchObject({
      status: 'SENT',
      failure: 'The mail provider did not take it. Not sent to second@example.com.',
    });
  });

  it('asks for a draft to be marked sent first, and sends no voided invoice', async () => {
    await expect(setup({ status: 'DRAFT' }).service.send(office, INVOICE, input)).rejects.toMatchObject({
      code: 'INVOICE_NOT_SENDABLE',
      message: 'Mark the draft sent before it is emailed.',
    });
    await expect(setup({ status: 'VOIDED' }).service.send(office, INVOICE, input)).rejects.toMatchObject({ code: 'INVOICE_NOT_SENDABLE' });
  });

  it('sends nothing kept in Xero (2026-11-12): Xero sends it', async () => {
    const { mail, service } = setup({ xero: { status: 'AUTHORISED', url: 'https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=x-1', kept: true } });
    await expect(service.send(office, INVOICE, input)).rejects.toMatchObject({ code: 'INVOICE_KEPT_IN_XERO', status: 409 });
    expect(mail.sendInvoice).not.toHaveBeenCalled();
  });

  it('refuses too many people, or an address that is not one, before anything else', async () => {
    const { mail, invoices, service } = setup();
    const six = Array.from({ length: 6 }, (_, index) => `p${index}@example.com`);
    await expect(service.send(office, INVOICE, { ...input, to: six })).rejects.toMatchObject({ code: 'INVOICE_SEND_INVALID' });
    await expect(service.send(office, INVOICE, { ...input, to: ['not an address'] })).rejects.toMatchObject({
      code: 'INVOICE_SEND_INVALID',
      message: 'not an address is not an email address.',
    });
    expect(invoices.one).not.toHaveBeenCalled();
    expect(mail.sendInvoice).not.toHaveBeenCalled();
  });

  it('is off while Jobber holds the invoices', async () => {
    delete process.env.JOBBER_INVOICE_WRITES_ENABLED;
    const { db, mail, service } = setup();
    await expect(service.send(office, INVOICE, input)).rejects.toMatchObject({ code: 'INVOICE_WRITES_OFF' });
    expect(db.invoiceDelivery.create).not.toHaveBeenCalled();
    expect(mail.sendInvoice).not.toHaveBeenCalled();
  });
});

describe('who it may go to', () => {
  it('is one to five addresses that look like addresses, each once', () => {
    expect(recipientsProblem(['owner@example.com'])).toBeNull();
    expect(recipientsProblem([])).toBe('Choose who it goes to.');
    expect(recipientsProblem(['a@example.com', 'A@example.com'])).toBe('An address is listed twice.');
    expect(recipientsProblem(['owner@example'])).toBe('owner@example is not an email address.');
  });
});

describe('the email', () => {
  it('carries the invoice itself, every value escaped, with the note on top and what is due', () => {
    const email = invoiceEmail(INVOICE_DETAIL, INVOICE_DETAIL.brand!, 'Hello <b>owner</b>\nSee below.');
    expect(email.subject).toBe('Invoice #8439 from Example Company');
    expect(email.title).toBe('Invoice #8439: $25.00 due Dec 1, 2026');
    expect(email.html).toContain('Hello &lt;b&gt;owner&lt;/b&gt;<br>See below.');
    expect(email.html).toContain('Pest &lt;Control&gt;');
    expect(email.html).toContain('Front &amp; back');
    expect(email.html).not.toContain('<Control>');
    expect(email.html).toContain('Balance due');
    expect(email.html).toContain('$25.00');
    expect(email.html).toContain('-$39.99');
    expect(email.html).toContain('Thank you for your business.');
    expect(email.html).toContain('Example Company · 1 Example Plaza · 555-0100');
  });
});

describe('the history', () => {
  it('says who it was emailed to, and why one did not go', () => {
    const at = new Date('2026-11-06T15:00:00Z');
    expect(historyEvent({ id: 'a', action: 'INVOICE_SENT', createdAt: at, metadata: { to: ['owner@example.com'], status: 'SENT' } }, null)).toMatchObject({
      title: 'Emailed',
      lines: ['To owner@example.com'],
    });
    expect(
      historyEvent({ id: 'b', action: 'INVOICE_SENT', createdAt: at, metadata: { to: ['owner@example.com'], status: 'FAILED', failure: 'Email is not set up.' } }, null),
    ).toMatchObject({ title: 'Email not sent', lines: ['To owner@example.com', 'Email is not set up.'] });
  });
});

describe('who may send', () => {
  it('is whoever makes invoices, which an API key never is', () => {
    const permissions = Reflect.getMetadata('permissions', (InvoiceDeliveryController.prototype as unknown as Record<string, object>).send!);
    expect(permissions).toEqual(['invoices:read', 'invoices:manage']);
  });
});
