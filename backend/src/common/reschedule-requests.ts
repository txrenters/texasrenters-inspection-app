import {
  JobberOutboundKind,
  JobberOutboundStatus,
  RescheduleRequestKind,
  RescheduleRequestOutcome,
  RescheduleRequestStatus,
  type InspectionType,
  type Prisma,
} from '@prisma/client';

/**
 * A visit somebody has to book again, as rows (2026-10-21).
 *
 * The writes every path shares: the technician's report that opens a request,
 * the console's answers, and the Jobber workers that settle one. Each takes the
 * caller's transaction, so a request is opened or answered in the same commit
 * as the thing that opens or answers it -- the outbox rule the completion push
 * already follows.
 */

type Db = Prisma.TransactionClient;

/** A request still with somebody: the office, or Jobber. */
export const OPEN_RESCHEDULE_STATUSES = [RescheduleRequestStatus.OPEN, RescheduleRequestStatus.SENDING];

/**
 * How long a rebooking made in Jobber is read as the answer to a request.
 *
 * The sync closes a request when a coordinator books the same kind of visit at
 * the same property in Jobber. A benefit-package property is visited every
 * quarter, so without a limit next quarter's routine visit would close a
 * request nobody answered. Sixty days is well inside the quarter's ninety.
 */
export const REBOOKED_IN_JOBBER_WINDOW_DAYS = 60;

/**
 * Opens the visit's request, or brings its open one up to date.
 *
 * One open request per visit (the migration's partial unique index): the
 * newest account of the visit replaces the one before it -- a technician who
 * asked before the visit and then could not get in has one request, saying the
 * latter. A request the office has already answered and that is waiting for
 * Jobber (SENDING) is the office's, and is left alone.
 */
export async function openRescheduleRequest(
  tx: Db,
  input: {
    organizationId: string;
    inspectionId: string;
    kind: RescheduleRequestKind;
    services: readonly string[];
    reason: string;
    preferredOn?: Date | null;
    requestedById: string | null;
    clientRequestId?: string | null;
  },
): Promise<{ id: string; created: boolean; updated: boolean }> {
  const open = await tx.rescheduleRequest.findFirst({
    where: {
      organizationId: input.organizationId,
      inspectionId: input.inspectionId,
      status: { in: OPEN_RESCHEDULE_STATUSES },
    },
    select: { id: true, status: true },
  });
  const account = {
    kind: input.kind,
    services: [...input.services],
    reason: input.reason,
    preferredOn: input.preferredOn ?? null,
    requestedById: input.requestedById,
  };
  if (open?.status === RescheduleRequestStatus.SENDING) return { id: open.id, created: false, updated: false };
  const request = open
    ? await tx.rescheduleRequest.update({
        where: { id: open.id },
        // A fresh account of the visit: whatever the office tried before is no
        // longer what is being asked.
        data: { ...account, outcome: null, jobberError: null },
        select: { id: true },
      })
    : await tx.rescheduleRequest.create({
        data: {
          organizationId: input.organizationId,
          inspectionId: input.inspectionId,
          clientRequestId: input.clientRequestId ?? null,
          ...account,
        },
        select: { id: true },
      });
  // On the visit's history, beside the submission that asked.
  await tx.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorUserId: input.requestedById,
      action: 'RESCHEDULE_REQUESTED',
      entityType: 'Inspection',
      entityId: input.inspectionId,
      metadata: {
        rescheduleRequestId: request.id,
        kind: input.kind,
        services: [...input.services],
        preferredOn: input.preferredOn?.toISOString().slice(0, 10) ?? null,
        replacedOpenRequest: Boolean(open),
      },
    },
  });
  return { id: request.id, created: !open, updated: Boolean(open) };
}

/**
 * Takes back the visit's open request: the account that opened it no longer
 * asks for anything -- resubmitted with every service done, done on its day
 * after all, or cancelled. Nobody answered it, so nobody is named, and nothing
 * goes to Jobber: the completion, or the cancellation, already says what
 * happened.
 */
