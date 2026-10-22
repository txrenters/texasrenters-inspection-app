import { Inject, Injectable } from '@nestjs/common';
import {
  booksAnyService,
  isBookableInspectionType,
  rebookingFromVisit,
  rescheduleServices,
  suggestedRescheduleDay,
  type BookAgainRescheduleRequestInput,
  type DismissRescheduleRequestInput,
  type MoveRescheduleRequestInput,
  type RescheduleRequestFilter,
  type RescheduleRequestList,
  type RescheduleRequestView,
} from '@texasrenters/shared';
import {
  JobberOutboundKind,
  RescheduleRequestKind,
  RescheduleRequestOutcome,
  RescheduleRequestStatus,
  type Prisma,
} from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { OPEN_RESCHEDULE_STATUSES, queueRescheduleNote } from '../common/reschedule-requests';
import { getJobberConfig } from '../integrations/jobber/jobber.config';
import type { CreateAdminInspectionDto, UpdateAdminInspectionDto } from './admin.dto';
import { AdminService } from './admin.service';

/**
 * The office's queue of visits to book again (2026-10-21).
 *
 * Three answers, each of which reaches Jobber: **Move** a visit still to happen
 * (the console's own reschedule, so the plan stop moves and Jobber gets the new
 * day), **Book again** a visit that was closed (a new inspection, booked in
 * Jobber when the first one was), or **Dismiss** with a reason (a note on the
 * Jobber job, so nobody there books what the completion note asked for).
 *
 * Who answers (the office, 2026-10-21): anyone who manages inspections or
 * publishes the plan. Moving or booking a visit changes an inspection, so those
 * two still need `inspections:manage` -- the rule the plan page already keeps.
 */

/** Either grant opens the queue and dismisses from it. */
const QUEUE_PERMISSIONS = ['inspections:manage', 'planning:publish'] as const;

/** How many answered requests the closed list shows, newest first. */
const CLOSED_LIMIT = 200;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const requestSelect = {
  id: true,
  inspectionId: true,
  kind: true,
  status: true,
  outcome: true,
  resolvedInJobber: true,
  services: true,
  reason: true,
  preferredOn: true,
  createdAt: true,
  dismissReason: true,
  jobberError: true,
  resolvedAt: true,
  rebookInspectionId: true,
  requestedBy: { select: { id: true, displayName: true } },
  resolvedBy: { select: { id: true, displayName: true } },
  inspection: {
    select: {
      id: true,
      inspectionType: true,
      scheduledAt: true,
      status: true,
      jobberVisitId: true,
      jobberJobId: true,
      jobberCompanionOfId: true,
      propertywareBuilding: { select: { name: true, addressLine1: true, city: true } },
      assignments: {
        where: { isCurrent: true },
        take: 1,
        select: { technician: { select: { id: true, displayName: true } } },
      },
      jobberOutboundTasks: { where: { kind: JobberOutboundKind.VISIT_CREATE }, take: 1, select: { id: true } },
    },
  },
  rebookInspection: { select: { id: true, scheduledAt: true, status: true } },
} satisfies Prisma.RescheduleRequestSelect;

type RequestRow = Prisma.RescheduleRequestGetPayload<{ select: typeof requestSelect }>;

const day = (date: Date) => date.toISOString().slice(0, 10);

/** Booked in Jobber: imported from a visit, riding on another's, or booked from the console. */
function inJobber(inspection: RequestRow['inspection']) {
  return Boolean(inspection.jobberVisitId || inspection.jobberCompanionOfId || inspection.jobberOutboundTasks.length);
}

