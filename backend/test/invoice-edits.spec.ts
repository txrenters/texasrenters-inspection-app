import { MACHINE_FORBIDDEN_PERMISSIONS } from '@texasrenters/shared';
import { UserRole } from '@prisma/client';

import { InvoiceEditsController } from '../src/admin/invoice-edits.controller';
import { InvoiceEditsService, historyEvent, invoiceChanges } from '../src/admin/invoice-edits.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Editing an invoice in the console (2026-11-06, phase 3): its details, lines,
 * discount and tax; its state; deleting a draft; and its history. Off until
 * the cutover, held to the invoice as it was read, and on the record. Ids,
 * names and addresses invented.
 */

const ORG = '20000000-0000-4000-8000-000000000001';
const INVOICE = '20000000-0000-4000-8000-000000000020';
const READ_AT = '2026-11-01T15:00:00.000Z';
const date = (day: string) => new Date(`${day}T00:00:00.000Z`);

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

/** A $64.99 invoice owing all of it, as the edit reads it. */
const stored = (over: Record<string, unknown> = {}) => ({
  id: INVOICE,
  status: 'AWAITING_PAYMENT',
  number: '8439',
  subject: 'For Services Rendered',
  issuedOn: date('2026-11-01'),
  dueOn: date('2099-12-01'),
  paidOn: null,
  totalCents: 6499,
  balanceCents: 6499,
  discountCents: 0,
  discountRate: null,
  discountKind: null,
  taxRateName: null,
  taxRatePercent: null,
  clientMessage: 'Thank you.',
  contractDisclaimer: null,
  updatedAt: new Date(READ_AT),
  lines: [
    { name: 'Filter Change', quantity: 1, unitPriceCents: 3999, description: null, serviceOn: null, taxable: true },
    { name: 'Pest Control', quantity: 1, unitPriceCents: 2500, description: null, serviceOn: null, taxable: true },
  ],
  ...over,
});

const edit = (over: Record<string, unknown> = {}) => ({
  subject: ' Quarterly service ',
  number: '8439',
  issuedOn: '2026-11-01',
  dueOn: '2099-12-01',
  lineItems: [
    { name: 'Filter Change', quantity: 1, unitPriceCents: 3999 },
    { name: 'Pest Control', quantity: 1, unitPriceCents: 2500, taxable: false },
  ],
  discount: { kind: 'PERCENT' as const, percent: 10 },
  tax: { name: 'Texas', percent: 8.25 },
  clientMessage: ' Thank you. ',
  contractDisclaimer: '',
  expectedUpdatedAt: READ_AT,
  ...over,
});

function database(row: Record<string, unknown> | null = stored(), paidCents = 0) {
  const db = {
    invoice: {
      findFirst: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoiceLine: { deleteMany: jest.fn(), createMany: jest.fn() },
    invoicePayment: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amountCents: paidCents }, _max: { paidOn: date('2026-11-03') } }),
    },
    auditLog: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    userProfile: { findMany: jest.fn().mockResolvedValue([]) },
    // The number lock, then the highest number the office has: #8439.
    $queryRaw: jest.fn().mockResolvedValue([{ highest: '8439' }]),
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((work: (tx: typeof db) => unknown) => work(db));
  return db;
}

function service(db: ReturnType<typeof database>) {
  const invoices = { one: jest.fn().mockResolvedValue({ id: INVOICE }) };
  return { edits: new InvoiceEditsService(db as never, invoices as never), invoices };
}

