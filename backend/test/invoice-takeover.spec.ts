import { JobberConnectionStatus, Prisma, UserRole } from '@prisma/client';

import { invoiceWritesOn } from '../src/admin/invoice-settings';
import type { AuthenticatedUser } from '../src/common/auth';
import { InvoiceTakeoverController } from '../src/integrations/jobber/invoice-takeover.controller';
import { InvoiceTakeoverService, lastReadProblem } from '../src/integrations/jobber/invoice-takeover.service';
import {
  applyJobberInvoice,
  pairJobberPayment,
  removeJobberInvoice,
  type JobberInvoiceCopy,
  type JobberPaymentDetails,
} from '../src/integrations/jobber/jobber-invoice-copy';
import { JobberInvoiceWorker, type InvoiceReadResult } from '../src/workers/jobber-sync/jobber-invoice.worker';

/**
 * Taking invoicing over from Jobber (2026-11-06, phase 8, the cutover): ready
 * once every invoice and payment is read, Jobber answers and every file is
 * kept; one last read, then the console owns invoicing and nothing of
 * Jobber's reaches the copy again; undone only while nothing changed since.
 * Ids invented.
 */

const ORG = '20000000-0000-4000-8000-000000000001';
const TAKEN_AT = new Date('2026-11-06T16:00:00.000Z');

const admin: AuthenticatedUser = {
  id: '20000000-0000-4000-8000-000000000009',
  authUserId: 'auth-admin',
  organizationId: ORG,
  displayName: 'System Admin',
  roles: [UserRole.SYSTEM_ADMIN],
  permissions: ['invoices:read', 'invoices:manage', 'integrations:manage'],
  mustChangePassword: false,
  principalType: 'USER',
} as AuthenticatedUser;

const READ: InvoiceReadResult = {
  mode: 'changed',
  pages: 1,
  created: 0,
  updated: 2,
  stale: 0,
  readAlone: 0,
  caughtUp: true,
  paymentPages: 1,
  paired: 0,
  unpaired: 0,
  paymentsCaughtUp: true,
  problem: null,
  skipped: null,
};

const connection = (over: Record<string, unknown> = {}) => ({
  status: JobberConnectionStatus.CONNECTED,
  invoiceReadCompletedAt: new Date('2026-11-05T10:00:00Z'),
  invoiceReadCheckedAt: new Date('2026-11-06T15:58:00Z'),
  invoiceReadProblem: null,
  paymentReadCompletedAt: new Date('2026-11-05T11:00:00Z'),
  ...over,
});

