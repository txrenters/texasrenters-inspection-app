import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobberConnectionStatus, type JobberRecordKind } from '@prisma/client';
import { z } from 'zod';

import { businessDayBounds } from '../../common/business-day';
import { ceilingFrom } from '../../common/daily-allowance';
import { InvoiceFileStorageService } from '../../common/invoice-file-storage.service';
import { PrismaService } from '../../common/prisma.service';
import { MIRROR_KINDS, mirrorFilesQuery, mirrorKind } from '../../integrations/jobber/jobber-mirror.kinds';
import { JobberClient } from '../../integrations/jobber/jobber.client';
import {
  downloadFile,
  dueForCopy,
  FileCopyError,
  MAX_COPY_ATTEMPTS,
  sourceToCopy,
} from './jobber-invoice-files.worker';

/** Records whose attachments are listed in a run, files copied, and how long it may take. */
const RECORDS_PER_RUN = 5;
const FILES_PER_RUN = 15;
const RUN_BUDGET_MS = 60_000;
export const DEFAULT_MIRROR_FILE_CEILING = 2_000;

export const mirrorFileKey = (organizationId: string, recordId: string, fileId: string) =>
  `jobber-mirror/${organizationId}/${recordId}/${fileId}`;

const attachmentSchema = z.object({
  id: z.string(),
  fileName: z.string().nullish(),
  contentType: z.string().nullish(),
  fileSize: z.number().nullish(),
  url: z.string().nullish(),
  downloadUrl: z.string().nullish(),
  downloadContentType: z.string().nullish(),
});
type Attachment = z.infer<typeof attachmentSchema>;

export interface MirrorFileResult {
  listed: number;
  copied: number;
  failed: number;
  skipped: 'NOT_CONNECTED' | 'CEILING' | null;
}

const FILE_KINDS = MIRROR_KINDS.filter((k) => k.hasFiles).map((k) => k.kind);

/**
 * Copies note attachments on mirrored records into our own storage
 * (2026-11-24), a few records a run, after the records themselves.
 *
 * Jobber's links are short-lived and die with the account, so they are asked
 * for at the moment of copying and never kept. Downloading reuses the invoice
 * file copy's guarded `downloadFile` (HTTPS only, size-capped, timed out).
 */
