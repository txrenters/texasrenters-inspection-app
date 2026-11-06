import { UserRole } from '@prisma/client';

import { InvoiceFilesController } from '../src/admin/invoice-files.controller';
import { InvoiceFilesService, fileCopyStatus } from '../src/admin/invoice-files.service';
import type { AuthenticatedUser } from '../src/common/auth';
import { inlineDisposition, invoiceFileKey } from '../src/common/invoice-file-storage.service';
import { JobberError } from '../src/integrations/jobber/jobber.errors';
import {
  FileCopyError,
  JobberInvoiceFileWorker,
  APP_LINK_PROBLEM,
  MAX_COPY_ATTEMPTS,
  downloadAddress,
  downloadFile,
  dueForCopy,
  sourceToCopy,
} from '../src/workers/jobber-sync/jobber-invoice-files.worker';

/**
 * Copying the files on Jobber's invoices into the console's own storage
 * (2026-11-06, phase 7): Jobber's links stop working when the office leaves
 * it. Each copy is a billed write to the storage provider, so each file is
 * copied once, a couple of dozen a run, under a daily ceiling counted from the
 * attempts on record. Names, ids and addresses invented.
 */

const ORG = '20000000-0000-4000-8000-000000000001';
const INVOICE = '20000000-0000-4000-8000-000000000020';
const OTHER_INVOICE = '20000000-0000-4000-8000-000000000021';
const FILE = '20000000-0000-4000-8000-000000000050';

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

const pending = (index: number, over: Record<string, unknown> = {}) => ({
  id: `file-${index}`,
  invoiceId: INVOICE,
  jobberFileId: `jobber-file-${index}`,
  contentType: 'image/jpeg',
  copyAttempts: 0,
  copyAttemptedAt: null as Date | null,
  invoice: { jobberInvoiceId: 'jobber-invoice-1' },
  ...over,
});

const freshFiles = (ids: string[], over: Record<string, unknown> = {}) => ({
  invoice: {
    id: 'jobber-invoice-1',
    noteAttachments: {
      nodes: ids.map((id) => ({ id, contentType: 'image/jpeg', fileSize: 3, url: `https://files.example.com/${id}?signed=1`, ...over })),
    },
  },
});

/** An iPhone photo's `url`: a JPEG conversion on Jobber's web app, which answers the console 403. */
const APP_LINK = 'https://secure.getjobber.com/rails/active_storage/representations/redirect/a/b/photo.heic';
const ORIGINAL = 'https://files.example.com/original?signed=1';

