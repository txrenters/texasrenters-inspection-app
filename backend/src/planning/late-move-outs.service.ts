import { Inject, Injectable } from '@nestjs/common';
import { InspectionStatus, InspectionType, TbpStopStatus } from '@prisma/client';
import {
  ANCHOR_VISITS,
  haversineMeters,
  isRescheduleMonday,
  quarterEnd,
  quarterStart,
  workingDaysOfQuarter,
  type Quarter,
} from '@texasrenters/shared';

import { AdminService } from '../admin/admin.service';
import { BUILDING_POSITION_SELECT, propertyPosition } from '../admin/property-position';
import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { getJobberConfig } from '../integrations/jobber/jobber.config';
import { movableInspection } from './quarter-planner.service';

/**
 * Move-outs and move-ins booked onto a technician's benefit-package day after
 * the quarter was published -- and the visits to move off it.
 *
 * The office (2026-10-01): a day with a move-out gives up the three visits
 * furthest from it, and those go to the Monday after, which is kept for
 * rescheduled visits. A build does that for the move-outs it knows of
 * (`rescheduleMondays` in the layout). Most it does not: production showed 40
 * of 54 move-outs entered under fifteen days before their day, and the Q4 plan
 * was built around 1 of its 16. So the rest are found here, after the fact, on
 * the technician's day as it stands now -- whoever the office handed it to in
 * Jobber, on a quarter sent out unassigned too.
 *
 * Nothing moves by itself. Moving a visit sends Jobber a visit edit, so the
 * office is shown the visits and the Monday and confirms; each is then moved
 * exactly as a date change in the console moves it (`AdminService.updateInspection`):
 * here, in Jobber, and its plan stop with it.
 */

/** A move-out or move-in on a technician's day that the plan was not built around. */
export interface LateMoveOut {
  /** The technician-day it lands on: `YYYY-MM-DD` and whose. */
  date: string;
  technician: { id: string; displayName: string };
  bookings: { inspectionId: string; kind: 'MOVE_OUT' | 'MOVE_IN'; address: string | null }[];
  /** The day's benefit-package visits that can still be moved. */
  visits: number;
  /** The visits furthest from the bookings, three for each: what to move. */
  suggested: { inspectionId: string; address: string | null; metresFromBooking: number }[];
  /** The Monday after, kept for rescheduled visits; null when the quarter has none left. */
  monday: string | null;
  /** What the technician already has on that Monday. */
  mondayLoad: number;
}

export interface LateMoveOuts {
  conflicts: LateMoveOut[];
  /** Whether a visit moved here reaches Jobber. Off, a Jobber visit cannot be moved from the console at all. */
  jobberEditsPushed: boolean;
}

const dateOf = (at: Date) => at.toISOString().slice(0, 10);