export async function withdrawRescheduleRequests(
  tx: Db,
  input: { organizationId: string; inspectionId: string; why: string },
) {
  return tx.rescheduleRequest.updateMany({
    where: { organizationId: input.organizationId, inspectionId: input.inspectionId, status: RescheduleRequestStatus.OPEN },
    data: { status: RescheduleRequestStatus.DISMISSED, dismissReason: input.why, resolvedAt: new Date(), resolvedById: null },
  });
}

/**
 * The visit's open request asking to move it, answered by a move.
 *
 * Wherever the office moves the visit from -- the queue, the inspection's edit
 * dialog, the bulk bar, the plan -- the move answers a technician who asked for
 * another day. DONE at once when nothing has to reach Jobber; otherwise SENDING
 * until the outbound worker hears Jobber take the new day.
 */
export async function answerByMove(
  tx: Db,
  input: { organizationId: string; inspectionId: string; resolvedById: string; waitsForJobber: boolean },
) {
  const answered = await tx.rescheduleRequest.findMany({
    where: {
      organizationId: input.organizationId,
      inspectionId: input.inspectionId,
      kind: RescheduleRequestKind.BEFORE_VISIT,
      status: RescheduleRequestStatus.OPEN,
    },
    select: { id: true },
  });
  if (!answered.length) return [];
  await tx.rescheduleRequest.updateMany({
    where: { id: { in: answered.map((request) => request.id) } },
    data: {
      status: input.waitsForJobber ? RescheduleRequestStatus.SENDING : RescheduleRequestStatus.DONE,
      outcome: RescheduleRequestOutcome.MOVED,
      resolvedById: input.resolvedById,
      resolvedAt: new Date(),
      jobberError: null,
    },
  });
  return answered.map((request) => request.id);
}

/**
 * Queues a note about the request on its visit's job in Jobber.
 *
 * Only for a visit Jobber has a job for. One note of each kind per request
 * (`JobberOutboundTask`'s unique): a request asked again re-arms its note so
 * the newer words go, rather than posting a second one beside it.
 */
export async function queueRescheduleNote(
  tx: Db,
  input: {
    organizationId: string;
    rescheduleRequestId: string;
    kind: typeof JobberOutboundKind.RESCHEDULE_REQUESTED_NOTE | typeof JobberOutboundKind.RESCHEDULE_DISMISSED_NOTE;
    jobberJobId: string | null;
    createdById: string | null;
  },
) {
  if (!input.jobberJobId) return null;
  const armed = {
    status: JobberOutboundStatus.PENDING,
    attempts: 0,
    nextAttemptAt: new Date(),
    lastError: null,
    sentAt: null,
    jobberJobId: input.jobberJobId,
  };
  return tx.jobberOutboundTask.upsert({
    where: {
      organizationId_rescheduleRequestId_kind: {
        organizationId: input.organizationId,
        rescheduleRequestId: input.rescheduleRequestId,
        kind: input.kind,
      },
    },
    create: {
      organizationId: input.organizationId,
      rescheduleRequestId: input.rescheduleRequestId,
      kind: input.kind,
      createdById: input.createdById,
      ...armed,
    },
    update: armed,
    select: { id: true },
  });
}

/**
 * The requests a console push answered, once Jobber has answered the push.
 *
 * A move waits on the visit's VISIT_RESCHEDULE, a booking-again on the new
 * visit's VISIT_CREATE. Taken: DONE. Refused for good: back with the office,
 * with Jobber's reason -- an answer Jobber never took is not an answer. A
 * request back with the office after a refusal is still matched, so a booking
 * queued again once its property is linked closes it when it goes.
 */