function setup(files: ReturnType<typeof pending>[] = [pending(1)], triedToday = 0) {
  const db = {
    invoiceFile: {
      count: jest.fn().mockResolvedValue(triedToday),
      findMany: jest.fn().mockResolvedValue(files),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const client = { request: jest.fn().mockResolvedValue(freshFiles(files.map((file) => file.jobberFileId))) };
  const storage = { durable: jest.fn().mockReturnValue(true), put: jest.fn().mockResolvedValue(undefined) };
  const worker = new JobberInvoiceFileWorker(db as never, client as never, storage as never);
  return { db, client, storage, worker };
}

let fetchSpy: jest.SpyInstance;
beforeEach(() => {
  delete process.env.INVOICE_FILE_COPY_DAILY_CEILING;
  fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
});
afterEach(() => fetchSpy.mockRestore());

describe('copying the files', () => {
  it("asks Jobber once per invoice for fresh links, then keeps each file under the console's own ids", async () => {
    const { db, client, storage, worker } = setup([pending(1), pending(2)]);
    const result = await worker.run(ORG);

    expect(result).toEqual({ copied: 2, failed: 0, skipped: null });
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request.mock.calls[0][2]).toEqual({ id: 'jobber-invoice-1' });
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
      'https://files.example.com/jobber-file-1?signed=1',
      'https://files.example.com/jobber-file-2?signed=1',
    ]);
    expect(storage.put).toHaveBeenCalledWith(invoiceFileKey(ORG, INVOICE, 'file-1'), Buffer.from([1, 2, 3]), 'image/jpeg');
    expect(invoiceFileKey(ORG, INVOICE, 'file-1')).toBe(`invoice-files/${ORG}/${INVOICE}/file-1`);
    expect(db.invoiceFile.update.mock.calls[0][0]).toEqual({
      where: { id: 'file-1' },
      data: { storageKey: invoiceFileKey(ORG, INVOICE, 'file-1'), copiedAt: expect.any(Date), copyProblem: null },
    });
  });

  it('counts each try before anything is downloaded, and only takes a file nobody else has', async () => {
    const { db, storage, worker } = setup([pending(1)]);
    db.invoiceFile.updateMany.mockResolvedValue({ count: 0 });
    expect(await worker.run(ORG)).toEqual({ copied: 0, failed: 1, skipped: null });
    expect(db.invoiceFile.updateMany).toHaveBeenCalledWith({
      where: { id: 'file-1', organizationId: ORG, storageKey: null, copyAttempts: 0 },
      data: { copyAttempts: { increment: 1 }, copyAttemptedAt: expect.any(Date) },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('never copies a kept file again: only files with no copy are read', async () => {
    const { db, worker } = setup();
    await worker.run(ORG);
    expect(db.invoiceFile.findMany.mock.calls[0][0].where).toEqual({
      organizationId: ORG,
      storageKey: null,
      copyAttempts: { lt: MAX_COPY_ATTEMPTS },
    });
  });

  it('takes 25 a run from 5,000 waiting, and no more than the day has left', async () => {
    const many = Array.from({ length: 5_000 }, (_, index) => pending(index, { invoiceId: index % 2 ? INVOICE : OTHER_INVOICE }));
    const big = setup(many);
    expect((await big.worker.run(ORG)).copied).toBe(25);
    expect(big.storage.put).toHaveBeenCalledTimes(25);
    // Two invoices: two queries to Jobber, however many files.
    expect(big.client.request).toHaveBeenCalledTimes(2);

    process.env.INVOICE_FILE_COPY_DAILY_CEILING = '2000';
    const late = setup(many, 1_997);
    expect((await late.worker.run(ORG)).copied).toBe(3);
    expect(late.db.invoiceFile.count.mock.calls[0][0].where).toEqual({ organizationId: ORG, copyAttemptedAt: { gte: expect.any(Date) } });

    const spent = setup(many, 2_000);
    expect(await spent.worker.run(ORG)).toEqual({ copied: 0, failed: 0, skipped: 'CEILING' });
    expect(spent.db.invoiceFile.findMany).not.toHaveBeenCalled();
  });

  it('is off at a ceiling of 0, and never copies onto a disk the next deploy wipes', async () => {
    process.env.INVOICE_FILE_COPY_DAILY_CEILING = '0';
    expect((await setup().worker.run(ORG)).skipped).toBe('OFF');
    delete process.env.INVOICE_FILE_COPY_DAILY_CEILING;
    const local = setup();
    local.storage.durable.mockReturnValue(false);
    expect((await local.worker.run(ORG)).skipped).toBe('NOT_CONFIGURED');
    expect(local.db.invoiceFile.count).not.toHaveBeenCalled();
  });

  it('stops trying a file Jobber no longer has, and says so', async () => {
    const { db, client, worker } = setup([pending(1)]);
    client.request.mockResolvedValue(freshFiles([]));
    await worker.run(ORG);
    expect(db.invoiceFile.update.mock.calls[0][0].data).toEqual({ copyProblem: 'Jobber no longer has this file.', copyAttempts: MAX_COPY_ATTEMPTS });

    client.request.mockResolvedValue({ invoice: null });
    db.invoiceFile.update.mockClear();
    await worker.run(ORG);
    expect(db.invoiceFile.update.mock.calls[0][0].data).toEqual({ copyProblem: 'Jobber no longer has this invoice.', copyAttempts: MAX_COPY_ATTEMPTS });
  });

  it("keeps an iPhone photo's HEIC original, under its own type, not the JPEG Jobber calls it", async () => {
    const { db, client, storage, worker } = setup([pending(1)]);
    client.request.mockResolvedValue(
      freshFiles(['jobber-file-1'], { url: APP_LINK, contentType: 'image/jpeg', downloadUrl: ORIGINAL, downloadContentType: 'image/heic' }),
    );

    expect(await worker.run(ORG)).toEqual({ copied: 1, failed: 0, skipped: null });
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([ORIGINAL]);
    expect(storage.put).toHaveBeenCalledWith(invoiceFileKey(ORG, INVOICE, 'file-1'), Buffer.from([1, 2, 3]), 'image/heic');
    expect(db.invoiceFile.update.mock.calls[0][0].data).toMatchObject({ copyProblem: null });
  });

  it('stops at once when no link is in storage: one try, no download, and the reason in words', async () => {
    for (const links of [{ url: APP_LINK }, { url: APP_LINK, downloadUrl: `${APP_LINK}/download` }]) {
      fetchSpy.mockClear();
      const { db, client, storage, worker } = setup([pending(1)]);
      client.request.mockResolvedValue(freshFiles(['jobber-file-1'], links));

      expect(await worker.run(ORG)).toEqual({ copied: 0, failed: 1, skipped: null });
      expect(db.invoiceFile.updateMany).toHaveBeenCalledTimes(1);
      expect(db.invoiceFile.update.mock.calls[0][0].data).toEqual({ copyProblem: APP_LINK_PROBLEM, copyAttempts: MAX_COPY_ATTEMPTS });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
    }
  });

  it('tries again later when the download fails, and counts nothing when Jobber does not answer', async () => {
    const failing = setup([pending(1)]);
    fetchSpy.mockResolvedValue(new Response('no', { status: 503 }));
    await failing.worker.run(ORG);
    expect(failing.db.invoiceFile.update.mock.calls[0][0].data).toEqual({ copyProblem: "Jobber's storage answered 503." });

    const away = setup([pending(1)]);
    away.client.request.mockRejectedValue(new JobberError('Throttled', 'JOBBER_THROTTLED', 429, true));
    expect(await away.worker.run(ORG)).toEqual({ copied: 0, failed: 0, skipped: null });
    expect(away.db.invoiceFile.updateMany).not.toHaveBeenCalled();
  });

  it('waits longer after each failed try, and stops after the last', () => {
    const now = Date.parse('2026-11-06T12:00:00Z');
    const ago = (hours: number) => new Date(now - hours * 3_600_000);
    expect(dueForCopy({ copyAttempts: 0, copyAttemptedAt: null }, now)).toBe(true);
    expect(dueForCopy({ copyAttempts: 1, copyAttemptedAt: ago(0.5) }, now)).toBe(false);
    expect(dueForCopy({ copyAttempts: 1, copyAttemptedAt: ago(1) }, now)).toBe(true);
    expect(dueForCopy({ copyAttempts: 2, copyAttemptedAt: ago(3) }, now)).toBe(false);
    expect(dueForCopy({ copyAttempts: 4, copyAttemptedAt: ago(25) }, now)).toBe(true);
    expect(dueForCopy({ copyAttempts: MAX_COPY_ATTEMPTS, copyAttemptedAt: ago(1_000) }, now)).toBe(false);
  });
});

describe('choosing the link', () => {
  const inStorage = 'https://files.example.com/a?signed=1';
  const link = (over: Partial<Parameters<typeof sourceToCopy>[0]>) => ({
    url: inStorage,
    contentType: 'image/jpeg',
    downloadUrl: ORIGINAL,
    downloadContentType: 'image/jpeg',
    ...over,
  });

  it('keeps to the link that has copied thousands, under its type, and takes the other only when it must', () => {
    expect(sourceToCopy(link({ downloadContentType: 'image/heic' }))).toEqual({ address: inStorage, contentType: 'image/jpeg' });
    expect(sourceToCopy(link({ url: APP_LINK, downloadContentType: 'image/heic' }))).toEqual({ address: ORIGINAL, contentType: 'image/heic' });
    expect(sourceToCopy(link({ url: null, downloadContentType: 'image/heic' }))).toEqual({ address: ORIGINAL, contentType: 'image/heic' });
  });

  it("knows Jobber's web app by its host, in any case, and nothing else by it", () => {
    expect(() => sourceToCopy(link({ url: 'https://SECURE.getjobber.com/a', downloadUrl: null }))).toThrow(APP_LINK_PROBLEM);
    const lookalike = 'https://files.example.com/secure.getjobber.com/a';
    expect(sourceToCopy(link({ url: lookalike, downloadUrl: null })).address).toBe(lookalike);
  });

  it('tries again later when Jobber gave no link at all', () => {
    expect(() => sourceToCopy(link({ url: null, downloadUrl: null }))).toThrow(expect.objectContaining({ final: false }));
  });

  it('leaves an address that is not one for the download to refuse', () => {
    expect(sourceToCopy(link({ url: 'not a url' })).address).toBe('not a url');
  });
});

describe('downloading a file', () => {
  it('goes only to an HTTPS address with a name, never this machine', () => {
    expect(downloadAddress('https://files.example.com/a?x=1').hostname).toBe('files.example.com');
    for (const address of ['http://files.example.com/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://localhost/a', 'https://metadata.internal/a', 'not a url'])
      expect(() => downloadAddress(address)).toThrow(FileCopyError);
  });

  it('never takes more than the cap, whether the size is announced or not', async () => {
    const announced = async () => new Response(new Uint8Array(10), { status: 200, headers: { 'content-length': '10' } });
    await expect(downloadFile('https://files.example.com/a', 5, announced as never)).rejects.toMatchObject({ final: true });
    const unannounced = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(4));
            controller.enqueue(new Uint8Array(4));
            controller.close();
          },
        }),
        { status: 200 },
      );
    await expect(downloadFile('https://files.example.com/a', 5, unannounced as never)).rejects.toMatchObject({ final: true });
    expect(await downloadFile('https://files.example.com/a', 8, unannounced as never)).toHaveLength(8);
  });

  it('gives up on one that takes too long, to try again later', async () => {
    const slow = (_url: unknown, init: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    await expect(downloadFile('https://files.example.com/a', 5, slow as never, 10)).rejects.toMatchObject({
      message: 'The download took too long.',
      final: false,
    });
  });
});

