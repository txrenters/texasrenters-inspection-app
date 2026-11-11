import { UserRole } from '@texasrenters/shared';
import { Prisma } from '@prisma/client';

import { InvoiceDeliveryService } from '../src/admin/invoice-delivery.service';
import { InvoiceFollowUpsService } from '../src/admin/invoice-follow-ups.service';
import type { AuthenticatedUser } from '../src/common/auth';
import { shownInvoices } from '../src/admin/shown-invoices';

/**
 * What Jobber did for the office on its own and stops at Take over (2026-11-09):
 * follow-up emails about unpaid invoices, receipts, and many invoices emailed at
 * once. Every email is billed, so: nothing before Take over, nothing twice, and
 * all of it under the office's daily ceiling. Names and addresses invented.
 */

const ORG = '50000000-0000-4000-8000-000000000001';
const ME = '50000000-0000-4000-8000-000000000030';
const TODAY = '2026-11-20';

const person: AuthenticatedUser = {
  id: ME,
  authUserId: 'auth-me',
  organizationId: ORG,
  displayName: 'Ada Lane',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: ['invoices:read', 'invoices:manage', 'payments:record'],
  mustChangePassword: false,
  principalType: 'USER',
};

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

const owed = (id: string, dueOn: string, over: Record<string, unknown> = {}) => ({
  id,
  status: 'AWAITING_PAYMENT',
  balanceCents: 3999,
  dueOn: day(dueOn),
  clientEmails: ['owner@example.com'],
  deliveries: [],
  ...over,
});

const unique = () => new Prisma.PrismaClientKnownRequestError('taken', { code: 'P2002', clientVersion: 'test' });