export async function settleRescheduleRequests(
  db: Pick<Db, 'rescheduleRequest'>,
  task: { organizationId: string; inspectionId: string | null; kind: JobberOutboundKind },
  answer: { sent: true } | { sent: false; error: string },
) {
  if (!task.inspectionId) return { count: 0 };
  const waiting: Prisma.RescheduleRequestWhereInput | null =
    task.kind === JobberOutboundKind.VISIT_RESCHEDULE
      ? { inspectionId: task.inspectionId, outcome: RescheduleRequestOutcome.MOVED }
      : task.kind === JobberOutboundKind.VISIT_CREATE
        ? { rebookInspectionId: task.inspectionId, outcome: RescheduleRequestOutcome.REBOOKED }
        : null;
  if (!waiting) return { count: 0 };
  if (answer.sent)
    return db.rescheduleRequest.updateMany({
      where: { organizationId: task.organizationId, status: { in: OPEN_RESCHEDULE_STATUSES }, ...waiting },
      data: { status: RescheduleRequestStatus.DONE, jobberError: null },
    });
  return db.rescheduleRequest.updateMany({
    where: { organizationId: task.organizationId, status: RescheduleRequestStatus.SENDING, ...waiting },
    data: { status: RescheduleRequestStatus.OPEN, jobberError: answer.error },
  });
}

/**
 * A coordinator moved the visit in Jobber: the request asking to move it is
 * answered there. Closed by the sync, with nobody named -- the Jobber user who
 * moved it is not someone this system knows.
 */
export async function settleMovedInJobber(tx: Db, input: { organizationId: string; inspectionId: string }) {
  return tx.rescheduleRequest.updateMany({
    where: {
      organizationId: input.organizationId,
      inspectionId: input.inspectionId,
      kind: RescheduleRequestKind.BEFORE_VISIT,
      status: RescheduleRequestStatus.OPEN,
    },
    data: {
      status: RescheduleRequestStatus.DONE,
      outcome: RescheduleRequestOutcome.MOVED,
      resolvedInJobber: true,
      resolvedAt: new Date(),
      resolvedById: null,
      jobberError: null,
    },
  });
}

/**
 * A coordinator booked the visit again in Jobber: the sync has just imported a
 * visit of the same kind at the same property, on or after the day of a visit
 * that asked to be booked again. The oldest such request is answered by it, so
 * the queue does not offer to book a second one.
 *
 * Only a request nobody has answered, and only one asked within
 * `REBOOKED_IN_JOBBER_WINDOW_DAYS`, so next quarter's routine visit is never
 * taken for an answer.
 */
export async function settleRebookedInJobber(
  tx: Db,
  input: {
    organizationId: string;
    inspection: {
      id: string;
      propertywareBuildingId: string | null;
      propertywareUnitId: string | null;
      inspectionType: InspectionType;
      scheduledAt: Date;
    };
  },
) {
  const { inspection } = input;
  if (!inspection.propertywareBuildingId) return null;
  const request = await tx.rescheduleRequest.findFirst({
    where: {
      organizationId: input.organizationId,
      kind: { in: [RescheduleRequestKind.NO_ACCESS, RescheduleRequestKind.SERVICES_NOT_DONE] },
      status: RescheduleRequestStatus.OPEN,
      outcome: null,
      createdAt: { gte: new Date(Date.now() - REBOOKED_IN_JOBBER_WINDOW_DAYS * 24 * 60 * 60 * 1000) },
      inspectionId: { not: inspection.id },
      inspection: {
        propertywareBuildingId: inspection.propertywareBuildingId,
        propertywareUnitId: inspection.propertywareUnitId,
        inspectionType: inspection.inspectionType,
        scheduledAt: { lte: inspection.scheduledAt },
      },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!request) return null;
  await tx.rescheduleRequest.update({
    where: { id: request.id },
    data: {
      status: RescheduleRequestStatus.DONE,
      outcome: RescheduleRequestOutcome.REBOOKED,
      resolvedInJobber: true,
      rebookInspectionId: inspection.id,
      resolvedAt: new Date(),
      resolvedById: null,
    },
  });
  return request.id;
}