describe('opening a file', () => {
  function service(row: Record<string, unknown> | null, signed: string | null = 'https://storage.example.com/signed') {
    const db = { invoiceFile: { findFirst: jest.fn().mockResolvedValue(row) } };
    const storage = { signedUrl: jest.fn().mockResolvedValue(signed) };
    return { db, storage, files: new InvoiceFilesService(db as never, storage as never) };
  }

  it("opens the console's copy through a five-minute link, under the file's own name", async () => {
    const { db, storage, files } = service({ fileName: 'Before photo.jpg', storageKey: 'invoice-files/x', jobberUrl: 'https://files.example.com/a' });
    expect(await files.link(office, INVOICE, FILE)).toEqual({ url: 'https://storage.example.com/signed', kept: true });
    expect(storage.signedUrl).toHaveBeenCalledWith('invoice-files/x', 300, inlineDisposition('Before photo.jpg'));
    expect(db.invoiceFile.findFirst.mock.calls[0][0].where).toEqual({ id: FILE, invoiceId: INVOICE, organizationId: ORG });
    expect(inlineDisposition('Café "1".pdf')).toBe(`inline; filename="Caf_ _1_.pdf"; filename*=UTF-8''Caf%C3%A9%20%221%22.pdf`);
  });

  it("opens Jobber's link until the copy is kept, and says plainly when there is neither", async () => {
    expect(await service({ fileName: 'a.pdf', storageKey: null, jobberUrl: 'https://files.example.com/a' }).files.link(office, INVOICE, FILE)).toEqual({
      url: 'https://files.example.com/a',
      kept: false,
    });
    await expect(service({ fileName: 'a.pdf', storageKey: null, jobberUrl: null }).files.link(office, INVOICE, FILE)).rejects.toMatchObject({
      code: 'INVOICE_FILE_UNAVAILABLE',
    });
    await expect(service(null).files.link(office, INVOICE, FILE)).rejects.toMatchObject({ code: 'INVOICE_FILE_NOT_FOUND' });
  });
});