@Injectable()
export class JobberMirrorFileWorker {
  private readonly logger = new Logger(JobberMirrorFileWorker.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobberClient) private readonly client: JobberClient,
    @Inject(InvoiceFileStorageService) private readonly storage: InvoiceFileStorageService,
  ) {}

  async run(organizationId: string, clock: () => number = Date.now): Promise<MirrorFileResult> {
    const result: MirrorFileResult = { listed: 0, copied: 0, failed: 0, skipped: null };
    const connection = await this.prisma.jobberConnection.findUnique({ where: { organizationId }, select: { status: true } });
    if (connection?.status !== JobberConnectionStatus.CONNECTED) return { ...result, skipped: 'NOT_CONNECTED' };

    const started = clock();
    const ceiling = ceilingFrom('JOBBER_MIRROR_FILE_DAILY_CEILING', DEFAULT_MIRROR_FILE_CEILING);
    const triedToday = await this.prisma.jobberRecordFile.count({
      where: { organizationId, copyAttemptedAt: { gte: businessDayBounds(new Date(started)).start } },
    });
    if (triedToday >= ceiling) return { ...result, skipped: 'CEILING' };
    let allowance = Math.min(ceiling - triedToday, FILES_PER_RUN);

    for (const record of await this.recordsToVisit(organizationId)) {
      if (allowance <= 0 || clock() - started >= RUN_BUDGET_MS) break;
      const attachments = await this.list(organizationId, record);
      result.listed += 1;
      const pending = await this.prisma.jobberRecordFile.findMany({
        where: { organizationId, recordId: record.id, storageKey: null, copyAttempts: { lt: MAX_COPY_ATTEMPTS } },
        select: { id: true, recordId: true, jobberFileId: true, contentType: true, copyAttempts: true, copyAttemptedAt: true },
      });
      for (const file of pending) {
        if (allowance <= 0 || clock() - started >= RUN_BUDGET_MS) break;
        if (!dueForCopy(file, clock())) continue;
        allowance -= 1;
        if (await this.copy(organizationId, file, attachments)) result.copied += 1;
        else result.failed += 1;
      }
    }
    return result;
  }

  /** Records with attachments never listed or changed since, then records with a file due another try. */
  private async recordsToVisit(organizationId: string) {
    const select = { id: true, kind: true, jobberId: true } as const;
    const unlisted = await this.prisma.jobberRecord.findMany({
      where: {
        organizationId,
        kind: { in: FILE_KINDS },
        deletedInJobberAt: null,
        fileCount: { gt: 0 },
        OR: [{ filesListedAt: null }, { filesListedAt: { lt: this.prisma.jobberRecord.fields.jobberUpdatedAt } }],
      },
      select,
      take: RECORDS_PER_RUN,
    });
    if (unlisted.length >= RECORDS_PER_RUN) return unlisted;
    const retrying = await this.prisma.jobberRecord.findMany({
      where: {
        organizationId,
        id: { notIn: unlisted.map((r) => r.id) },
        files: { some: { storageKey: null, copyAttempts: { gt: 0, lt: MAX_COPY_ATTEMPTS } } },
      },
      select,
      take: RECORDS_PER_RUN - unlisted.length,
    });
    return [...unlisted, ...retrying];
  }

  /** The record's attachments as Jobber has them now, recorded; null when Jobber no longer has the record. */
  private async list(organizationId: string, record: { id: string; kind: JobberRecordKind; jobberId: string }) {
    const spec = mirrorKind(record.kind);
    const data = await this.client.request<Record<string, { noteAttachments: { nodes: unknown[] } } | null>>(
      organizationId,
      mirrorFilesQuery(spec),
      { id: record.jobberId },
    );
    const parent = data[spec.single!];
    if (!parent) return null;
    const attachments = parent.noteAttachments.nodes.map((node) => attachmentSchema.parse(node));
    for (const a of attachments) {
      const meta = { fileName: a.fileName ?? null, contentType: a.contentType ?? null, sizeBytes: a.fileSize ?? null };
      await this.prisma.jobberRecordFile.upsert({
        where: { organizationId_jobberFileId: { organizationId, jobberFileId: a.id } },
        create: { organizationId, recordId: record.id, jobberFileId: a.id, ...meta },
        update: meta,
      });
    }
    await this.prisma.jobberRecord.update({ where: { id: record.id }, data: { filesListedAt: new Date() } });
    return new Map(attachments.map((a) => [a.id, a]));
  }

  /** One file: counted as tried before anything is downloaded, kept once stored. */
  private async copy(
    organizationId: string,
    file: { id: string; recordId: string; jobberFileId: string; contentType: string | null; copyAttempts: number },
    attachments: Map<string, Attachment> | null,
  ) {
    const claimed = await this.prisma.jobberRecordFile.updateMany({
      where: { id: file.id, organizationId, storageKey: null, copyAttempts: file.copyAttempts },
      data: { copyAttempts: { increment: 1 }, copyAttemptedAt: new Date() },
    });
    if (claimed.count !== 1) return false;
    try {
      if (!attachments) throw new FileCopyError('Jobber no longer has this record.', true);
      const link = attachments.get(file.jobberFileId);
      if (!link) throw new FileCopyError('Jobber no longer has this file.', true);
      const source = sourceToCopy({
        url: link.url ?? null,
        contentType: link.contentType ?? null,
        downloadUrl: link.downloadUrl ?? null,
        downloadContentType: link.downloadContentType ?? null,
      });
      const bytes = await downloadFile(source.address);
      const storageKey = mirrorFileKey(organizationId, file.recordId, file.id);
      await this.storage.put(storageKey, bytes, source.contentType || file.contentType || 'application/octet-stream');
      await this.prisma.jobberRecordFile.update({
        where: { id: file.id },
        data: { storageKey, copiedAt: new Date(), copyProblem: null },
      });
      return true;
    } catch (error) {
      const problem = error instanceof FileCopyError ? error.message : 'The file could not be stored.';
      await this.prisma.jobberRecordFile.update({
        where: { id: file.id },
        data: {
          copyProblem: problem,
          ...(error instanceof FileCopyError && error.final ? { copyAttempts: MAX_COPY_ATTEMPTS } : {}),
        },
      });
      this.logger.warn({ event: 'jobber_mirror_file_not_copied', organizationId, fileId: file.id, problem });
      return false;
    }
  }
}
