import {
  InspectionStatus,
  JobberVisitImportStatus,
  LeaseInspectionOutcome,
  TbpStopStatus,
} from '@prisma/client';

import { businessDate } from '../../common/business-day';
import { eraseInspectionRows } from '../../common/erase-inspection';
import { jobInWords } from '../../common/job-in-words';
import type { PrismaService } from '../../common/prisma.service';

/**
 * Why Jobber no longer has a visit on a day:
 *
 * - `DELETED`: its webhook said so (VISIT_DESTROY).
 * - `MISSING`: two sweeps running asked Jobber for it by id and got nothing.
 *   A by-id lookup finds a visit wherever it is on the calendar, so a visit
 *   it cannot find is gone -- deleted, or with its job.
 * - `UNSCHEDULED`: Jobber returned it with no day; it still exists there.
 */
export type JobberRemovalReason = 'DELETED' | 'MISSING' | 'UNSCHEDULED';

/** On a visit's import row once its inspection was removed because Jobber deleted the visit. */
export const JOBBER_VISIT_DELETED = 'JOBBER_VISIT_DELETED';

/**
 * The reasons the sync used to *cancel* with, before it deleted (2026-10-07).
 * An inspection still cancelled with one of these is the sync's, not a
 * person's, and is removed the same way (`sweepJobberCancellations`).
 */
export const JOBBER_CANCELLATION_PREFIXES = [
  'Moved to Unscheduled in Jobber.',
  'No longer on Jobber’s schedule',
  'The Jobber visit this inspection came from was deleted.',
];

export function cancelledByJobberSync(reason: string | null | undefined) {
  return Boolean(reason && JOBBER_CANCELLATION_PREFIXES.some((prefix) => reason.startsWith(prefix)));
}

/** The reason a legacy Jobber cancellation stands for. */
export function legacyRemovalReason(reason: string | null | undefined): JobberRemovalReason {
  if (reason?.startsWith('Moved to Unscheduled in Jobber.')) return 'UNSCHEDULED';
  if (reason?.startsWith('The Jobber visit this inspection came from was deleted.')) return 'DELETED';
  return 'MISSING';
}

export type JobberRemovalOutcome =
  /** Deleted from the console. `notify` names the technician to tell, if any. */
  | { outcome: 'REMOVED'; notify: { technicianId: string; detail: string } | null }
  /** Work was recorded on it: a person has to decide. Nothing was removed. */
  | { outcome: 'IN_USE' }
  /** Cancelled by a person, with their reason: the office's record, kept. */
  | { outcome: 'KEPT_BY_OFFICE' }
  /** Not there any more, or not this visit's. */
  | { outcome: 'GONE' };

const IMPORT_ROW: Record<JobberRemovalReason, { status: JobberVisitImportStatus; code: string; message: string }> = {
  DELETED: {
    status: JobberVisitImportStatus.IGNORED,
    code: JOBBER_VISIT_DELETED,
    message: 'Deleted in Jobber, so its inspection was removed from the console.',
  },
  MISSING: {
    status: JobberVisitImportStatus.IGNORED,
    code: JOBBER_VISIT_DELETED,
    message: 'Jobber no longer has this visit, so its inspection was removed from the console.',
  },
  /**
   * Pending again: the visit still exists in Jobber, and when it is given a day
   * the sync imports it as it would any visit it has not met -- a new
   * inspection, and the plan's stop takes it back.
   */
  UNSCHEDULED: {
    status: JobberVisitImportStatus.PENDING,
    code: 'JOBBER_VISIT_UNSCHEDULED',
    message:
      'Moved to Unscheduled in Jobber, so its inspection was removed. A new one is made on the day Jobber gives it.',
  },
};

/**
 * Removes from the console an inspection whose Jobber visit was deleted or
 * taken off the calendar (the office, 2026-10-07: "if those are canceled or
 * deleted from the Jobber, then it should reflect also on our console ... so
 * that the mobile app will be freed on that schedules"). It used to be
 * cancelled and kept, technician and all -- and a cancelled visit with its
 * technician still on it kept turning up on the map, the dashboard, the
 * assignments page and the phone.
 *
 * Deleted outright, only while nothing was done on it: never started, no
 * recording, photograph or checklist answer. Work recorded is left for a
 * person (`IN_USE`). One cancelled by a person keeps their record
 * (`KEPT_BY_OFFICE`).
 *
 * What pointed at it is put right first, so nothing books it again:
 * - the lease schedule's row is recorded as cancelled, as a console cancel is
 *   -- otherwise its next run sees its booking gone and books the move-out
 *   again, re-creating in Jobber the visit the office deleted there;
 * - the plan's stop is excluded with the reason (deleted), or waits
 *   unscheduled for its visit's day (unscheduled), as a stop published with no
 *   day does;
 * - tracked time keeps its hours and its property, and loses the inspection.
 *
 * The technician's assignment goes with the inspection. Who to tell is handed
 * back rather than told from here: the caller publishes after the commit.
 */
