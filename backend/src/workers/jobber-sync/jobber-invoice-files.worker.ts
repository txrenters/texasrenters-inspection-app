import { isIP } from 'node:net';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { businessDayBounds } from '../../common/business-day';
import { ceilingFrom } from '../../common/daily-allowance';
import { InvoiceFileStorageService, invoiceFileKey } from '../../common/invoice-file-storage.service';
import { PrismaService } from '../../common/prisma.service';
import { JobberClient } from '../../integrations/jobber/jobber.client';
import { JobberError } from '../../integrations/jobber/jobber.errors';
import { INVOICE_FILES_QUERY } from '../../integrations/jobber/jobber.queries';
import { jobberInvoiceFilesSchema } from '../../integrations/jobber/jobber.schemas';

/**
 * Copies the files on Jobber's invoices into the console's own storage
 * (2026-11-06, phase 7 of taking invoicing over from Jobber). Jobber's links
 * stop working when the office leaves it; every file must be kept first.
 *
 * Each copy is one write to the storage provider, which is billed, so:
 * - a file is copied once: a kept copy (`storageKey`) is never made again, and
 *   a re-read of Jobber never clears it;
 * - a run takes `FILES_PER_RUN` files at most, within `RUN_BUDGET_MS`, after
 *   the invoices are read;
 * - the office tries `INVOICE_FILE_COPY_DAILY_CEILING` (2,000) files a Texas
 *   day at most, counted from the attempts on record, so a restart does not
 *   reset it; 0 turns the copying off;
 * - a file that fails is tried again later, waiting longer each time, and
 *   after `MAX_COPY_ATTEMPTS` only when the office asks.
 *
 * Jobber's own links are not kept to download from: they are asked for again,
 * one small query per invoice, right before its files are copied. Jobber's
 * API is not billed; it is paced like the invoice read.
 *
 * An iPhone photo's `url` is not the file: it is a JPEG conversion on Jobber's
 * web app, which answers the console 403, with its API token too. Its
 * `downloadUrl` is the HEIC original in Jobber's storage, so that is what is
 * kept, under its own type. A file with no link in storage stops at once rather
 * than spending five tries.
 */

const FILES_PER_RUN = 25;
const RUN_BUDGET_MS = 90_000;
export const DEFAULT_FILE_COPY_CEILING = 2_000;
export const MAX_COPY_ATTEMPTS = 5;
/** Larger ones are downloaded from Jobber by hand. */
export const MAX_INVOICE_FILE_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** How long after each failed try the next one waits: 1, 4, 12 and 24 hours. */
const RETRY_AFTER_MS = [1, 4, 12, 24].map((hours) => hours * 3_600_000);
/** Files read to choose a run's from, so the ones waiting out a retry do not crowd out the rest. */
const CANDIDATES = 300;
/** Jobber's web app: on 2026-11-06 all 286 files linked here answered 403, and every file copied came from storage. */
const JOBBER_APP_HOST = 'secure.getjobber.com';
export const APP_LINK_PROBLEM = "This file's links go to Jobber's web app; download it from Jobber by hand.";

export interface InvoiceFileCopyResult {
  copied: number;
  failed: number;
  skipped: 'OFF' | 'NOT_CONFIGURED' | 'CEILING' | 'NOTHING' | null;
}

/** A file's addresses and types as Jobber gave them just now. */
interface FreshLink {
  url: string | null;
  contentType: string | null;
  downloadUrl: string | null;
  downloadContentType: string | null;
}

/** Why a copy did not happen; `final` when trying again cannot help. */
export class FileCopyError extends Error {
  constructor(
    message: string,
    readonly final = false,
  ) {
    super(message);
  }
}