function view(row: RequestRow, today: string): RescheduleRequestView {
  const preferredOn = row.preferredOn ? day(row.preferredOn) : null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    outcome: row.outcome,
    resolvedInJobber: row.resolvedInJobber,
    services: rescheduleServices(row.services),
    reason: row.reason,
    preferredOn,
    requestedAt: row.createdAt.toISOString(),
    requestedBy: row.requestedBy,
    inspection: {
      id: row.inspection.id,
      inspectionType: row.inspection.inspectionType,
      scheduledOn: day(row.inspection.scheduledAt),
      status: row.inspection.status,
      address: row.inspection.propertywareBuilding?.addressLine1 ?? row.inspection.propertywareBuilding?.name ?? null,
      city: row.inspection.propertywareBuilding?.city ?? null,
      technician: row.inspection.assignments[0]?.technician ?? null,
      inJobber: inJobber(row.inspection),
    },
    rebook: row.rebookInspection
      ? { id: row.rebookInspection.id, scheduledOn: day(row.rebookInspection.scheduledAt), status: row.rebookInspection.status }
      : null,
    action: row.kind === RescheduleRequestKind.BEFORE_VISIT ? 'MOVE' : 'BOOK_AGAIN',
    suggestedDay: suggestedRescheduleDay(today, preferredOn),
    dismissReason: row.dismissReason,
    jobberError: row.jobberError,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
  };
}

