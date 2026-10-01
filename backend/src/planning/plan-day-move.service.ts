import { Inject, Injectable } from '@nestjs/common';

import { AdminService } from '../admin/admin.service';
import { auditActor, type AuthenticatedUser } from '../common/auth';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { movableInspection, QuarterPlannerService, type OptimizedDay } from './quarter-planner.service';
import { TbpStopEditService } from './tbp-stop-edit.service';

/**
 * A day as a move names it: `YYYY-MM-DD` and whose day it is. A type, not an
 * interface, because it is written into the audit row's JSON, and Prisma's JSON
 * input accepts only types it can index.
 */
type PlanDayRef = {
  date: string;
  technicianId: string;
};

export interface MovedToDay {
  stopId: string;
  /** The day it left; null for a visit that had no day. */
  from: PlanDayRef | null;
  to: PlanDayRef;
  /** The days it left and joined, put in the order that drives least from home. */
  days: OptimizedDay[];
}

const dateOf = (at: Date) => at.toISOString().slice(0, 10);

/**
 * A visit moved onto a planned day from the Days map (the office, 2026-10-02).
 *
 * The office picks a day in the list and clicks a property on the map, as it
 * builds a group in the Group maker; the visit there joins that day. Both the
 * day it left and the day it joined are then ordered from the technician's home
 * for the least driving, as Optimize route orders one.
 *
 * Each kind of visit moves the way the console already moves it, so nothing
 * here is a second way of changing a booking:
 * - **Not booked yet** (a draft's visit, or one a published quarter could not
 *   place): the plan's own edit, as from the visit's window -- day and
 *   technician pinned, and a published quarter's visit booked at once.
 * - **Booked** (it has its inspection): the console's reschedule, which moves
 *   the Jobber visit as well and is refused when the console's edits are not
 *   sent to Jobber. A booking keeps its technician: only the date changes, so
 *   it can join another day of the same person. Giving it to someone else is
 *   done from the inspection, where the assignment is sent to Jobber.
 */
@Injectable()
export class PlanDayMoveService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TbpStopEditService) private readonly edits: TbpStopEditService,
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(QuarterPlannerService) private readonly planner: QuarterPlannerService,
  ) {}

  async move(user: AuthenticatedUser, planId: string, dayId: string, stopId: string): Promise<MovedToDay> {
    const { organizationId } = user;
    const day = await this.prisma.tbpQuarterPlanDay.findFirst({
      where: { id: dayId, planId, organizationId },
      select: { date: true, technicianId: true },
    });
    if (!day) throw new ApplicationError(404, 'PLAN_DAY_NOT_FOUND', 'This planned day does not exist.');
    const to: PlanDayRef = { date: dateOf(day.date), technicianId: day.technicianId };
    if (to.date < businessDate())
      throw new ApplicationError(409, 'PLAN_DAY_PASSED', 'That day has passed, so nothing can join it.');

    const stop = await this.prisma.tbpQuarterPlanStop.findFirst({
      where: { id: stopId, planId, organizationId },
      select: {
        scheduledOn: true,
        assignedTechnicianId: true,
        inspectionId: true,
        inspection: { select: { status: true, finalizedAt: true } },
      },
    });
    if (!stop) throw new ApplicationError(404, 'PLAN_STOP_NOT_FOUND', 'No visit in this quarter has that id.');
    const from: PlanDayRef | null =
      stop.scheduledOn && stop.assignedTechnicianId
        ? { date: dateOf(stop.scheduledOn), technicianId: stop.assignedTechnicianId }
        : null;
    if (from && from.date === to.date && from.technicianId === to.technicianId)
      throw new ApplicationError(409, 'ALREADY_ON_THAT_DAY', 'It is already on that day.');

    if (stop.inspectionId) {
      if (!user.permissions.includes('inspections:manage'))
        throw new ApplicationError(
          403,
          'FORBIDDEN',
          'Moving a booked visit reschedules its inspection, which needs permission to manage inspections.',
        );
      if (!stop.inspection || !movableInspection(stop.inspection))
        throw new ApplicationError(409, 'VISIT_STARTED', 'This visit has been started or closed, so it stays where it is.');
      if (stop.assignedTechnicianId !== to.technicianId)
        throw new ApplicationError(
          422,
          'BOOKED_FOR_SOMEONE_ELSE',
          'A booked visit moves here only to another day of the same technician. Give it to someone else from its inspection.',
        );
      // Refused, before anything changes, when it is a Jobber visit and the console's edits are not sent to Jobber.
      await this.admin.updateInspection(user, stop.inspectionId, { scheduledAt: to.date });
    } else {
      await this.edits.edit(user, stopId, { scheduledOn: to.date, assignedTechnicianId: to.technicianId });
    }

    const days = await this.planner.optimizeDays(organizationId, planId, from ? [from, to] : [to]);
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        ...auditActor(user),
        action: 'TBP_VISIT_MOVED_TO_DAY',
        entityType: 'TbpQuarterPlanStop',
        entityId: stopId,
        metadata: { planId, from, to, booked: Boolean(stop.inspectionId) },
      },
    });
    return { stopId, from, to, days };
  }
}