function setup({
  settings = null as Record<string, unknown> | null,
  files = [10, 10, 0] as number[],
  conn = connection() as unknown,
  // The companies that send to Xero, and whether their books are read back (2026-11-12).
  sending = [] as { booksReadAt: Date | null; xeroOrganisation: { name: string } }[],
  // The products offered, and each Xero company with its sending (2026-11-13).
  products = [] as { name: string; xeroTenantId: string | null }[],
  companies = [] as { xeroTenantId: string; name: string; status: string; settings: { sendingEnabled: boolean } | null }[],
} = {}) {
  const [total, kept, failed] = files;
  const db = {
    xeroSettings: { findMany: jest.fn().mockResolvedValue(sending) },
    invoiceProduct: { findMany: jest.fn().mockResolvedValue(products) },
    xeroOrganisation: { findMany: jest.fn().mockResolvedValue(companies) },
    invoiceSettings: {
      findUnique: jest.fn().mockResolvedValue(settings),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    jobberConnection: { findUnique: jest.fn().mockResolvedValue(conn) },
    invoiceFile: {
      count: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.copyAttempts ? failed : where.storageKey ? kept : total,
      ),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    auditLog: { create: jest.fn(), count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((work: (tx: typeof db) => unknown) => work(db));
  const worker = { run: jest.fn().mockResolvedValue(READ) };
  return { db, worker, service: new InvoiceTakeoverService(db as never, worker as never) };
}

afterEach(() => delete process.env.JOBBER_INVOICE_WRITES_ENABLED);

describe('what the cutover waits on', () => {
  it('is every invoice and payment read, Jobber answering, and every file kept or tried', async () => {
    const ready = await setup().service.view(admin);
    expect(ready.ready).toBe(true);
    expect(ready.checks.map((check) => [check.key, check.ok])).toEqual([
      ['JOBBER_ANSWERS', true],
      ['INVOICES_READ', true],
      ['PAYMENTS_READ', true],
      ['FILES_COPIED', true],
      ['FILES_FAILED', true],
      ['COMPANY_DETAILS', false],
      ['PRODUCTS_GO_TO_XERO', true],
      ['XERO_BOOKS_READ', true],
    ]);

    const waiting = await setup({ files: [10, 6, 1], conn: connection({ paymentReadCompletedAt: null }) }).service.view(admin);
    expect(waiting.ready).toBe(false);
    expect(waiting.checks.find((check) => check.key === 'FILES_COPIED')).toMatchObject({ ok: false, detail: '6 of 10 kept; 3 still to copy.' });
    expect(waiting.checks.find((check) => check.key === 'PAYMENTS_READ')).toMatchObject({ ok: false });
    expect(waiting.failedFiles).toBe(1);
  });

  it('is not held back by files that failed, nor by company details: those are to know', async () => {
    const view = await setup({ files: [10, 8, 2] }).service.view(admin);
    expect(view.ready).toBe(true);
    expect(view.checks.find((check) => check.key === 'FILES_FAILED')).toMatchObject({ ok: false, blocking: false });
  });
});

describe('the switch without Jobber (2026-11-12)', () => {
  it('waits for each company that sends to Xero to have its books read back first', async () => {
    const view = await setup({
      sending: [
        { booksReadAt: new Date('2026-11-12T22:05:00Z'), xeroOrganisation: { name: 'Example Home Services' } },
        { booksReadAt: null, xeroOrganisation: { name: 'Example Pest Co' } },
      ],
    }).service.view(admin);
    expect(view.ready).toBe(false);
    expect(view.checks.find((check) => check.key === 'XERO_BOOKS_READ')).toMatchObject({ ok: false, blocking: true, detail: expect.stringContaining('Example Pest Co') });
  });

  it('waits for each product to go to a company that sends to Xero (2026-11-13): else its invoices reach no books', async () => {
    const companies = [
      { xeroTenantId: 'tenant-home', name: 'Example Home Services', status: 'CONNECTED', settings: { sendingEnabled: true } },
      { xeroTenantId: 'tenant-pest', name: 'Example Pest Co', status: 'CONNECTED', settings: { sendingEnabled: false } },
      { xeroTenantId: 'tenant-air', name: 'Example Air', status: 'REMOVED', settings: { sendingEnabled: true } },
      { xeroTenantId: 'tenant-new', name: 'Example New Co', status: 'CONNECTED', settings: null },
    ];
    const products = [
      { name: 'Filter Change', xeroTenantId: 'tenant-home' },
      { name: 'Flea Treatment', xeroTenantId: 'tenant-pest' },
      { name: 'Pest Control', xeroTenantId: 'tenant-pest' },
      { name: 'Duct Cleaning', xeroTenantId: 'tenant-air' },
      { name: 'Gutter Check', xeroTenantId: 'tenant-new' },
      { name: 'Key Copy', xeroTenantId: null },
    ];
    const { service } = setup({ products, companies });
    const view = await service.view(admin);
    expect(view.ready).toBe(false);
    const check = view.checks.find((each) => each.key === 'PRODUCTS_GO_TO_XERO');
    expect(check).toMatchObject({ ok: false, blocking: true });
    expect(check?.detail).toBe(
      'Flea Treatment, Pest Control (Example Pest Co, sending off); Duct Cleaning (Example Air, not connected); Gutter Check (Example New Co, sending off); Key Copy (no company). Turn sending on for its company on the Xero page, give the product a company in Invoices → Settings, or set it aside.',
    );
    await expect(service.takeOver(admin, {})).rejects.toMatchObject({ code: 'INVOICE_TAKEOVER_NOT_READY' });

    // Every product's company sending: ready.
    const ready = await setup({ products: products.slice(0, 1), companies }).service.view(admin);
    expect(ready.checks.find((each) => each.key === 'PRODUCTS_GO_TO_XERO')).toMatchObject({ ok: true, detail: null });
    expect(ready.ready).toBe(true);
  });

  it('is not held back by Jobber once it is disconnected, and reads nothing more from it', async () => {
    const { db, worker, service } = setup({ conn: connection({ status: JobberConnectionStatus.DISCONNECTED, paymentReadCompletedAt: null }), files: [10, 4, 0] });
    const view = await service.view(admin);
    expect(view).toMatchObject({ ready: true, jobberConnected: false });
    for (const key of ['JOBBER_ANSWERS', 'INVOICES_READ', 'PAYMENTS_READ', 'FILES_COPIED'])
      expect(view.checks.find((check) => check.key === key)).toMatchObject({ blocking: false });
    await service.takeOver(admin, {});
    expect(worker.run).not.toHaveBeenCalled();
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'INVOICING_TAKEN_OVER', metadata: { lastRead: null } });
  });
});

describe('taking invoicing over', () => {
  it('reads Jobber one last time, then records when and by whom, on the record', async () => {
    const { db, worker, service } = setup();
    await service.takeOver(admin, {});
    expect(worker.run).toHaveBeenCalledWith(ORG);
    expect(db.invoiceSettings.create).toHaveBeenCalledWith({
      data: { organizationId: ORG, invoicingTakenOverAt: expect.any(Date), invoicingTakenOverById: admin.id },
    });
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'INVOICING_TAKEN_OVER',
      entityType: 'InvoiceSettings',
      actorUserId: admin.id,
      metadata: { files: { total: 10, kept: 10, failed: 0 }, acceptedFailedFiles: false },
    });
  });

  it('only over settings that are not taken over already', async () => {
    const saved = setup({ settings: { companyName: 'Example Company', invoicingTakenOverAt: null } });
    await saved.service.takeOver(admin, {});
    expect(saved.db.invoiceSettings.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, invoicingTakenOverAt: null },
      data: { invoicingTakenOverAt: expect.any(Date), invoicingTakenOverById: admin.id },
    });
    const taken = setup({ settings: { invoicingTakenOverAt: TAKEN_AT } });
    await expect(taken.service.takeOver(admin, {})).rejects.toMatchObject({ code: 'INVOICING_ALREADY_TAKEN_OVER' });
    expect(taken.worker.run).not.toHaveBeenCalled();
  });

  it('waits for what it waits on, and for the office to say the failed files can be left', async () => {
    const notReady = setup({ files: [10, 6, 0] });
    await expect(notReady.service.takeOver(admin, {})).rejects.toMatchObject({ code: 'INVOICE_TAKEOVER_NOT_READY' });
    expect(notReady.worker.run).not.toHaveBeenCalled();

    const failed = setup({ files: [10, 8, 2] });
    await expect(failed.service.takeOver(admin, {})).rejects.toMatchObject({ code: 'INVOICE_TAKEOVER_FILES' });
    await failed.service.takeOver(admin, { acceptFailedFiles: true });
    expect(failed.db.auditLog.create.mock.calls[0][0].data.metadata).toMatchObject({ acceptedFailedFiles: true });
  });

  it('changes nothing when the last read does not reach the end, or finds files still to copy', async () => {
    const short = setup();
    short.worker.run.mockResolvedValue({ ...READ, caughtUp: false });
    await expect(short.service.takeOver(admin, {})).rejects.toMatchObject({
      code: 'INVOICE_TAKEOVER_LAST_READ',
      message: 'Jobber has more changes than one read takes. Try again in a few minutes. Nothing was changed.',
    });
    expect(short.db.invoiceSettings.create).not.toHaveBeenCalled();

    const newFiles = setup();
    // 10 files before the read, 12 after it: two new ones to copy.
    newFiles.db.invoiceFile.count
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(0);
    await expect(newFiles.service.takeOver(admin, {})).rejects.toMatchObject({
      message: 'The last read found 2 files to copy. They are copied within a few minutes; try again then.',
    });
    expect(newFiles.db.invoiceSettings.create).not.toHaveBeenCalled();
  });

  it('says why a last read failed', () => {
    expect(lastReadProblem(READ)).toBeNull();
    expect(lastReadProblem({ ...READ, skipped: 'NOT_CONNECTED' })).toBe('Jobber is not connected.');
    expect(lastReadProblem({ ...READ, problem: 'NOT_PERMITTED' })).toMatch(/invoice permission/);
    expect(lastReadProblem({ ...READ, mode: 'all' })).toMatch(/more changes/);
    expect(lastReadProblem({ ...READ, paymentsCaughtUp: false })).toMatch(/payments/);
  });

  it('refuses two at once, the second finding it taken', async () => {
    const { db, service } = setup();
    db.invoiceSettings.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Unique', { code: 'P2002', clientVersion: 'test' }));
    await expect(service.takeOver(admin, {})).rejects.toMatchObject({ code: 'INVOICING_ALREADY_TAKEN_OVER' });
  });
});