describe('while Jobber holds the invoices', () => {
  it('refuses every edit, and writes nothing', async () => {
    delete process.env.JOBBER_INVOICE_WRITES_ENABLED;
    const db = database();
    const { edits } = service(db);

    await expect(edits.edit(office, INVOICE, edit())).rejects.toMatchObject({ code: 'INVOICE_WRITES_OFF' });
    await expect(edits.changeStatus(office, INVOICE, { action: 'VOID', expectedUpdatedAt: READ_AT })).rejects.toMatchObject({
      code: 'INVOICE_WRITES_OFF',
    });
    await expect(edits.remove(office, INVOICE, READ_AT)).rejects.toMatchObject({ code: 'INVOICE_WRITES_OFF' });
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('once the console owns invoicing', () => {
  beforeEach(() => {
    process.env.JOBBER_INVOICE_WRITES_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.JOBBER_INVOICE_WRITES_ENABLED;
  });

  describe('editing', () => {
    it('works the totals out from the lines, discount and tax, and writes them only over what was read', async () => {
      const db = database();
      const { edits, invoices } = service(db);

      await edits.edit(office, INVOICE, edit());

      // $64.99 less 10% ($6.50); tax on the filter after its share: 8.25% of $35.99 = $2.97.
      expect(db.invoice.updateMany).toHaveBeenCalledWith({
        where: { id: INVOICE, organizationId: ORG, updatedAt: new Date(READ_AT) },
        data: expect.objectContaining({
          subject: 'Quarterly service',
          subtotalCents: 6499,
          discountCents: 650,
          discountKind: 'PERCENT',
          discountRate: 10,
          taxCents: 297,
          taxRateName: 'Texas',
          taxRatePercent: 8.25,
          taxInclusive: false,
          totalCents: 6146,
          balanceCents: 6146,
          status: 'AWAITING_PAYMENT',
          paidOn: null,
          paymentTermsDays: expect.any(Number),
          clientMessage: 'Thank you.',
          contractDisclaimer: null,
        }),
      });
      expect(db.invoiceLine.deleteMany).toHaveBeenCalledWith({ where: { invoiceId: INVOICE } });
      expect(db.invoiceLine.createMany.mock.calls[0][0].data).toEqual([
        expect.objectContaining({ position: 0, name: 'Filter Change', totalCents: 3999, taxable: true, serviceOn: null }),
        expect.objectContaining({ position: 1, name: 'Pest Control', totalCents: 2500, taxable: false }),
      ]);
      expect(invoices.one).toHaveBeenCalledWith(office, INVOICE);
    });

    it('puts what changed on the record, field by field, in words', async () => {
      const db = database();
      await service(db).edits.edit(office, INVOICE, edit());

      expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({
        action: 'INVOICE_EDITED',
        entityType: 'Invoice',
        entityId: INVOICE,
        actorUserId: office.id,
        metadata: {
          changes: expect.arrayContaining([
            { field: 'Subject', from: 'For Services Rendered', to: 'Quarterly service' },
            { field: 'Discount', from: 'none', to: '10% ($6.50)' },
            { field: 'Tax', from: 'none', to: 'Texas 8.25%' },
            { field: 'Total', from: '$64.99', to: '$61.46' },
          ]),
        },
      });
    });

    it('marks it paid when its payments now cover it, on the day of the latest', async () => {
      const db = database(stored({ balanceCents: 2500 }), 3999);
      await service(db).edits.edit(office, INVOICE, edit({ lineItems: [{ name: 'Filter Change', quantity: 1, unitPriceCents: 3999 }], discount: null, tax: null }));
      expect(db.invoice.updateMany.mock.calls[0][0].data).toMatchObject({ balanceCents: 0, status: 'PAID', paidOn: date('2026-11-03') });
    });

    it('keeps a draft a draft', async () => {
      const db = database(stored({ status: 'DRAFT' }));
      await service(db).edits.edit(office, INVOICE, edit());
      expect(db.invoice.updateMany.mock.calls[0][0].data.status).toBe('DRAFT');
    });

    it('never brings it below what has been paid', async () => {
      const db = database(stored(), 6000);
      await expect(
        service(db).edits.edit(office, INVOICE, edit({ lineItems: [{ name: 'Pest Control', quantity: 1, unitPriceCents: 2500 }], discount: null, tax: null })),
      ).rejects.toMatchObject({ code: 'INVOICE_INVALID', message: expect.stringContaining('less than the $60.00 already paid') });
      expect(db.invoice.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a number another invoice of the office has', async () => {
      const db = database();
      db.invoice.findFirst.mockResolvedValueOnce(stored()).mockResolvedValueOnce({ id: 'other' });
      await expect(service(db).edits.edit(office, INVOICE, edit({ number: '9000' }))).rejects.toMatchObject({
        code: 'INVOICE_NUMBER_TAKEN',
        message: 'Invoice #9000 is another invoice already.',
      });
      expect(db.invoice.findFirst.mock.calls[1][0].where).toEqual({ organizationId: ORG, number: '9000', id: { not: INVOICE } });
    });

    it('refuses an invoice changed since it was read, before or during the write', async () => {
      const stale = database(stored({ updatedAt: new Date('2026-11-01T15:05:00.000Z') }));
      await expect(service(stale).edits.edit(office, INVOICE, edit())).rejects.toMatchObject({ code: 'INVOICE_CHANGED' });

      const raced = database();
      raced.invoice.updateMany.mockResolvedValue({ count: 0 });
      await expect(service(raced).edits.edit(office, INVOICE, edit())).rejects.toMatchObject({ code: 'INVOICE_CHANGED' });
      expect(raced.invoiceLine.deleteMany).not.toHaveBeenCalled();
      expect(raced.auditLog.create).not.toHaveBeenCalled();
    });

    it('asks for a voided or bad-debt invoice to be reopened first', async () => {
      await expect(service(database(stored({ status: 'VOIDED' }))).edits.edit(office, INVOICE, edit())).rejects.toMatchObject({
        code: 'INVOICE_LOCKED',
        message: 'A voided invoice is reopened before it is edited.',
      });
    });

    it('is not found in another office', async () => {
      await expect(service(database(null)).edits.edit(office, INVOICE, edit())).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    });
  });

  describe("an invoice's state", () => {
    const change = (action: 'MARK_SENT' | 'VOID' | 'BAD_DEBT' | 'REOPEN') => ({ action, expectedUpdatedAt: READ_AT });

    it('voids an invoice nobody has paid anything on, owing nothing', async () => {
      const db = database();
      await service(db).edits.changeStatus(office, INVOICE, change('VOID'));
      expect(db.invoice.updateMany).toHaveBeenCalledWith({
        where: { id: INVOICE, organizationId: ORG, updatedAt: new Date(READ_AT) },
        data: { status: 'VOIDED', balanceCents: 0 },
      });
      expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({
        action: 'INVOICE_STATUS_CHANGED',
        metadata: { action: 'VOID', from: 'AWAITING_PAYMENT', to: 'VOIDED', balanceCents: 0 },
      });
    });

    it('refuses to void one with payments, and says what to do instead', async () => {
      const db = database(stored({ balanceCents: 2500 }), 3999);
      await expect(service(db).edits.changeStatus(office, INVOICE, change('VOID'))).rejects.toMatchObject({
        code: 'INVOICE_ACTION_REFUSED',
        message: 'It has payments. Remove them first, or close it as bad debt.',
      });
      expect(db.invoice.updateMany).not.toHaveBeenCalled();
    });

    it('closes an invoice still owing as bad debt, keeping what it owed', async () => {
      const db = database(stored({ balanceCents: 2500 }), 3999);
      await service(db).edits.changeStatus(office, INVOICE, change('BAD_DEBT'));
      expect(db.invoice.updateMany.mock.calls[0][0].data).toEqual({ status: 'BAD_DEBT' });
    });

    it('reopens one, owing again what its payments leave', async () => {
      const db = database(stored({ status: 'BAD_DEBT', balanceCents: 2500 }), 3999);
      await service(db).edits.changeStatus(office, INVOICE, change('REOPEN'));
      expect(db.invoice.updateMany.mock.calls[0][0].data).toEqual({ status: 'AWAITING_PAYMENT', balanceCents: 2500, paidOn: null });

      const covered = database(stored({ status: 'VOIDED', balanceCents: 0 }), 6499);
      await service(covered).edits.changeStatus(office, INVOICE, change('REOPEN'));
      expect(covered.invoice.updateMany.mock.calls[0][0].data).toEqual({ status: 'PAID', balanceCents: 0, paidOn: date('2026-11-03') });
    });

    it('marks a draft sent, and nothing else', async () => {
      const db = database(stored({ status: 'DRAFT' }));
      await service(db).edits.changeStatus(office, INVOICE, change('MARK_SENT'));
      expect(db.invoice.updateMany.mock.calls[0][0].data).toEqual({ status: 'AWAITING_PAYMENT', balanceCents: 6499, paidOn: null });

      await expect(service(database()).edits.changeStatus(office, INVOICE, change('MARK_SENT'))).rejects.toMatchObject({
        code: 'INVOICE_ACTION_REFUSED',
      });
    });
  });

  describe('deleting', () => {
    it('deletes a draft nobody paid anything on, keeping what it was on the record', async () => {
      const db = database(stored({ status: 'DRAFT' }));
      await expect(service(db).edits.remove(office, INVOICE, READ_AT)).resolves.toEqual({ id: INVOICE });
      expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({
        action: 'INVOICE_DELETED',
        entityId: INVOICE,
        metadata: { number: '8439', subject: 'For Services Rendered', totalCents: 6499, issuedOn: '2026-11-01' },
      });
      expect(db.invoice.deleteMany).toHaveBeenCalledWith({ where: { id: INVOICE, organizationId: ORG, updatedAt: new Date(READ_AT) } });
    });

    it('refuses anything sent: it is voided instead, and stays', async () => {
      const db = database();
      await expect(service(db).edits.remove(office, INVOICE, READ_AT)).rejects.toMatchObject({ code: 'INVOICE_NOT_DELETABLE' });
      expect(db.invoice.deleteMany).not.toHaveBeenCalled();
    });
  });
});

describe("an invoice's history", () => {
  it('lists what happened to it, newest first, with who did it, in its own office only', async () => {
    const db = database();
    db.auditLog.findMany.mockResolvedValue([
      { id: 'a2', action: 'INVOICE_STATUS_CHANGED', createdAt: new Date('2026-11-03T15:00:00Z'), actorUserId: office.id, metadata: { action: 'VOID', from: 'AWAITING_PAYMENT', to: 'VOIDED', balanceCents: 0 } },
      { id: 'a1', action: 'INVOICE_PAYMENT_RECORDED', createdAt: new Date('2026-11-02T15:00:00Z'), actorUserId: null, metadata: { amountCents: 1000, method: 'CHECK', paidOn: '2026-11-02', balanceCents: 5499 } },
    ]);
    db.userProfile.findMany.mockResolvedValue([{ id: office.id, displayName: 'Office Coordinator' }]);

    const history = await service(db).edits.history(office, INVOICE);

    expect(db.auditLog.findMany.mock.calls[0][0]).toMatchObject({
      where: { organizationId: ORG, entityType: 'Invoice', entityId: INVOICE },
      orderBy: { createdAt: 'desc' },
    });
    expect(history).toEqual({
      items: [
        { id: 'a2', at: '2026-11-03T15:00:00.000Z', actor: { id: office.id, displayName: 'Office Coordinator' }, title: 'Void invoice', lines: ['Awaiting payment → Voided', 'Balance $0.00'] },
        { id: 'a1', at: '2026-11-02T15:00:00.000Z', actor: null, title: 'Payment recorded', lines: ['$10.00 by Check, paid Nov 2, 2026', 'Balance $54.99'] },
      ],
      truncated: false,
    });
  });

  it('is not found in another office', async () => {
    await expect(service(database(null)).edits.history(office, INVOICE)).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
  });

  it('words a change to a payment and an edit as they were made', () => {
    const at = new Date('2026-11-03T15:00:00Z');
    expect(
      historyEvent(
        { id: 'a', action: 'INVOICE_PAYMENT_CHANGED', createdAt: at, metadata: { before: { amountCents: 4000, paidOn: '2026-11-01', method: 'CHECK', reference: '1042' }, after: { amountCents: 5000, paidOn: '2026-11-01', method: 'CHECK', reference: '1042' }, balanceCents: 1499 } },
        null,
      ).lines,
    ).toEqual(['Amount: $40.00 → $50.00', 'Balance $14.99']);
    expect(
      historyEvent({ id: 'b', action: 'INVOICE_EDITED', createdAt: at, metadata: { changes: [{ field: 'Subject', from: 'A', to: 'B' }] } }, null).lines,
    ).toEqual(['Subject: A → B']);
  });

  it('names lines added and taken off', () => {
    const changes = invoiceChanges(
      stored() as never,
      { ...edit(), subject: 'For Services Rendered', clientMessage: 'Thank you.', contractDisclaimer: null, discount: null, tax: null, lineItems: [{ name: 'Filter Change', quantity: 2, unitPriceCents: 3999 }] },
      { discountCents: 0, totalCents: 7998 },
    );
    expect(changes).toEqual([
      { field: 'Lines', from: 'Filter Change × 1 at $39.99; Pest Control × 1 at $25.00', to: 'Filter Change × 2 at $39.99' },
      { field: 'Total', from: '$64.99', to: '$79.98' },
    ]);
  });
});

describe('who may do what', () => {
  const permissionsOf = (name: string) =>
    Reflect.getMetadata('permissions', (InvoiceEditsController.prototype as unknown as Record<string, object>)[name]!) as string[];

  it('keeps editing to the grant that makes invoices, and the history to reading', () => {
    expect(permissionsOf('edit')).toEqual(['invoices:read', 'invoices:manage']);
    expect(permissionsOf('changeStatus')).toEqual(['invoices:read', 'invoices:manage']);
    expect(permissionsOf('remove')).toEqual(['invoices:read', 'invoices:manage']);
    expect(permissionsOf('history')).toEqual(['invoices:read']);
    expect(MACHINE_FORBIDDEN_PERMISSIONS).toContain('invoices:manage');
  });
});
