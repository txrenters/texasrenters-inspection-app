import { InspectionStatus, type Prisma } from '@prisma/client';
import {
  COULD_NOT_GET_IN_PREFIX,
  FINISHED_INSPECTION_STATUSES,
  REPORTABLE_VISIT_SERVICES,
  type VisitOpenWork,
  type VisitState,
} from '@texasrenters/shared';

/**
 * The visit is done: the technician has submitted it, and everything after.
 *
 * **The office's rule (2026-10-05): submitted is done.** Nobody finalizes any
 * more. The maintenance admins review the findings and generate the reports,
 * and a visit is finished the moment the technician submits it -- which is when
 * Jobber is told the visit is complete and the technician's paid time stops.
 * Code that waited for COMPLETED (an administrator's finalize, or Jobber's own
 * completion) left a submitted inspection looking open for ever: the next
 * technician lost the last visit's note, the "completed" counts stopped moving,
 * and a walked visit could still be rescheduled and its edits pushed to Jobber.
 *
 * The same list the route map already uses for "the technician has been and
 * done the visit", so the two cannot disagree. It leaves out
 * FOLLOW_UP_REQUIRED, which asks for another visit, and CANCELLED.
 */
export const DONE_INSPECTION_STATUSES: InspectionStatus[] = FINISHED_INSPECTION_STATUSES.map(
  (status) => InspectionStatus[status],
);

/** Whether an inspection's visit is done. */
export function isDoneInspectionStatus(status: InspectionStatus): boolean {
  return DONE_INSPECTION_STATUSES.includes(status);
}

/**
 * Still to happen -- a visit somebody has to be sent to (`isUpcomingVisit`).
 *
 * Neither done nor cancelled: scheduled, under way, or asking for another
 * visit. This is a technician's open work. Finishing a visit never ends its
 * assignment -- the record keeps who walked it -- so "current assignments"
 * without this filter counted every visit a technician had ever finished, and
 * a deactivation guard built on it could never be satisfied: a finished
 * inspection cannot be reassigned (`INSPECTION_NOT_ASSIGNABLE`).
 */
export const UPCOMING_INSPECTION_STATUSES: InspectionStatus[] = Object.values(
  InspectionStatus,
).filter(
  (status) => status !== InspectionStatus.CANCELLED && !DONE_INSPECTION_STATUSES.includes(status),
);

/**
 * The inspections in one visit state (`visitStateOf`), as a query.
 *
 * "Could not get in" is a done visit whose reason says so. "Done" is every
 * other done visit -- a blocked reason that says something else, or none. The
 * `OR` with null is not decoration: `NOT startsWith` alone is false for a null
 * reason in SQL, and would leave out nearly every done visit.
 */
export function visitStateWhere(state: VisitState): Prisma.InspectionWhereInput {
  const couldNotGetIn = { startsWith: COULD_NOT_GET_IN_PREFIX };
  switch (state) {
    case 'SCHEDULED':
      return { status: InspectionStatus.SCHEDULED };
    case 'IN_PROGRESS':
      return { status: InspectionStatus.IN_PROGRESS };
    case 'FOLLOW_UP':
      return { status: InspectionStatus.FOLLOW_UP_REQUIRED };
    case 'CANCELLED':
      return { status: InspectionStatus.CANCELLED };
    case 'COULD_NOT_GET_IN':
      return { status: { in: DONE_INSPECTION_STATUSES }, completionBlockedReason: couldNotGetIn };
    case 'DONE':
      return {
        status: { in: DONE_INSPECTION_STATUSES },
        OR: [{ completionBlockedReason: null }, { NOT: { completionBlockedReason: couldNotGetIn } }],
        NOT: OPEN_WORK_WHERE,
      };
    case 'PARTIALLY_COMPLETE':
      return {
        status: { in: DONE_INSPECTION_STATUSES },
        AND: [
          { OR: [{ completionBlockedReason: null }, { NOT: { completionBlockedReason: couldNotGetIn } }] },
          OPEN_WORK_WHERE,
        ],
      };
  }
}

/** A "not done, book it again" the office has not answered, or answered with a visit not yet done. */
const OWED_REQUEST_WHERE = {
  kind: 'SERVICES_NOT_DONE',
  OR: [
    { status: { in: ['OPEN', 'SENDING'] } },
    { status: 'DONE', rebookInspection: { is: { status: { in: UPCOMING_INSPECTION_STATUSES } } } },
  ],
} satisfies Prisma.RescheduleRequestWhereInput;

/**
 * A submitted visit that still owes a job (`VisitOpenWork`), as a query.
 *
 * The other half of `visitOpenWork`: the list's filter and a row's badge must
 * give the same answer, so a change to one is a change to both.
 */
const OPEN_WORK_WHERE: Prisma.InspectionWhereInput = {
  OR: [
    { rescheduleRequests: { some: OWED_REQUEST_WHERE } },
    { jobberCompanionOf: { is: { status: { in: UPCOMING_INSPECTION_STATUSES } } } },
    { jobberCompanions: { some: { status: { in: UPCOMING_INSPECTION_STATUSES } } } },
  ],
};

/** What `visitOpenWork` reads; spread into an inspection select. */
export const OPEN_WORK_SELECT = {
  rescheduleRequests: {
    where: { kind: 'SERVICES_NOT_DONE', status: { in: ['OPEN', 'SENDING', 'DONE'] } },
    select: { status: true, services: true, rebookInspection: { select: { status: true } } },
  },
  jobberCompanionOf: { select: { id: true, inspectionType: true, status: true } },
  jobberCompanions: { select: { id: true, inspectionType: true, status: true } },
} satisfies Prisma.InspectionSelect;

interface OpenWorkRecord {
  status: InspectionStatus;
  rescheduleRequests: Array<{
    status: string;
    services: string[];
    rebookInspection: { status: InspectionStatus } | null;
  }>;
  jobberCompanionOf: { inspectionType: string; status: InspectionStatus } | null;
  jobberCompanions: Array<{ inspectionType: string; status: InspectionStatus }>;
}

/**
 * What a submitted visit still owes, or null when it owes nothing or has not
 * been submitted: a visit still to happen owes all of it, and says so already.
 */
export function visitOpenWork(record: OpenWorkRecord): VisitOpenWork | null {
  if (!DONE_INSPECTION_STATUSES.includes(record.status)) return null;
  const owed = new Set<string>();
  for (const request of record.rescheduleRequests) {
    const waiting = request.status === 'OPEN' || request.status === 'SENDING';
    const bookedAgain =
      request.status === 'DONE' &&
      request.rebookInspection !== null &&
      UPCOMING_INSPECTION_STATUSES.includes(request.rebookInspection.status);
    if (waiting || bookedAgain) for (const service of request.services) owed.add(service);
  }
  const inspections = [record.jobberCompanionOf, ...record.jobberCompanions]
    .filter((other): other is NonNullable<typeof other> => Boolean(other))
    .filter((other) => UPCOMING_INSPECTION_STATUSES.includes(other.status))
    .map((other) => other.inspectionType);
  // In the order the office lists the services, whatever order they were asked in.
  const services = (REPORTABLE_VISIT_SERVICES as readonly string[]).filter((service) => owed.has(service));
  return services.length || inspections.length ? { services, inspections } : null;
}