describe('undoing it', () => {
  it('gives invoicing back to Jobber while nothing has changed in the console since, on the record', async () => {
    const { db, service } = setup({ settings: { invoicingTakenOverAt: TAKEN_AT } });
    await service.undo(admin);
    expect(db.auditLog.count).toHaveBeenCalledWith({ where: { organizationId: ORG, entityType: 'Invoice', createdAt: { gt: TAKEN_AT } } });
    expect(db.invoiceSettings.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, invoicingTakenOverAt: TAKEN_AT },
      data: { invoicingTakenOverAt: null, invoicingTakenOverById: null },
    });
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'INVOICING_TAKEOVER_UNDONE' });
  });

  it('refuses once an invoice was changed here: reading Jobber again would overwrite it', async () => {
    const { db, service } = setup({ settings: { invoicingTakenOverAt: TAKEN_AT } });
    db.auditLog.count.mockResolvedValue(3);
    await expect(service.undo(admin)).rejects.toMatchObject({ code: 'INVOICE_TAKEOVER_NOT_UNDOABLE' });
    expect(db.invoiceSettings.updateMany).not.toHaveBeenCalled();
    const view = await service.view(admin);
    expect(view).toMatchObject({ takenOverAt: TAKEN_AT.toISOString(), changesSince: 3, undoable: false, checks: [] });
  });
});

