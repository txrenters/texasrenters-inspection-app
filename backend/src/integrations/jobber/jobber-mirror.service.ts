import { Inject, Injectable } from '@nestjs/common';
import { JobberRecordKind } from '@prisma/client';

import type { AuthenticatedUser } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { MAX_COPY_ATTEMPTS } from '../../workers/jobber-sync/jobber-invoice-files.worker';
import { MIRROR_KINDS } from './jobber-mirror.kinds';

export interface MirrorKindStatus {
  kind: JobberRecordKind;
  records: number;
  deleted: number;
  extractFailed: number;
  /** Records whose notes, lines or attachments Jobber has more of than were copied. */
  truncated: number;
  filesStored: number;
  filesPending: number;
  filesFailed: number;
  walkCompletedAt: Date | null;
  walkInProgress: boolean;
  /** The last walk saw too few records to trust; nothing was marked deleted. */
  walkShortAt: Date | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

/**
 * How complete the Jobber copy is (2026-11-24): what the office checks before
 * the Jobber account is closed. Counts and error codes only, never payloads.
 */
@Injectable()
export class JobberMirrorService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async status(user: AuthenticatedUser): Promise<{ kinds: MirrorKindStatus[] }> {
    const organizationId = user.organizationId;
    const count = (rows: { kind: JobberRecordKind; _count: { _all: number } }[]) =>
      new Map(rows.map((row) => [row.kind, row._count._all]));
    const [live, deleted, unreadable, cut, files, cursors] = await Promise.all([
      this.prisma.jobberRecord.groupBy({ by: ['kind'], where: { organizationId, deletedInJobberAt: null }, _count: { _all: true } }),
      this.prisma.jobberRecord.groupBy({ by: ['kind'], where: { organizationId, deletedInJobberAt: { not: null } }, _count: { _all: true } }),
      this.prisma.jobberRecord.groupBy({ by: ['kind'], where: { organizationId, extractFailed: true }, _count: { _all: true } }),
      this.prisma.jobberRecord.groupBy({
        by: ['kind'],
        where: { organizationId, OR: [{ truncated: true }, { filesTruncated: true }] },
        _count: { _all: true },
      }),
      this.prisma.jobberRecordFile.findMany({
        where: { organizationId },
        select: { storageKey: true, copyAttempts: true, record: { select: { kind: true } } },
      }),
      this.prisma.jobberMirrorCursor.findMany({ where: { organizationId } }),
    ]);
    const [liveBy, deletedBy, unreadableBy, cutBy] = [
      count(live as never),
      count(deleted as never),
      count(unreadable as never),
      count(cut as never),
    ];

    return {
      kinds: MIRROR_KINDS.map(({ kind }) => {
        const mine = files.filter((f) => f.record.kind === kind);
        const cursor = cursors.find((c) => c.kind === kind);
        return {
          kind,
          records: liveBy.get(kind) ?? 0,
          deleted: deletedBy.get(kind) ?? 0,
          extractFailed: unreadableBy.get(kind) ?? 0,
          truncated: cutBy.get(kind) ?? 0,
          filesStored: mine.filter((f) => f.storageKey).length,
          filesPending: mine.filter((f) => !f.storageKey && f.copyAttempts < MAX_COPY_ATTEMPTS).length,
          filesFailed: mine.filter((f) => !f.storageKey && f.copyAttempts >= MAX_COPY_ATTEMPTS).length,
          walkCompletedAt: cursor?.walkCompletedAt ?? null,
          walkInProgress: Boolean(cursor?.walkCursor),
          walkShortAt: cursor?.walkShortAt ?? null,
          lastCheckedAt: cursor?.lastCheckedAt ?? null,
          lastError: cursor?.lastError ?? null,
          lastErrorAt: cursor?.lastErrorAt ?? null,
        };
      }),
    };
  }

  /** VISIT_DESTROY: the copy keeps the visit, marked gone. */
  async markVisitDeleted(organizationId: string, jobberVisitId: string) {
    await this.prisma.jobberRecord.updateMany({
      where: { organizationId, kind: JobberRecordKind.VISIT, jobberId: jobberVisitId, deletedInJobberAt: null },
      data: { deletedInJobberAt: new Date() },
    });
  }
}