/** An address the console downloads from: HTTPS, to a name rather than a bare address, never this machine. */
export function downloadAddress(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FileCopyError('Jobber gave an address that is not one.', true);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:') throw new FileCopyError('Jobber gave an address that is not HTTPS.', true);
  if (isIP(host) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    throw new FileCopyError('Jobber gave an address the console does not download from.', true);
  return url;
}

function onJobberApp(address: string) {
  return URL.canParse(address) && new URL(address).hostname === JOBBER_APP_HOST;
}

/** Where to download a file from, and its type: `url`, which copied thousands, unless that is on Jobber's web app. */
export function sourceToCopy(link: FreshLink) {
  if (link.url && !onJobberApp(link.url)) return { address: link.url, contentType: link.contentType };
  if (link.downloadUrl && !onJobberApp(link.downloadUrl))
    return { address: link.downloadUrl, contentType: link.downloadContentType ?? link.contentType };
  if (link.url || link.downloadUrl) throw new FileCopyError(APP_LINK_PROBLEM, true);
  throw new FileCopyError('Jobber gave no address for this file.');
}

/** The file's bytes, never more than `maxBytes`, within the time allowed. */
export async function downloadFile(
  address: string,
  maxBytes = MAX_INVOICE_FILE_BYTES,
  fetcher: typeof fetch = fetch,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
): Promise<Buffer> {
  const url = downloadAddress(address);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const tooLarge = () => new FileCopyError(`Larger than ${maxBytes / 1024 / 1024} MB; download it from Jobber by hand.`, true);
  try {
    const response = await fetcher(url, { redirect: 'follow', signal: controller.signal });
    if (response.url && !response.url.startsWith('https:'))
      throw new FileCopyError('Jobber sent the file from an address that is not HTTPS.', true);
    if (!response.ok) throw new FileCopyError(`Jobber's storage answered ${response.status}.`);
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) throw tooLarge();
    if (!response.body) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        controller.abort();
        throw tooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof FileCopyError) throw error;
    if (controller.signal.aborted) throw new FileCopyError('The download took too long.');
    throw new FileCopyError('The download did not finish.');
  } finally {
    clearTimeout(timer);
  }
}

/** Whether a file that failed `attempts` times, last at `attemptedAt`, is due another try. */
export function dueForCopy(file: { copyAttempts: number; copyAttemptedAt: Date | null }, now: number) {
  if (file.copyAttempts >= MAX_COPY_ATTEMPTS) return false;
  if (!file.copyAttempts || !file.copyAttemptedAt) return true;
  const wait = RETRY_AFTER_MS[Math.min(file.copyAttempts, RETRY_AFTER_MS.length) - 1]!;
  return now - file.copyAttemptedAt.getTime() >= wait;
}