describe('once taken over', () => {
  const takenOver = () => ({ invoiceSettings: { findUnique: jest.fn().mockResolvedValue({ invoicingTakenOverAt: TAKEN_AT }) } });

  it("lets nothing of Jobber's into the copy, in the writer's own transaction", async () => {
    const tx = { ...takenOver(), invoice: { findUnique: jest.fn(), deleteMany: jest.fn() }, invoicePayment: { findFirst: jest.fn() } };
    expect(await applyJobberInvoice(tx as never, ORG, {} as JobberInvoiceCopy)).toBe('stale');
    expect(await removeJobberInvoice(tx as never, ORG, 'jobber-invoice-1')).toBe(false);
    expect(await pairJobberPayment(tx as never, ORG, {} as JobberPaymentDetails)).toBe('unmatched');
    expect(tx.invoice.findUnique).not.toHaveBeenCalled();
    expect(tx.invoice.deleteMany).not.toHaveBeenCalled();
    expect(tx.invoicePayment.findFirst).not.toHaveBeenCalled();
  });

  it('asks Jobber nothing: neither the scheduled read nor a webhook', async () => {
    const prisma = { ...takenOver(), jobberConnection: { findUnique: jest.fn().mockResolvedValue(connection()) } };
    const client = { requestDetailed: jest.fn(), request: jest.fn() };
    const worker = new JobberInvoiceWorker(prisma as never, client as never, {} as never);
    expect(await worker.run(ORG)).toMatchObject({ skipped: 'TAKEN_OVER', pages: 0 });
    expect(await worker.refreshInvoice(ORG, 'jobber-invoice-1')).toBe('stale');
    expect(await worker.refreshForPayment(ORG, 'jobber-payment-1')).toBe('stale');
    expect(client.requestDetailed).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("turns the console's invoice writes on; the server's switch still does too, for trying them out", async () => {
    expect(await invoiceWritesOn(takenOver() as never, ORG)).toBe(true);
    const held = { invoiceSettings: { findUnique: jest.fn().mockResolvedValue(null) } };
    expect(await invoiceWritesOn(held as never, ORG)).toBe(false);
    process.env.JOBBER_INVOICE_WRITES_ENABLED = 'true';
    expect(await invoiceWritesOn(held as never, ORG)).toBe(true);
  });
});

describe('who may take it over', () => {
  it('is whoever both makes invoices and runs the integrations; whoever reads invoices sees what it waits on', () => {
    const permissions = (method: keyof InvoiceTakeoverController) =>
      Reflect.getMetadata('permissions', (InvoiceTakeoverController.prototype as unknown as Record<string, object>)[method]!);
    expect(permissions('view')).toEqual(['invoices:read']);
    expect(permissions('takeOver')).toEqual(['invoices:read', 'invoices:manage', 'integrations:manage']);
    expect(permissions('undo')).toEqual(['invoices:read', 'invoices:manage', 'integrations:manage']);
  });
});
