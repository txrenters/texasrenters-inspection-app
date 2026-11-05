import { Inject, Injectable } from '@nestjs/common';
import type { InvoiceFileCopyStatus, InvoiceFileLink } from '@texasrenters/shared';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { InvoiceFileStorageService, inlineDisposition } from '../common/invoice-file-storage.service';
import { PrismaService } from '../common/prisma.service';
import { MAX_COPY_ATTEMPTS } from '../workers/jobber-sync/jobber-invoice-files.worker';

/** How long a link to a file lasts: long enough to open, too short to pass around. */
const LINK_SECONDS = 300;
/** The reasons the copy status lists, at most. */
const MAX_PROBLEMS = 5;

/** How many of the office's files the console keeps its own copy of, and why the rest are not. */
export async function fileCopyStatus(db: Prisma.TransactionClient, organizationId: string): Promise<InvoiceFileCopyStatus> {
  const failedWhere: Prisma.InvoiceFileWhereInput = { organizationId, storageKey: null, copyAttempts: { gte: MAX_COPY_ATTEMPTS } };
  const [total, kept, failed, problems] = await Promise.all([
    db.invoiceFile.count({ where: { organizationId } }),
    db.invoiceFile.count({ where: { organizationId, storageKey: { not: null } } }),
    db.invoiceFile.count({ where: failedWhere }),
    db.invoiceFile.groupBy({
      by: ['copyProblem'],
      where: { ...failedWhere, copyProblem: { not: null } },
      _count: { _all: true },
    }),
  ]);
  return {
    total,
    kept,
    failed,
    waiting: total - kept - failed,
    problems: problems
      .map((row) => ({ problem: row.copyProblem!, files: row._count._all }))
      .sort((a, b) => b.files - a.files)
      .slice(0, MAX_PROBLEMS),
  };
}

/**
 * The files on Jobber's invoices, as the console opens them (2026-11-06,
 * phase 7): its own copy once kept, through a short-lived signed link, else
 * Jobber's own link until then. Signing a link is worked out here, not asked
 * of the provider, and the file is fetched only when somebody opens it.
 */
@Injectable()
export class InvoiceFilesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InvoiceFileStorageService) private readonly storage: InvoiceFileStorageService,
  ) {}

  async link(user: AuthenticatedUser, invoiceId: string, fileId: string): Promise<InvoiceFileLink> {
    const file = await this.prisma.invoiceFile.findFirst({
      where: { id: fileId, invoiceId, organizationId: user.organizationId },
      select: { fileName: true, storageKey: true, jobberUrl: true },
    });
    if (!file) throw new ApplicationError(404, 'INVOICE_FILE_NOT_FOUND', 'That file was not found.');
    if (file.storageKey) {
      const url = await this.storage.signedUrl(file.storageKey, LINK_SECONDS, inlineDisposition(file.fileName));
      if (url) return { url, kept: true };
    }
    if (file.jobberUrl) return { url: file.jobberUrl, kept: false };
    throw new ApplicationError(
      404,
      'INVOICE_FILE_UNAVAILABLE',
      'This file has not been copied from Jobber yet, and Jobber gave no link to it. Open it in Jobber.',
    );
  }

  /** The files that were tried too often, tried again from the next run on (the office's choice, on the record). */
  async retryFailed(user: AuthenticatedUser): Promise<InvoiceFileCopyStatus> {
    const { count } = await this.prisma.invoiceFile.updateMany({
      where: { organizationId: user.organizationId, storageKey: null, copyAttempts: { gte: MAX_COPY_ATTEMPTS } },
      data: { copyAttempts: 0, copyAttemptedAt: null, copyProblem: null },
    });
    if (count)
      await this.prisma.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'INVOICE_FILE_COPIES_RETRIED',
          entityType: 'InvoiceSettings',
          entityId: user.organizationId,
          metadata: { files: count },
        },
      });
    return fileCopyStatus(this.prisma, user.organizationId);
  }
}