@Injectable()
export class RescheduleRequestsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AdminService) private readonly admin: AdminService,
  ) {}

  async list(user: AuthenticatedUser, filter: RescheduleRequestFilter = 'open'): Promise<RescheduleRequestList> {
    this.requireQueue(user);
    const open = filter === 'open';
    const [rows, counts] = await Promise.all([
      this.prisma.rescheduleRequest.findMany({
        where: {
          organizationId: user.organizationId,
          status: open
            ? { in: OPEN_RESCHEDULE_STATUSES }
            : { in: [RescheduleRequestStatus.DONE, RescheduleRequestStatus.DISMISSED] },
        },
        // The oldest first while they wait; the latest answers first once answered.
        orderBy: open ? { createdAt: 'asc' } : { resolvedAt: 'desc' },
        ...(open ? {} : { take: CLOSED_LIMIT }),
        select: requestSelect,
      }),
      this.prisma.rescheduleRequest.groupBy({
        by: ['status'],
        where: { organizationId: user.organizationId, status: { in: OPEN_RESCHEDULE_STATUSES } },
        _count: { _all: true },
      }),
    ]);
    const count = (status: RescheduleRequestStatus) =>
      counts.find((row) => row.status === status)?._count._all ?? 0;
    const config = getJobberConfig();
    const today = businessDate();
    return {
      items: rows.map((row) => view(row, today)),
      counts: { open: count(RescheduleRequestStatus.OPEN), sending: count(RescheduleRequestStatus.SENDING) },
      jobberEditsPushed: config.pushEditsEnabled,
      jobberBookingEnabled: config.bookingEnabled,
    };
  }

  /**
   * The visit on another day: the console's reschedule, so it is held to the
   * same rules -- the clash check, the plan stop moving with it, Jobber told.
   * That reschedule answers the request itself (`answerByMove`), as a move
   * made anywhere else does.
   */
  async move(user: AuthenticatedUser, id: string, input: MoveRescheduleRequestInput) {
    this.requireManage(user);
    const request = await this.openRequest(user, id);
    if (request.kind !== RescheduleRequestKind.BEFORE_VISIT)
      throw new ApplicationError(
        409,
        'RESCHEDULE_NOT_MOVABLE',
        'This visit is closed already, so it cannot be moved. Book it again instead.',
      );
    this.requireDayAhead(input.scheduledOn);
    if (input.scheduledOn === day(request.inspection.scheduledAt))
      throw new ApplicationError(422, 'RESCHEDULE_SAME_DAY', 'The visit is already on that day.');
    await this.admin.updateInspection(user, request.inspectionId, {
      scheduledAt: `${input.scheduledOn}T00:00:00.000Z`,
    } as UpdateAdminInspectionDto);
    return this.one(user, id);
  }

  /**
   * A new visit for what was not done, on the day picked, with the same
   * technician unless another is named.
   *
   * Booked in Jobber when the first visit was -- the same zone, plan, tenants
   * and access notes, and only the services still to do -- through the
   * console's own booking, so it is written and sent exactly as one made by
   * hand. Created and answered in one transaction: two clicks cannot book it
   * twice.
   */
  async bookAgain(user: AuthenticatedUser, id: string, input: BookAgainRescheduleRequestInput) {
    this.requireManage(user);
    const request = await this.openRequest(user, id);
    if (request.kind === RescheduleRequestKind.BEFORE_VISIT)
      throw new ApplicationError(
        409,
        'RESCHEDULE_NOT_CLOSED',
        'This visit has not happened yet. Move it to another day instead of booking a second one.',
      );
    if (request.rebookInspectionId)
      throw new ApplicationError(
        409,
        'RESCHEDULE_ALREADY_BOOKED',
        'It was booked again already, and Jobber refused that booking. Fix it on the new inspection, or dismiss this.',
      );
    this.requireDayAhead(input.scheduledOn);
    const original = await this.prisma.inspection.findFirstOrThrow({
      where: { id: request.inspectionId, organizationId: user.organizationId },
      select: {
        inspectionType: true,
        scheduledAt: true,
        propertywareBuildingId: true,
        propertywareUnitId: true,
        propertywareLeaseId: true,
        allowTechnicianAreaCapture: true,
        jobberVisitTitle: true,
        jobberVisitDetails: true,
      },
    });
    if (!original.propertywareBuildingId)
      throw new ApplicationError(422, 'RESCHEDULE_NO_PROPERTY', 'This visit has no property to book again.');
    const booking = rebookingFromVisit({
      title: original.jobberVisitTitle,
      details: original.jobberVisitDetails,
      services: request.services,
      scheduledOn: day(original.scheduledAt),
      reason: request.reason,
    });
    const toJobber = inJobber(request.inspection);
    if (toJobber && !isBookableInspectionType(original.inspectionType))
      throw new ApplicationError(
        422,
        'RESCHEDULE_NOT_BOOKABLE',
        'This kind of visit cannot be booked in Jobber from here. Book it in Jobber, then dismiss this.',
      );
    const technicianId =
      input.technicianId === null ? undefined : (input.technicianId ?? request.inspection.assignments[0]?.technician.id);
    const dto = {
      propertyId: original.propertywareBuildingId,
      unitId: original.propertywareUnitId ?? undefined,
      leaseId: original.propertywareLeaseId ?? undefined,
      technicianId,
      scheduledAt: `${input.scheduledOn}T00:00:00.000Z`,
      inspectionType: original.inspectionType,
      priority: 'STANDARD',
      allowTechnicianAreaCapture: original.allowTechnicianAreaCapture,
      internalNotes: `Booked again from the visit on ${day(original.scheduledAt)}: ${request.reason}`.slice(0, 2000),
      idempotencyKey: `reschedule-${request.id}`,
      ...(toJobber
        ? { jobberBooking: booking }
        : booksAnyService(booking.services)
          ? { visitServices: { services: booking.services, filters: booking.filters } }
          : {}),
    } as CreateAdminInspectionDto;
    await this.admin.createInspection(user, dto, {
      // The visit that asked was closed as submitted, which the clash check
      // still counts: without this it refuses a booking for that same day.
      rebookOf: request.inspectionId,
      within: async (tx, created) => {
        const { count } = await tx.rescheduleRequest.updateMany({
          where: { id: request.id, organizationId: user.organizationId, status: RescheduleRequestStatus.OPEN, rebookInspectionId: null },
          data: {
            status: created.bookedInJobber ? RescheduleRequestStatus.SENDING : RescheduleRequestStatus.DONE,
            outcome: RescheduleRequestOutcome.REBOOKED,
            rebookInspectionId: created.id,
            resolvedById: user.id,
            resolvedAt: new Date(),
            jobberError: null,
          },
        });
        // Somebody answered it in the meantime: the new inspection goes too.
        if (!count) throw this.alreadyAnswered();
        await tx.auditLog.create({
          data: {
            organizationId: user.organizationId,
            actorUserId: user.id,
            action: 'RESCHEDULE_REQUEST_REBOOKED',
            entityType: 'Inspection',
            entityId: request.inspectionId,
            metadata: {
              rescheduleRequestId: request.id,
              rebookInspectionId: created.id,
              scheduledOn: input.scheduledOn,
              technicianId: technicianId ?? null,
              bookedInJobber: created.bookedInJobber,
            },
          },
        });
      },
    });
    return this.one(user, id);
  }

  /**
   * Not booked again, and why. A note on the Jobber job says so, so a
   * coordinator reading "Needs to be rescheduled" there does not book it.
   */
  async dismiss(user: AuthenticatedUser, id: string, input: DismissRescheduleRequestInput) {
    this.requireQueue(user);
    const reason = input.reason.trim();
    await this.prisma.$transaction(async (tx) => {
      const request = await tx.rescheduleRequest.findFirst({
        where: { id, organizationId: user.organizationId },
        select: { inspectionId: true, inspection: { select: { jobberJobId: true } } },
      });
      if (!request) throw this.notFound();
      const { count } = await tx.rescheduleRequest.updateMany({
        where: { id, organizationId: user.organizationId, status: RescheduleRequestStatus.OPEN },
        data: {
          status: RescheduleRequestStatus.DISMISSED,
          dismissReason: reason,
          resolvedById: user.id,
          resolvedAt: new Date(),
        },
      });
      if (!count) throw this.alreadyAnswered();
      await queueRescheduleNote(tx, {
        organizationId: user.organizationId,
        rescheduleRequestId: id,
        kind: JobberOutboundKind.RESCHEDULE_DISMISSED_NOTE,
        jobberJobId: request.inspection.jobberJobId,
        createdById: user.id,
      });
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'RESCHEDULE_REQUEST_DISMISSED',
          entityType: 'Inspection',
          entityId: request.inspectionId,
          metadata: { rescheduleRequestId: id, reason },
        },
      });
    });
    return this.one(user, id);
  }

  private async one(user: AuthenticatedUser, id: string) {
    const row = await this.prisma.rescheduleRequest.findFirst({
      where: { id, organizationId: user.organizationId },
      select: requestSelect,
    });
    if (!row) throw this.notFound();
    return view(row, businessDate());
  }

  /** A request still with the office: never answered, or back after Jobber refused. */
  private async openRequest(user: AuthenticatedUser, id: string) {
    const row = await this.prisma.rescheduleRequest.findFirst({
      where: { id, organizationId: user.organizationId },
      select: requestSelect,
    });
    if (!row) throw this.notFound();
    if (row.status !== RescheduleRequestStatus.OPEN) throw this.alreadyAnswered();
    return row;
  }

  private requireDayAhead(scheduledOn: string) {
    if (!DAY.test(scheduledOn) || scheduledOn < businessDate())
      throw new ApplicationError(422, 'RESCHEDULE_DAY_PASSED', 'Pick today or a day ahead.');
  }

  private requireQueue(user: AuthenticatedUser) {
    if (!QUEUE_PERMISSIONS.some((permission) => user.permissions.includes(permission)))
      throw new ApplicationError(
        403,
        'PERMISSION_DENIED',
        'Answering reschedule requests needs permission to manage inspections or to publish the plan.',
      );
  }

  private requireManage(user: AuthenticatedUser) {
    if (!user.permissions.includes('inspections:manage'))
      throw new ApplicationError(
        403,
        'PERMISSION_DENIED',
        'Moving or booking a visit changes an inspection, which needs permission to manage inspections.',
      );
  }

  private notFound() {
    return new ApplicationError(404, 'RESCHEDULE_REQUEST_NOT_FOUND', 'That reschedule request was not found.');
  }

  private alreadyAnswered() {
    return new ApplicationError(409, 'RESCHEDULE_ALREADY_ANSWERED', 'This request has been answered already.');
  }
}