@Injectable()
export class JobberInvoiceFileWorker {
  private readonly logger = new Logger(JobberInvoiceFileWorker.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobberClient) private readonly client: JobberClient,
    @Inject(InvoiceFileStorageService) private readonly storage: InvoiceFileStorageService,
  ) {}

  /** One bounded run over the files still to copy. */
  async run(organizationId: string, clock: () => number = Date.now): Promise<InvoiceFileCopyResult> {
    const result: InvoiceFileCopyResult = { copied: 0, failed: 0, skipped: null };
    const ceiling = ceilingFrom('INVOICE_FILE_COPY_DAILY_CEILING', DEFAULT_FILE_COPY_CEILING);
    if (ceiling === 0) return { ...result, skipped: 'OFF' };
    // On the container's own disk a copy would be gone on the next deploy, and the file thought kept.
    if (!this.storage.durable()) return { ...result, skipped: 'NOT_CONFIGURED' };

    const started = clock();
    const triedToday = await this.prisma.invoiceFile.count({
      where: { organizationId, copyAttemptedAt: { gte: businessDayBounds(new Date(started)).start } },
    });
    const room = Math.min(FILES_PER_RUN, ceiling - triedToday);
    if (room <= 0) return { ...result, skipped: 'CEILING' };

    const candidates = await this.prisma.invoiceFile.findMany({
      where: { organizationId, storageKey: null, copyAttempts: { lt: MAX_COPY_ATTEMPTS } },
      // Never tried first, then the longest waiting; the newest invoices' files before the oldest.
      orderBy: [{ copyAttemptedAt: { sort: 'asc', nulls: 'first' } }, { uploadedAt: 'desc' }],
      take: CANDIDATES,
      select: {
        id: true,
        invoiceId: true,
        jobberFileId: true,
        contentType: true,
        copyAttempts: true,
        copyAttemptedAt: true,
        invoice: { select: { jobberInvoiceId: true } },
      },
    });
    const due = candidates.filter((file) => dueForCopy(file, started)).slice(0, room);
    if (!due.length) return { ...result, skipped: 'NOTHING' };

    const byInvoice = new Map<string, typeof due>();
    for (const file of due) byInvoice.set(file.invoiceId, [...(byInvoice.get(file.invoiceId) ?? []), file]);

    for (const [invoiceId, files] of byInvoice) {
      if (clock() - started > RUN_BUDGET_MS) break;
      const jobberInvoiceId = files[0]!.invoice.jobberInvoiceId;
      let fresh: Map<string, FreshLink> | null;
      try {
        fresh = jobberInvoiceId ? await this.freshLinks(organizationId, jobberInvoiceId) : null;
      } catch (error) {
        // Throttled, away, or the scope gone: nothing is tried, so nothing is counted; the next run carries on.
        this.logger.warn({
          event: 'invoice_file_links_unread',
          organizationId,
          invoiceId,
          code: error instanceof JobberError ? error.code : undefined,
        });
        break;
      }
      for (const file of files) {
        if (clock() - started > RUN_BUDGET_MS) break;
        const copied = await this.copy(organizationId, file, fresh);
        result[copied ? 'copied' : 'failed'] += 1;
      }
    }
    return result;
  }

  private async freshLinks(organizationId: string, jobberInvoiceId: string) {
    const data = await this.client.request(organizationId, INVOICE_FILES_QUERY, { id: jobberInvoiceId });
    const invoice = jobberInvoiceFilesSchema.parse(data).invoice;
    if (!invoice) return null;
    return new Map<string, FreshLink>(
      invoice.noteAttachments.nodes.map((node) => [
        node.id,
        {
          url: node.url ?? null,
          contentType: node.contentType ?? null,
          downloadUrl: node.downloadUrl ?? null,
          downloadContentType: node.downloadContentType ?? null,
        },
      ]),
    );
  }

  /** One file: counted as tried before anything is downloaded, kept once stored. */
  private async copy(
    organizationId: string,
    file: { id: string; invoiceId: string; jobberFileId: string; contentType: string; copyAttempts: number },
    fresh: Map<string, FreshLink> | null,
  ) {
    const attempt = await this.prisma.invoiceFile.updateMany({
      where: { id: file.id, organizationId, storageKey: null, copyAttempts: file.copyAttempts },
      data: { copyAttempts: { increment: 1 }, copyAttemptedAt: new Date() },
    });
    // Another run took it, or it was kept meanwhile.
    if (attempt.count !== 1) return false;
    try {
      if (!fresh) throw new FileCopyError('Jobber no longer has this invoice.', true);
      const link = fresh.get(file.jobberFileId);
      if (!link) throw new FileCopyError('Jobber no longer has this file.', true);
      const source = sourceToCopy(link);
      const bytes = await downloadFile(source.address);
      const storageKey = invoiceFileKey(organizationId, file.invoiceId, file.id);
      await this.storage.put(storageKey, bytes, source.contentType || file.contentType || 'application/octet-stream');
      await this.prisma.invoiceFile.update({
        where: { id: file.id },
        data: { storageKey, copiedAt: new Date(), copyProblem: null },
      });
      return true;
    } catch (error) {
      const problem = error instanceof FileCopyError ? error.message : 'The file could not be stored.';
      await this.prisma.invoiceFile.update({
        where: { id: file.id },
        data: {
          copyProblem: problem,
          // Trying again cannot help: no more tries until the office asks.
          ...(error instanceof FileCopyError && error.final ? { copyAttempts: MAX_COPY_ATTEMPTS } : {}),
        },
      });
      this.logger.warn({ event: 'invoice_file_not_copied', organizationId, fileId: file.id, problem });
      return false;
    }
  }
}
