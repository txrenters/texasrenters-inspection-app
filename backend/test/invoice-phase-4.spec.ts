import { DEFAULT_EMAIL_TEMPLATES, UserRole, type InvoiceDetail, type PaymentDetail } from '@texasrenters/shared';

import { InvoiceDeliveryService, attachedPdf } from '../src/admin/invoice-delivery.service';
import { invoiceChanges } from '../src/admin/invoice-edits.service';
import { invoiceEmail } from '../src/admin/invoice-email';
import { InvoiceRecordsService, cleanFileName, sniffInvoiceFile } from '../src/admin/invoice-records.service';
import { receiptEmail } from '../src/admin/invoice-reminder-email';
import { InvoiceTemplatesService } from '../src/admin/invoice-templates.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * The invoice itself (2026-11-10, phase 4 of the invoice gap review): what the
 * client sees, notes and files written in the console, the office's email
 * words and where replies go, and the PDF attached. Everything invented.
 */

const ORG = '80000000-0000-4000-8000-000000000001';
const INVOICE = '80000000-0000-4000-8000-000000000020';
const ME = '80000000-0000-4000-8000-000000000030';
const office: AuthenticatedUser = {
  id: ME,
  authUserId: 'auth-office',
  organizationId: ORG,
  displayName: 'Ada Lane',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: ['invoices:read', 'invoices:manage'],
  mustChangePassword: false,
  principalType: 'USER',
};

const DETAIL = {
  id: INVOICE,
  number: '8439',
  subject: 'For Services Rendered',
  status: 'PAST_DUE',
  clientName: '100 Example Way',
  property: null,
  issuedOn: '2026-10-01',
  dueOn: '2026-10-31',
  totalCents: 6499,
  balanceCents: 6499,
  subtotalCents: 6499,
  taxCents: 0,
  paidCents: 0,
  accountBalanceCents: 10498,
  lineItems: [{ name: 'Filter Change', description: null, quantity: 2, unitPriceCents: 3250, totalCents: 6499 }],
  clientMessage: null,
  details: { contractDisclaimer: null },
  brand: { name: 'Example Homes', addressLine1: null, addressLine2: null, phone: null, email: 'office@example.com' },
} as unknown as InvoiceDetail;

const pdf = (extra = '') => Buffer.from(`%PDF-1.4 example ${extra}`).toString('base64');

describe('the client view', () => {
  it('shows every column, the account balance and the late stamp, as Jobber does by default', () => {
    const { html } = invoiceEmail(DETAIL, DETAIL.brand!, null);
    expect(html).toContain('>Qty</th>');
    expect(html).toContain('>Unit price</th>');
    expect(html).toContain('Account balance');
    expect(html).toContain('$104.98');
    expect(html).toContain('PAST DUE');
  });

  it('leaves out what the office turned off', () => {
    const hidden = { showQuantities: false, showUnitPrices: false, showLineTotals: true, showAccountBalance: false, showLateStamp: false };
    const { html } = invoiceEmail({ ...DETAIL, clientView: hidden }, DETAIL.brand!, null);
    expect(html).not.toContain('>Qty</th>');
    expect(html).not.toContain('>Unit price</th>');
    expect(html).toContain('>Total</th>');
    expect(html).not.toContain('Account balance');
    expect(html).not.toContain('PAST DUE');
  });

  it('says on the History what was hidden or shown', () => {
    const before = {
      subject: 'S',
      number: '1',
      issuedOn: null,
      dueOn: null,
      lines: [],
      discountCents: 0,
      discountRate: null,
      discountKind: null,
      taxRateName: null,
      taxRatePercent: null,
      totalCents: 0,
      clientMessage: null,
      contractDisclaimer: null,
      showQuantities: true,
      showUnitPrices: true,
      showLineTotals: true,
      showAccountBalance: true,
      showLateStamp: true,
    };
    const changes = invoiceChanges(
      before as never,
      {
        subject: 'S',
        number: '1',
        issuedOn: '',
        dueOn: '',
        lineItems: [],
        discount: null,
        tax: null,
        clientView: { showQuantities: true, showUnitPrices: false, showLineTotals: true, showAccountBalance: true, showLateStamp: true },
      },
      { discountCents: 0, totalCents: 0 },
    );
    expect(changes).toContainEqual({ field: 'Client view: Unit prices', from: 'shown', to: 'hidden' });
    expect(changes.filter((change) => change.field.startsWith('Client view'))).toHaveLength(1);
  });
});