@Injectable()
export class LateMoveOutService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AdminService) private readonly admin: AdminService,
  ) {}

  async conflicts(organizationId: string, planId: string): Promise<LateMoveOuts> {
    const plan = await this.prisma.tbpQuarterPlan.findFirst({
      where: { id: planId, organizationId },
      select: { quarterYear: true, quarterNumber: true, holidays: true, startsOn: true, minStopsPerDay: true },
    });
    if (!plan) throw new ApplicationError(404, 'PLAN_NOT_FOUND', 'This plan does not exist.');
    const quarter: Quarter = { year: plan.quarterYear, quarter: plan.quarterNumber as Quarter['quarter'] };
    const startsOn = plan.startsOn ? dateOf(plan.startsOn) : null;

    const [stops, bookings, anchors] = await Promise.all([
      this.prisma.tbpQuarterPlanStop.findMany({
        where: { planId, organizationId, status: TbpStopStatus.PUBLISHED, inspectionId: { not: null } },
        select: {
          inspection: {
            select: {
              id: true,
              status: true,
              finalizedAt: true,
              scheduledAt: true,
              propertywareBuilding: { select: { addressLine1: true, ...BUILDING_POSITION_SELECT } },
              assignments: {
                where: { isCurrent: true },
                select: { technician: { select: { id: true, displayName: true } } },
                take: 1,
              },
            },
          },
        },
      }),
      this.prisma.inspection.findMany({
        where: {
          organizationId,
          inspectionType: { in: [InspectionType.MOVE_OUT, InspectionType.MOVE_IN] },
          status: { notIn: [InspectionStatus.CANCELLED, InspectionStatus.COMPLETED] },
          scheduledAt: { gte: startsOn ? new Date(`${startsOn}T00:00:00.000Z`) : quarterStart(quarter), lt: quarterEnd(quarter) },
        },
        select: {
          id: true,
          inspectionType: true,
          scheduledAt: true,
          propertywareBuilding: { select: { addressLine1: true, ...BUILDING_POSITION_SELECT } },
          assignments: { where: { isCurrent: true }, select: { technicianId: true }, take: 1 },
        },
      }),
      this.prisma.tbpQuarterPlanAnchor.findMany({
        where: { planId, organizationId },
        select: { inspectionId: true, technicianId: true, date: true },
      }),
    ]);

    // The benefit-package visits still to do, by the day and the person they are with now.
    const days = new Map<string, { date: string; technician: { id: string; displayName: string }; visits: typeof stops }>();
    for (const stop of stops) {
      const inspection = stop.inspection;
      const technician = inspection?.assignments[0]?.technician;
      if (!inspection || !technician || !movableInspection(inspection)) continue;
      const key = `${dateOf(inspection.scheduledAt)}|${technician.id}`;
      const day = days.get(key) ?? { date: dateOf(inspection.scheduledAt), technician, visits: [] };
      day.visits.push(stop);
      days.set(key, day);
    }

    // A booking the layout built its day around is already allowed for; one that moved since is not.
    const anchored = new Set(anchors.map((anchor) => `${anchor.inspectionId}|${dateOf(anchor.date)}|${anchor.technicianId}`));
    const late = new Map<string, typeof bookings>();
    for (const booking of bookings) {
      const technicianId = booking.assignments[0]?.technicianId;
      if (!technicianId) continue;
      const key = `${dateOf(booking.scheduledAt)}|${technicianId}`;
      if (!days.has(key) || anchored.has(`${booking.id}|${key}`)) continue;
      late.set(key, [...(late.get(key) ?? []), booking]);
    }

    const mondays = workingDaysOfQuarter(quarter, plan.holidays, startsOn).filter((date) =>
      isRescheduleMonday(date, quarter, startsOn),
    );
    const conflicts: LateMoveOut[] = [];
    for (const [key, dayBookings] of [...late].sort(([left], [right]) => left.localeCompare(right))) {
      const day = days.get(key)!;
      const places = dayBookings.flatMap((booking) => {
        const at = propertyPosition(booking.propertywareBuilding);
        return at ? [at] : [];
      });
      const ranked = day.visits
        .map((stop) => {
          const at = propertyPosition(stop.inspection!.propertywareBuilding);
          const metres = at && places.length ? Math.min(...places.map((place) => haversineMeters(place, at))) : 0;
          return { inspectionId: stop.inspection!.id, address: stop.inspection!.propertywareBuilding?.addressLine1 ?? null, metresFromBooking: Math.round(metres) };
        })
        .sort((left, right) => right.metresFromBooking - left.metresFromBooking);
      /**
       * Three for each booking, and never below what the day holds beside them
       * -- the plan's nine, three fewer for each (`dayVisitRange`). A day already
       * down to that has been adjusted, whoever did it: it is not offered again,
       * even after a rebuild has cleared the record that it was handled here.
       */
      const keep = Math.max(0, plan.minStopsPerDay - ANCHOR_VISITS * dayBookings.length);
      const toMove = Math.min(ANCHOR_VISITS * dayBookings.length, ranked.length - keep);
      if (toMove <= 0) continue;
      const monday = mondays.find((date) => date > day.date) ?? null;
      conflicts.push({
        date: day.date,
        technician: day.technician,
        bookings: dayBookings.map((booking) => ({
          inspectionId: booking.id,
          kind: booking.inspectionType === InspectionType.MOVE_IN ? 'MOVE_IN' : 'MOVE_OUT',
          address: booking.propertywareBuilding?.addressLine1 ?? null,
        })),
        visits: day.visits.length,
        suggested: ranked.slice(0, toMove),
        monday,
        mondayLoad: monday ? await this.loadOn(organizationId, day.technician.id, monday) : 0,
      });
    }
    return { conflicts, jobberEditsPushed: getJobberConfig().pushEditsEnabled };
  }

  /**
   * Moves the visits the office confirmed to the Monday after their day.
   *
   * Only visits of a day this finds a late booking on, and only to that day's
   * Monday: both are worked out again here rather than taken from the request.
   * Refused whole, before anything moves, when a Jobber visit is among them and
   * the console's edits are not pushed to Jobber -- each would be refused
   * anyway, and a half-moved day is worse than an unmoved one.
   */
  async moveToMonday(
    user: AuthenticatedUser,
    planId: string,
    input: { date: string; technicianId: string; inspectionIds: string[] },
  ) {
    const { conflicts } = await this.conflicts(user.organizationId, planId);
    const conflict = conflicts.find((entry) => entry.date === input.date && entry.technician.id === input.technicianId);
    if (!conflict)
      throw new ApplicationError(409, 'NO_LATE_MOVE_OUT', 'No move-out booked since the plan is on that day any more.');
    if (!conflict.monday)
      throw new ApplicationError(409, 'NO_MONDAY_LEFT', 'The quarter has no Monday left after that day. Move these visits by hand.');

    const movable = await this.prisma.inspection.findMany({
      where: {
        organizationId: user.organizationId,
        id: { in: input.inspectionIds },
        status: InspectionStatus.SCHEDULED,
        finalizedAt: null,
        scheduledAt: new Date(`${conflict.date}T00:00:00.000Z`),
        assignments: { some: { isCurrent: true, technicianId: conflict.technician.id } },
        tbpPlanStop: { is: { planId, status: TbpStopStatus.PUBLISHED } },
      },
      select: { id: true, jobberVisitId: true },
    });
    const unknown = input.inspectionIds.filter((id) => !movable.some((inspection) => inspection.id === id));
    if (unknown.length || !movable.length)
      throw new ApplicationError(
        422,
        'NOT_ON_THAT_DAY',
        'Only that day’s benefit-package visits that have not started can be moved to its Monday.',
      );
    if (!getJobberConfig().pushEditsEnabled && movable.some((inspection) => inspection.jobberVisitId))
      throw new ApplicationError(
        409,
        'SCHEDULED_IN_JOBBER',
        'These visits are scheduled in Jobber, and edits are not sent to Jobber from here. Move them in Jobber.',
      );

    const moved: string[] = [];
    const failed: { inspectionId: string; message: string }[] = [];
    for (const inspection of movable) {
      try {
        await this.admin.updateInspection(user, inspection.id, { scheduledAt: conflict.monday });
        moved.push(inspection.id);
      } catch (error) {
        failed.push({ inspectionId: inspection.id, message: error instanceof Error ? error.message : 'Could not be moved.' });
      }
    }

    /**
     * The day is now built around its bookings: recorded as the layout records
     * the move-outs it built a day around, so the day is not offered again. A
     * rebuild rewrites these; the day's own size then keeps it off the list.
     */
    if (moved.length)
      for (const booking of conflict.bookings)
        await this.prisma.tbpQuarterPlanAnchor.upsert({
          where: { planId_inspectionId: { planId, inspectionId: booking.inspectionId } },
          create: {
            organizationId: user.organizationId,
            planId,
            inspectionId: booking.inspectionId,
            technicianId: conflict.technician.id,
            date: new Date(`${conflict.date}T00:00:00.000Z`),
          },
          update: { technicianId: conflict.technician.id, date: new Date(`${conflict.date}T00:00:00.000Z`) },
        });

    await this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        actorUserId: user.id,
        actorApiClientId: null,
        action: 'TBP_VISITS_MOVED_TO_MONDAY',
        entityType: 'TbpQuarterPlan',
        entityId: planId,
        // The day, the bookings that crowded it and what went where, so a
        // technician asking why their Monday filled up can be told.
        metadata: {
          from: conflict.date,
          to: conflict.monday,
          technicianId: conflict.technician.id,
          bookings: conflict.bookings.map((booking) => booking.inspectionId),
          moved,
          failed: failed.map((entry) => entry.inspectionId),
        },
      },
    });
    return { monday: conflict.monday, moved: moved.length, failed };
  }

  /** What a technician has on a day, not cancelled: how full the Monday already is. */
  private loadOn(organizationId: string, technicianId: string, date: string) {
    return this.prisma.inspection.count({
      where: {
        organizationId,
        scheduledAt: new Date(`${date}T00:00:00.000Z`),
        status: { not: InspectionStatus.CANCELLED },
        assignments: { some: { isCurrent: true, technicianId } },
      },
    });
  }
}
