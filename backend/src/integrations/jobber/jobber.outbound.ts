import { InspectionSource, JobberOutboundKind, Prisma } from '@prisma/client';

import type { PrismaService } from '../../common/prisma.service';

/** Declared here rather than imported from admin/ so the dependency runs one
 * way: admin reaches into the integration, never the reverse. */
type JobberOutboundClient = Prisma.TransactionClient | PrismaService;

/**
 * Records that Jobber is owed a completion for this inspection.
 *
 * Called inside the finalization transaction, which is the point of the whole
 * design: "this inspection is finalized" and "Jobber will be told" commit
 * together or not at all. A call to Jobber here instead would make sign-off
 * fail on a network error, after `finalizedAt` has already frozen the evidence.
 *
 * A no-op for anything this app scheduled itself — there is no Jobber visit to
 * complete — so callers do not have to know where an inspection came from.
 */
export async function enqueueJobberCompletion(
  tx: JobberOutboundClient,
  input: { organizationId: string; inspectionId: string; finalizedById: string | null },
) {
  const inspection = await tx.inspection.findFirst({
    where: { id: input.inspectionId, organizationId: input.organizationId },
    select: { source: true, jobberVisitId: true, jobberJobId: true },
  });
  if (inspection?.source !== InspectionSource.JOBBER || !inspection.jobberVisitId) return null;

  try {
    return await tx.jobberOutboundTask.create({
      data: {
        organizationId: input.organizationId,
        inspectionId: input.inspectionId,
        jobberVisitId: inspection.jobberVisitId,
        jobberJobId: inspection.jobberJobId,
        kind: JobberOutboundKind.VISIT_COMPLETED,
        createdById: input.finalizedById,
      },
    });
  } catch (error) {
    // Already queued — a re-finalize, or a retry of the same sign-off. The
    // unique constraint is the deduplication rather than a read-then-write,
    // which two concurrent finalizations could both pass.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
    throw error;
  }
}