describe('notes and files written in the console', () => {
  function records(over: { invoice?: unknown } = {}) {
    const tx = {
      invoiceNote: { create: jest.fn().mockResolvedValue({ id: 'note-1' }), deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      invoiceFile: { create: jest.fn().mockResolvedValue({}), delete: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn() },
    };
    const db = {
      tx,
      invoice: { findFirst: jest.fn().mockResolvedValue('invoice' in over ? over.invoice : { id: INVOICE }) },
      invoiceFile: { findFirst: jest.fn().mockResolvedValue({ id: 'file-1', fileName: 'Before.jpg', storageKey: 'invoice-files/x' }) },
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const invoices = { one: jest.fn().mockResolvedValue(DETAIL) };
    const storage = { put: jest.fn().mockResolvedValue(undefined), delete: jest.fn().mockResolvedValue(undefined), durable: () => true };
    return { db, invoices, storage, service: new InvoiceRecordsService(db as never, invoices as never, storage as never) };
  }
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);

  it('writes a note as the office’s own, never Jobber’s, and audits it', async () => {
    const { db, service } = records();
    await service.addNote(office, INVOICE, '  Called the owner about it.  ');
    expect(db.tx.invoiceNote.create.mock.calls[0][0].data).toMatchObject({
      organizationId: ORG,
      invoiceId: INVOICE,
      origin: 'CONSOLE',
      jobberNoteId: null,
      createdById: ME,
      message: 'Called the owner about it.',
    });
    expect(db.tx.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'INVOICE_NOTE_ADDED', entityId: INVOICE });
  });

  it('refuses an empty note, and one on an invoice that is not the office’s', async () => {
    await expect(records().service.addNote(office, INVOICE, '   ')).rejects.toMatchObject({ code: 'INVOICE_NOTE_INVALID' });
    await expect(records({ invoice: null }).service.addNote(office, INVOICE, 'A note')).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
  });

  it('takes off only a note written here', async () => {
    const { db, service } = records();
    await service.removeNote(office, INVOICE, 'note-1');
    expect(db.tx.invoiceNote.deleteMany.mock.calls[0][0].where).toEqual({ id: 'note-1', invoiceId: INVOICE, organizationId: ORG, origin: 'CONSOLE' });
    db.tx.invoiceNote.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.removeNote(office, INVOICE, 'jobber-note')).rejects.toMatchObject({ code: 'INVOICE_NOTE_NOT_FOUND' });
  });

  it('keeps a photo in the console’s storage from the start, by what its bytes are', async () => {
    const { db, storage, service } = records();
    await service.addFile(office, INVOICE, { originalname: 'before/../photo?.png', mimetype: 'image/png', size: jpeg.length, buffer: jpeg });
    const row = db.tx.invoiceFile.create.mock.calls[0][0].data;
    expect(row).toMatchObject({ origin: 'CONSOLE', jobberFileId: null, uploadedById: ME, contentType: 'image/jpeg', fileName: 'before photo.jpg' });
    expect(storage.put).toHaveBeenCalledWith(row.storageKey, jpeg, 'image/jpeg');
    expect(row.storageKey).toBe(`invoice-files/${ORG}/${INVOICE}/${row.id}`);
  });

  it('refuses what is neither a photo nor a PDF, and what is too large', async () => {
    const { service, storage } = records();
    const text = Buffer.from('<script>not a photo</script>');
    await expect(service.addFile(office, INVOICE, { originalname: 'x.jpg', mimetype: 'image/jpeg', size: text.length, buffer: text })).rejects.toMatchObject({
      code: 'INVOICE_FILE_INVALID',
    });
    await expect(service.addFile(office, INVOICE, { originalname: 'x.jpg', mimetype: 'image/jpeg', size: 10_000_001, buffer: jpeg })).rejects.toMatchObject({
      code: 'INVOICE_FILE_INVALID',
    });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('takes the stored copy away again when the row cannot be written', async () => {
    const { db, storage, service } = records();
    db.tx.invoiceFile.create.mockRejectedValue(new Error('down'));
    await expect(service.addFile(office, INVOICE, { originalname: 'a.jpg', mimetype: 'image/jpeg', size: jpeg.length, buffer: jpeg })).rejects.toThrow('down');
    expect(storage.delete).toHaveBeenCalledWith(storage.put.mock.calls[0][0]);
  });

  it('takes off only a file added here, and its stored copy', async () => {
    const { db, storage, service } = records();
    await service.removeFile(office, INVOICE, 'file-1');
    expect(db.invoiceFile.findFirst.mock.calls[0][0].where).toMatchObject({ origin: 'CONSOLE', organizationId: ORG });
    expect(storage.delete).toHaveBeenCalledWith('invoice-files/x');
  });

  it('knows a file by its first bytes', () => {
    expect(sniffInvoiceFile(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffInvoiceFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffInvoiceFile(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffInvoiceFile(Buffer.from('\0\0\0\x18ftypheic'))).toBe('image/heic');
    expect(sniffInvoiceFile(Buffer.from('GIF89a'))).toBeNull();
    expect(cleanFileName('', 'application/pdf')).toBe('File.pdf');
  });
});

describe("the office's email words", () => {
  function templates(saved: Record<string, unknown> | null = null) {
    const tx = {
      invoiceSettings: { findUnique: jest.fn().mockResolvedValue(saved), upsert: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    const db = { tx, invoiceSettings: { findUnique: jest.fn().mockResolvedValue(saved) }, $transaction: jest.fn(async (work: (c: typeof tx) => unknown) => work(tx)) };
    return { db, service: new InvoiceTemplatesService(db as never) };
  }

  it('start as the console’s own, replies going to the company email', async () => {
    const view = await templates({ email: 'office@example.com', emailTemplates: null, replyToEmail: null, templatesUpdatedAt: null }).service.read(office);
    expect(view).toEqual({ templates: DEFAULT_EMAIL_TEMPLATES, replyTo: null, companyEmail: 'office@example.com', updatedAt: null });
  });

  it('refuse a placeholder the email does not know, and a reply-to that is no address', async () => {
    const { service } = templates();
    const bad = { ...DEFAULT_EMAIL_TEMPLATES, receipt: { subject: 'Thanks {{due_date}}', message: '' } };
    await expect(service.save(office, { templates: bad, replyTo: null, expectedUpdatedAt: null })).rejects.toMatchObject({ code: 'EMAIL_TEMPLATES_INVALID' });
    await expect(service.save(office, { templates: DEFAULT_EMAIL_TEMPLATES, replyTo: 'not-an-address', expectedUpdatedAt: null })).rejects.toMatchObject({
      code: 'EMAIL_TEMPLATES_INVALID',
    });
  });

  it('save against what was read, and say what changed', async () => {
    const { db, service } = templates();
    const words = { ...DEFAULT_EMAIL_TEMPLATES, invoice: { subject: 'Invoice {{invoice_number}}', message: 'Hi {{client_name}}' } };
    await service.save(office, { templates: words, replyTo: 'billing@example.com', expectedUpdatedAt: null });
    expect(db.tx.invoiceSettings.upsert.mock.calls[0][0].update).toMatchObject({ replyToEmail: 'billing@example.com' });
    expect(db.tx.auditLog.create.mock.calls[0][0].data.metadata).toEqual({
      changes: ['Invoice email changed', 'Replies: the company email → billing@example.com'],
    });
  });
});

describe('an invoice email, in the office’s words, with its PDF', () => {
  function sender(saved: Record<string, unknown> | null = null) {
    const db = {
      invoiceSettings: {
        findUnique: jest.fn(async ({ select }: { select: Record<string, boolean> }) => ('invoicingTakenOverAt' in select ? { invoicingTakenOverAt: new Date() } : saved)),
      },
      invoiceDelivery: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({ id: 'd1' }), update: jest.fn() },
      auditLog: { create: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(),
    };
    db.$transaction.mockImplementation((work: (tx: typeof db) => unknown) => work(db));
    const invoices = { one: jest.fn().mockResolvedValue({ ...DETAIL, status: 'AWAITING_PAYMENT' }) };
    const mail = { sendInvoice: jest.fn().mockResolvedValue({ status: 'SENT' }) };
    return { db, mail, service: new InvoiceDeliveryService(db as never, invoices as never, mail as never) };
  }
  const words = {
    emailTemplates: { invoice: { subject: '{{company_name}}: invoice {{invoice_number}}', message: 'Dear {{client_name}}, {{balance_due}} by {{due_date}}.' } },
    replyToEmail: 'billing@example.com',
    templatesUpdatedAt: null,
    email: 'office@example.com',
  };

  it('fills the subject, and the message when the press wrote none (Batch Deliver), with replies to the office', async () => {
    const { db, mail, service } = sender(words);
    await service.send(office, INVOICE, { to: ['owner@example.com'], message: null, clientRequestId: 'press-0001' });
    const [email] = mail.sendInvoice.mock.calls[0]!;
    expect(email.subject).toBe('Example Homes: invoice 8439');
    expect(email.replyTo).toBe('billing@example.com');
    expect(email.html).toContain('Dear 100 Example Way, $64.99 by Oct 31, 2026.');
    expect(db.invoiceDelivery.create.mock.calls[0][0].data.message).toBe('Dear 100 Example Way, $64.99 by Oct 31, 2026.');
  });

  it('keeps the note somebody wrote, and none when they cleared it', async () => {
    const { mail, service } = sender(words);
    await service.send(office, INVOICE, { to: ['owner@example.com'], message: '', clientRequestId: 'press-0002' });
    expect(mail.sendInvoice.mock.calls[0]![0].html).not.toContain('Dear');
  });

  it('attaches the PDF the browser made, once it is checked to be one', async () => {
    const { mail, service } = sender();
    await service.send(office, INVOICE, {
      to: ['owner@example.com'],
      message: null,
      clientRequestId: 'press-0003',
      attachment: { fileName: '100 Example Way_Invoice 8439.pdf', contentBase64: pdf() },
    });
    const [email] = mail.sendInvoice.mock.calls[0]!;
    expect(email.attachments).toEqual([{ name: '100 Example Way_Invoice 8439.pdf', contentType: 'application/pdf', contentBase64: pdf() }]);
    // No reply-to chosen: the company email on the invoice.
    expect(email.replyTo).toBe('office@example.com');
  });

  it('refuses an attachment that is not a PDF, or too large to ride on an email', () => {
    expect(() => attachedPdf({ fileName: 'x.pdf', contentBase64: Buffer.from('<html>').toString('base64') })).toThrow('not a PDF');
    expect(() => attachedPdf({ fileName: 'x.pdf', contentBase64: pdf('x'.repeat(61_000)) })).toThrow('too large');
    expect(attachedPdf({ fileName: '../../etc/passwd', contentBase64: pdf() }).name).toBe('etc passwd.pdf');
  });

  it('writes a receipt in the office’s words', () => {
    const payment = {
      paidOn: '2026-11-20',
      amountCents: 3999,
      method: 'CHECK',
      reference: null,
      invoice: { id: INVOICE, number: '8439', subject: 'S', clientName: '100 Example Way' },
      invoiceBalanceCents: 0,
    } as unknown as PaymentDetail;
    const email = receiptEmail(payment, DETAIL.brand!, { subject: 'Thanks, {{client_name}}', message: 'We got {{payment_amount}} on {{payment_date}}.' });
    expect(email.subject).toBe('Thanks, 100 Example Way');
    expect(email.html).toContain('We got $39.99 on Nov 20, 2026.');
  });
});