export async function removeWithdrawnInspection(
  prisma: PrismaService,
  input: { organizationId: string; inspectionId: string; jobberVisitId: string; why: JobberRemovalReason },
): Promise<JobberRemovalOutcome> {
  const { organizationId, inspectionId, jobberVisitId, why } = input;
  const inspection = await prisma.inspection.findFirst({
    where: { id: inspectionId, organizationId },
    select: {
      id: true,
      status: true,
      startedAt: true,
      scheduledAt: true,
      jobberVisitId: true,
      cancellationReason: true,
      propertywareBuilding: { select: { name: true, addressLine1: true } },
      assignments: { where: { isCurrent: true }, select: { technicianId: true }, take: 1 },
    },
  });
  if (!inspection || inspection.jobberVisitId !== jobberVisitId) return { outcome: 'GONE' };
  if (inspection.status === InspectionStatus.CANCELLED && !cancelledByJobberSync(inspection.cancellationReason))
    return { outcome: 'KEPT_BY_OFFICE' };

  const [recordings, photos, answered] = await Promise.all([
    prisma.inspectionMedia.count({ where: { inspectionId } }),
    prisma.inspectionPhoto.count({ where: { inspectionId } }),
    prisma.inspectionAreaChecklistResponse.count({
      where: {
        inspectionArea: { inspectionId },
        OR: [
          { isClean: { not: null } },
          { isUndamaged: { not: null } },
          { isWorking: { not: null } },
          { textValue: { not: null } },
          { numericValue: { not: null } },
        ],
      },
    }),
  ]);
  const untouched =
    (inspection.status === InspectionStatus.SCHEDULED || inspection.status === InspectionStatus.CANCELLED) &&
    !inspection.startedAt &&
    !recordings &&
    !photos &&
    !answered;
  if (!untouched) return { outcome: 'IN_USE' };

  const property = inspection.propertywareBuilding?.addressLine1 || inspection.propertywareBuilding?.name || null;
  const removed = await prisma.$transaction(async (tx) => {
    /**
     * Claimed first, under the row's lock: a technician pressing Start between
     * the read above and this would otherwise have the job deleted under them.
     * Their start waits for this to commit, then finds nothing to start.
     */
    const { count } = await tx.inspection.updateMany({
      where: {
        id: inspectionId,
        organizationId,
        startedAt: null,
        status: { in: [InspectionStatus.SCHEDULED, InspectionStatus.CANCELLED] },
      },
      data: { updatedAt: new Date() },
    });
    if (!count) return false;

    const gone = why === 'UNSCHEDULED' ? 'moved to Unscheduled in Jobber' : 'deleted in Jobber';
    await tx.leaseScheduledInspection.updateMany({
      where: { organizationId, inspectionId },
      data: {
        outcome: LeaseInspectionOutcome.CANCELLED,
        detail: `Its visit was ${gone}, so the inspection was removed. Not booked again unless the lease’s dates move.`,
      },
    });
    await tx.tbpQuarterPlanStop.updateMany({
      where: { organizationId, inspectionId },
      data:
        why === 'UNSCHEDULED'
          ? { status: TbpStopStatus.UNSCHEDULED, inspectionId: null, blockedCode: null, blockedMessage: null }
          : {
              status: TbpStopStatus.EXCLUDED,
              inspectionId: null,
              jobberVisitId: null,
              jobberJobId: null,
              blockedCode: null,
              blockedMessage: `Its Jobber visit was deleted on ${businessDate()}.`,
            },
    });
    await tx.timeSegment.updateMany({ where: { organizationId, inspectionId }, data: { inspectionId: null } });

    const erased = await eraseInspectionRows(tx, inspectionId);

    const row = IMPORT_ROW[why];
    await tx.jobberVisitImport.updateMany({
      where: { organizationId, jobberVisitId },
      data: { status: row.status, inspectionId: null, failureCode: row.code, failureMessage: row.message },
    });
    await tx.auditLog.create({
      data: {
        organizationId,
        actorUserId: null,
        action: 'INSPECTION_DELETED',
        entityType: 'Inspection',
        entityId: inspectionId,
        metadata: {
          source: 'JOBBER',
          reason: `JOBBER_VISIT_${why}`,
          jobberVisitId,
          property,
          scheduledOn: inspection.scheduledAt.toISOString().slice(0, 10),
          technicianId: inspection.assignments[0]?.technicianId ?? null,
          wasStatus: inspection.status,
          ...erased,
        },
      },
    });
    return true;
  });
  if (!removed) return { outcome: 'IN_USE' };

  // Told only about a job still ahead of them, and only one not already
  // cancelled: an old cancellation left their schedule when it was made.
  const technicianId = inspection.assignments[0]?.technicianId;
  const ahead = inspection.scheduledAt.toISOString().slice(0, 10) >= businessDate();
  const notify =
    technicianId && ahead && inspection.status === InspectionStatus.SCHEDULED
      ? { technicianId, detail: jobInWords(property, inspection.scheduledAt) }
      : null;
  return { outcome: 'REMOVED', notify };
}
