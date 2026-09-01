import {
  InspectionSource,
  JobberOutboundKind,
  JobberOutboundStatus,
  Prisma,
} from '@prisma/client';

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
  input: { organizationId: string; inspectionId: string; reportOwnerId: string | null },
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
        createdById: input.reportOwnerId,
      },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    /**
     * Already queued — normally by the technician's submission, which happens
     * first and is the event Jobber actually cares about.
     *
     * The unique constraint is the deduplication rather than a read-then-write,
     * which two concurrent callers could both pass. But the later call may know
     * something the first did not: a report share needs an owner, and the
     * technician who submitted is not the person signing the report off. So the
     * finalizer is recorded if the push has not gone yet.
     *
     * If it has already gone, nothing is corrected and no report link is sent.
     * That is the accepted cost of telling Jobber early: the visit status is
     * what stops technicians logging in, and it is worth more than the note.
     */
    if (input.reportOwnerId)
      await tx.jobberOutboundTask.updateMany({
        where: {
          organizationId: input.organizationId,
          inspectionId: input.inspectionId,
          kind: JobberOutboundKind.VISIT_COMPLETED,
          createdById: null,
          status: { in: [JobberOutboundStatus.PENDING, JobberOutboundStatus.FAILED] },
        },
        data: { createdById: input.reportOwnerId },
      });
    return null;
  }
}