function harness(opts: {
  takenOver?: boolean;
  settings?: Record<string, unknown> | null;
  invoices?: ReturnType<typeof owed>[];
  sentToday?: number;
  taken?: Set<string>;
} = {}) {
  const created: Record<string, unknown>[] = [];
  const taken = opts.taken ?? new Set<string>();
  let sentToday = opts.sentToday ?? 0;
  const tx = {
    // Which companies' books are read from Xero (2026-11-12): none here.
    xeroSettings: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    invoiceDelivery: {
      findMany: jest.fn(async () => (sentToday ? [{ recipients: Array.from({ length: sentToday }, () => 'x@example.com') }] : [])),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> & { clientRequestId: string; recipients: string[] } }) => {
        if (taken.has(data.clientRequestId)) throw unique();
        taken.add(data.clientRequestId);
        sentToday += data.recipients.length;
        created.push(data);
        return { id: `delivery-${created.length}` };
      }),
    },
  };
  const prisma = {
    // Which companies' books are read from Xero (2026-11-12): none here.
    xeroSettings: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
    invoiceSettings: {
      findUnique: jest.fn(async ({ select }: { select: Record<string, boolean> }) => {
        if ('invoicingTakenOverAt' in select) return opts.takenOver === false ? null : { invoicingTakenOverAt: new Date() };
        return opts.settings === undefined ? null : opts.settings;
      }),
    },
    invoice: { findMany: jest.fn().mockResolvedValue(opts.invoices ?? []) },
    invoiceDelivery: { update: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const detail = (id: string) => ({
    id,
    number: id.replace('inv-', ''),
    clientName: '100 Example Way',
    property: null,
    issuedOn: '2026-10-21',
    dueOn: '2026-11-20',
    lineItems: [],
    balanceCents: 3999,
    totalCents: 3999,
    clientMessage: null,
    details: null,
    brand: { name: 'Example Homes', addressLine1: null, addressLine2: null, phone: null, email: 'office@example.com' },
  });
  const invoices = { one: jest.fn(async (_user: unknown, id: string) => detail(id)) };
  const mail = { sendInvoice: jest.fn().mockResolvedValue({ status: 'SENT' }) };
  const followUps = new InvoiceFollowUpsService(prisma as never, invoices as never, mail as never);
  return { prisma, tx, invoices, mail, followUps, created };
}

describe('invoice follow-ups', () => {
  it('sends nothing before Take over: Jobber sends its own, and two would reach the client', async () => {
    const { followUps, prisma, mail } = harness({ takenOver: false, invoices: [owed('inv-1', TODAY)] });
    await expect(followUps.run(ORG, TODAY)).resolves.toMatchObject({ skipped: 'NOT_TAKEN_OVER', sent: 0 });
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(mail.sendInvoice).not.toHaveBeenCalled();
  });

  it('sends nothing when the office turned them off', async () => {
    const { followUps, mail } = harness({
      settings: { followUpsEnabled: false, followUpDays: [0, 4], receiptsAutomatic: false, emailSettingsUpdatedAt: null },
      invoices: [owed('inv-1', TODAY)],
    });
    await expect(followUps.run(ORG, TODAY)).resolves.toMatchObject({ skipped: 'OFF' });
    expect(mail.sendInvoice).not.toHaveBeenCalled();
  });

  it("follows Jobber's days by default: the due date, then four days after", async () => {
    const { followUps, prisma } = harness();
    await followUps.run(ORG, TODAY);
    const { where } = prisma.invoice.findMany.mock.calls[0]![0] as { where: Record<string, unknown> & { dueOn: { in: Date[] } } };
    // Never an invoice read back from Xero (2026-11-12): its company's reminders are Xero's.
    expect(where).toMatchObject({ organizationId: ORG, ...shownInvoices([], { outsideXeroBooks: true }), status: 'AWAITING_PAYMENT', balanceCents: { gt: 0 } });
    expect(where.dueOn.in.map((value) => value.toISOString().slice(0, 10))).toEqual(['2026-11-20', '2026-11-16']);
  });

  it('emails each one in Jobber’s words, keyed so the same day never sends it twice', async () => {
    const { followUps, mail, created } = harness({ invoices: [owed('inv-1', TODAY), owed('inv-2', '2026-11-16')] });

    await expect(followUps.run(ORG, TODAY)).resolves.toMatchObject({ sent: 2, failed: 0 });

    expect(created.map((claim) => [claim.kind, claim.followUpDay, claim.clientRequestId, claim.sentById])).toEqual([
      ['FOLLOW_UP', 0, 'follow-up:inv-1:2026-11-20:0', null],
      ['FOLLOW_UP', 4, 'follow-up:inv-2:2026-11-16:4', null],
    ]);
    expect(mail.sendInvoice.mock.calls.map(([email]) => email.subject)).toEqual([
      'Your invoice from Example Homes is due today',
      'Your invoice from Example Homes is 4 days overdue',
    ]);
    expect(mail.sendInvoice.mock.calls[0]![0].html).toContain('If the payment has already been sent, please ignore this email.');
  });

  it('sends nothing twice: a second run the same day finds them claimed', async () => {
    const taken = new Set<string>();
    const first = harness({ invoices: [owed('inv-1', TODAY)], taken });
    await first.followUps.run(ORG, TODAY);
    const second = harness({ invoices: [owed('inv-1', TODAY)], taken });

    await expect(second.followUps.run(ORG, TODAY)).resolves.toMatchObject({ sent: 0, already: 1 });
    expect(second.mail.sendInvoice).not.toHaveBeenCalled();
  });

  it('goes to whoever the invoice was last sent to, else the client’s own addresses', async () => {
    const { followUps, mail } = harness({
      invoices: [owed('inv-1', TODAY, { deliveries: [{ recipients: ['tenant@example.com'] }] })],
    });
    await followUps.run(ORG, TODAY);
    expect(mail.sendInvoice.mock.calls.map(([email]) => email.to)).toEqual(['tenant@example.com']);
  });

  it('skips an invoice with nobody to send it to, and says so', async () => {
    const { followUps, mail } = harness({ invoices: [owed('inv-1', TODAY, { clientEmails: [] })] });
    await expect(followUps.run(ORG, TODAY)).resolves.toMatchObject({ sent: 0, noAddress: 1 });
    expect(mail.sendInvoice).not.toHaveBeenCalled();
  });

  it('stops at the day’s ceiling and counts the rest, rather than sending past it', async () => {
    const { followUps, mail } = harness({
      sentToday: 199,
      invoices: [owed('inv-1', TODAY), owed('inv-2', TODAY), owed('inv-3', TODAY)],
    });
    await expect(followUps.run(ORG, TODAY)).resolves.toMatchObject({ sent: 1, overCeiling: 2 });
    expect(mail.sendInvoice).toHaveBeenCalledTimes(1);
  });

  it('records each on the invoice’s history as sent by nobody', async () => {
    const { followUps, prisma } = harness({ invoices: [owed('inv-1', TODAY)] });
    await followUps.run(ORG, TODAY);
    expect(prisma.auditLog.create.mock.calls[0]![0].data).toMatchObject({
      actorUserId: null,
      action: 'INVOICE_FOLLOW_UP_SENT',
      entityType: 'Invoice',
      entityId: 'inv-1',
      metadata: expect.objectContaining({ day: 0, status: 'SENT' }),
    });
  });

  it('refuses a follow-up day it cannot keep', async () => {
    const { followUps } = harness();
    await expect(
      followUps.saveSettings(person, { followUpsEnabled: true, followUpDays: [0, 0], receiptsAutomatic: false, expectedUpdatedAt: null }),
    ).rejects.toMatchObject({ code: 'INVOICE_EMAIL_SETTINGS_INVALID' });
  });
});

describe('receipts and many invoices at once', () => {
  const payment = {
    id: 'pay-1',
    paidOn: '2026-11-20',
    amountCents: 3999,
    method: 'BANK_TRANSFER',
    reference: 'ACH-1',
    invoice: { id: 'inv-1', number: '8439', subject: 'For Services Rendered', clientName: '100 Example Way' },
    invoiceBalanceCents: 0,
    brand: { name: 'Example Homes', addressLine1: null, addressLine2: null, phone: null, email: 'office@example.com' },
    receiptTo: ['owner@example.com'],
  };

  function delivery(opts: { automatic?: boolean; sentToday?: number; status?: string } = {}) {
    const base = harness({ sentToday: opts.sentToday });
    const prisma = {
      ...base.prisma,
      invoiceSettings: {
        findUnique: jest.fn(async ({ select }: { select: Record<string, boolean> }) =>
          'invoicingTakenOverAt' in select
            ? { invoicingTakenOverAt: new Date() }
            : { followUpsEnabled: true, followUpDays: [0, 4], receiptsAutomatic: Boolean(opts.automatic), emailSettingsUpdatedAt: null },
        ),
      },
      invoicePayment: { findFirst: jest.fn().mockResolvedValue({ id: 'pay-1' }) },
      invoiceDelivery: { ...base.prisma.invoiceDelivery, findFirst: jest.fn().mockResolvedValue(null) },
    };
    const invoices = {
      one: jest.fn(async (_user: unknown, id: string) => ({ id, status: opts.status ?? 'AWAITING_PAYMENT', brand: payment.brand, lineItems: [], clientName: 'x', number: '1', issuedOn: null, dueOn: null, balanceCents: 1, totalCents: 1, clientMessage: null, details: null, property: null })),
      onePayment: jest.fn().mockResolvedValue(payment),
    };
    const service = new InvoiceDeliveryService(prisma as never, invoices as never, base.mail as never);
    return { service, prisma, mail: base.mail, created: base.created };
  }

  it('emails a receipt in Jobber’s words, as a receipt for that payment', async () => {
    const { service, mail, created } = delivery();
    await service.sendReceipt(person, 'pay-1', { to: ['owner@example.com'], clientRequestId: 'press-0001' });
    expect(created[0]).toMatchObject({ kind: 'RECEIPT', paymentId: 'pay-1', invoiceId: 'inv-1', sentById: ME });
    expect(mail.sendInvoice.mock.calls[0]![0].subject).toBe('Receipt for payment from Example Homes - Nov 20, 2026');
    expect(mail.sendInvoice.mock.calls[0]![0].html).toContain('Please keep this email for your reference.');
  });

  it('sends one by itself after a payment only when the office chose automatic receipts', async () => {
    const off = delivery({ automatic: false });
    await off.service.receiptAfterPayment(person, 'inv-1', 'press-0002');
    expect(off.mail.sendInvoice).not.toHaveBeenCalled();

    const on = delivery({ automatic: true });
    await on.service.receiptAfterPayment(person, 'inv-1', 'press-0002');
    expect(on.created[0]).toMatchObject({ kind: 'RECEIPT', clientRequestId: 'receipt:pay-1' });
    expect(on.mail.sendInvoice).toHaveBeenCalledTimes(1);
  });

  it('never fails the payment over a receipt', async () => {
    const { service, mail } = delivery({ automatic: true });
    mail.sendInvoice.mockRejectedValue(new Error('provider down'));
    await expect(service.receiptAfterPayment(person, 'inv-1', 'press-0003')).resolves.toBeUndefined();
  });

  it('emails many invoices, each under its own key within the press', async () => {
    const { service, created } = delivery();
    const { results } = await service.deliverMany(person, {
      batchKey: 'batch-0001',
      invoices: [
        { invoiceId: 'inv-1', to: ['a@example.com'] },
        { invoiceId: 'inv-2', to: ['b@example.com'] },
      ],
    });
    expect(results.map((result) => result.status)).toEqual(['SENT', 'SENT']);
    expect(created.map((claim) => claim.clientRequestId)).toEqual(['batch-0001:inv-1', 'batch-0001:inv-2']);
  });

  it('stops at the day’s ceiling and says so for the rest', async () => {
    const { service } = delivery({ sentToday: 199 });
    const { results } = await service.deliverMany(person, {
      batchKey: 'batch-0002',
      invoices: [
        { invoiceId: 'inv-1', to: ['a@example.com'] },
        { invoiceId: 'inv-2', to: ['b@example.com'] },
        { invoiceId: 'inv-3', to: ['c@example.com'] },
      ],
    });
    expect(results.map((result) => result.status)).toEqual(['SENT', 'FAILED', 'FAILED']);
    expect(results[2]!.problem).toMatch(/invoice emails today/);
  });

  it('refuses more than fifty at once', async () => {
    const { service } = delivery();
    const invoices = Array.from({ length: 51 }, (_, index) => ({ invoiceId: `inv-${index}`, to: ['a@example.com'] }));
    await expect(service.deliverMany(person, { batchKey: 'batch-0003', invoices })).rejects.toMatchObject({ code: 'DELIVERY_TOO_MANY' });
  });
});