describe('the copies before the cutover', () => {
  it('are counted, with why the failed ones failed, and tried again only when asked, on the record', async () => {
    const db = {
      invoiceFile: {
        count: jest.fn().mockResolvedValueOnce(120).mockResolvedValueOnce(100).mockResolvedValueOnce(4),
        groupBy: jest.fn().mockResolvedValue([
          { copyProblem: 'Jobber no longer has this file.', _count: { _all: 1 } },
          { copyProblem: "Jobber's storage answered 403.", _count: { _all: 3 } },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 4 }),
      },
      auditLog: { create: jest.fn() },
    };
    expect(await fileCopyStatus(db as never, ORG)).toEqual({
      total: 120,
      kept: 100,
      failed: 4,
      waiting: 16,
      problems: [
        { problem: "Jobber's storage answered 403.", files: 3 },
        { problem: 'Jobber no longer has this file.', files: 1 },
      ],
    });

    db.invoiceFile.count.mockResolvedValue(0);
    await new InvoiceFilesService(db as never, {} as never).retryFailed(office);
    expect(db.invoiceFile.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, storageKey: null, copyAttempts: { gte: MAX_COPY_ATTEMPTS } },
      data: { copyAttempts: 0, copyAttemptedAt: null, copyProblem: null },
    });
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'INVOICE_FILE_COPIES_RETRIED', metadata: { files: 4 } });
  });

  it('are opened by whoever reads invoices, and tried again by whoever makes them', () => {
    const permissions = (method: keyof InvoiceFilesController) =>
      Reflect.getMetadata('permissions', (InvoiceFilesController.prototype as unknown as Record<string, object>)[method]!);
    expect(permissions('link')).toEqual(['invoices:read']);
    expect(permissions('retry')).toEqual(['invoices:read', 'invoices:manage']);
  });
});
