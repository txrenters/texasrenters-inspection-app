import type { JobberRecordKind, Prisma, PrismaClient } from '@prisma/client';

import { summarize, type RecordSummary } from './jobber-mirror.kinds';

export type MirrorNode = Record<string, unknown> & { id: string };

type Db = Pick<PrismaClient, '$transaction' | 'jobberRecord' | 'jobberMirrorCursor'>;

const EMPTY: RecordSummary = {
  number: null,
  title: null,
  clientJobberId: null,
  propertyJobberId: null,
  jobJobberId: null,
  address: null,
  occursAt: null,
  status: null,
  jobberCreatedAt: null,
  jobberUpdatedAt: null,
  fileCount: 0,
};

/** A walk that saw fewer than this share of the live rows marks nothing deleted. */
const SHORT_WALK_RATIO = 0.5;

/**
 * One page of mirrored records and the cursor that follows it, in one
 * transaction (2026-11-24): a run cut off after this returns resumes after
 * this page, never before or past it.
 *
 * Upserted on organization, kind and Jobber id, so a page read twice -- a
 * resumed walk, a "what changed" overlapping the walk -- leaves one row. A
 * record seen again is no longer deleted: Jobber restored it.
 */
export async function saveMirrorPage(
  prisma: Db,
  organizationId: string,
  kind: JobberRecordKind,
  nodes: MirrorNode[],
  seenAt: Date,
  cursor: Omit<Prisma.JobberMirrorCursorUncheckedCreateInput, 'organizationId' | 'kind'>,
) {
  let extractFailed = 0;
  await prisma.$transaction(async (tx) => {
    for (const node of nodes) {
      let summary = EMPTY;
      let failed = false;
      try {
        summary = summarize(kind, node);
      } catch {
        failed = true;
        extractFailed += 1;
      }
      const data = {
        ...summary,
        payload: node as Prisma.InputJsonValue,
        extractFailed: failed,
        lastSeenAt: seenAt,
        deletedInJobberAt: null,
      };
      await tx.jobberRecord.upsert({
        where: { organizationId_kind_jobberId: { organizationId, kind, jobberId: node.id } },
        create: { organizationId, kind, jobberId: node.id, ...data },
        update: data,
      });
    }
    await tx.jobberMirrorCursor.upsert({
      where: { organizationId_kind: { organizationId, kind } },
      create: { organizationId, kind, ...cursor },
      update: cursor,
    });
  });
  return { saved: nodes.length, extractFailed };
}

/**
 * After a full walk: what it did not see is gone from Jobber (2026-11-24).
 * Marked, never erased.
 *
 * Unless the walk saw under half of what is live. Records do not vanish by the
 * hundred; a permission change in Jobber hiding them does, and marking them
 * would empty the copy the day it is needed.
 */
export async function markUnseenDeleted(
  prisma: Db,
  organizationId: string,
  kind: JobberRecordKind,
  walkStartedAt: Date,
  walkSeen: number,
) {
  return prisma.$transaction(async (tx) => {
    const live = await tx.jobberRecord.count({ where: { organizationId, kind, deletedInJobberAt: null } });
    if (live > 0 && walkSeen < live * SHORT_WALK_RATIO) return { deleted: 0, short: true };
    const marked = await tx.jobberRecord.updateMany({
      where: { organizationId, kind, deletedInJobberAt: null, lastSeenAt: { lt: walkStartedAt } },
      data: { deletedInJobberAt: new Date() },
    });
    return { deleted: marked.count, short: false };
  });
}
