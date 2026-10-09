import { Inject, Injectable } from '@nestjs/common';
import { JobberConnectionStatus, JobberOutboundStatus, UserRole } from '@prisma/client';
import type { JobberDayComparison } from '@texasrenters/shared';

import { businessDate, businessDayBounds, businessDayFromQuery } from '../../common/business-day';
import { PrismaService } from '../../common/prisma.service';
import { compareJobberDay, type StoredJobberVisit } from './jobber-day';
import { getJobberConfig } from './jobber.config';
import { jobberVisitSchema } from './jobber.schemas';

/**
 * Loads one Texas day for `compareJobberDay`. Reads only: the inspections of
 * the day, the Jobber visits the sync stored for it, and the people. Nothing
 * here calls Jobber.
 */
@Injectable()
export class JobberDayService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async day(organizationId: string, query?: string): Promise<JobberDayComparison> {
    const instant = businessDayFromQuery(query);
    const date = businessDate(instant);
    const { start, end } = businessDayBounds(instant);

    const [inspections, connection, technicians] = await Promise.all([
      this.prisma.inspection.findMany({
        // `scheduledAt` is the day itself, held as its UTC midnight.
        where: { organizationId, scheduledAt: new Date(`${date}T00:00:00.000Z`) },
        select: {
          id: true,
          status: true,
          inspectionType: true,
          scheduledStartAt: true,
          jobberVisitId: true,
          propertywareBuilding: { select: { name: true, addressLine1: true } },
          assignments: {
            where: { isCurrent: true },
            select: { technician: { select: { id: true, displayName: true, email: true } } },
          },
          jobberOutboundTasks: {
            where: { status: { in: [JobberOutboundStatus.PENDING, JobberOutboundStatus.FAILED] } },
            select: { kind: true },
          },
        },
      }),
      this.prisma.jobberConnection.findUnique({
        where: { organizationId },
        select: { status: true, lastSyncStartedAt: true, lastSyncCompletedAt: true },
      }),
      this.prisma.userProfile.findMany({
        where: {
          isActive: true,
          memberships: { some: { organizationId, role: UserRole.INSPECTION_TECHNICIAN } },
        },
        select: { id: true, displayName: true, email: true },
      }),
    ]);

    // Visits that START on the Texas day, by their own instant. Not the sync's
    // `dayOf`, which files a visit by its UTC date and so puts an evening visit
    // on the next day.
    const onTheDay = await this.prisma.$queryRaw<Array<{ jobberVisitId: string }>>`
      SELECT "jobberVisitId"
        FROM "JobberVisitImport"
       WHERE "organizationId" = ${organizationId}::uuid
         AND payload->>'startAt' IS NOT NULL
         AND (payload->>'startAt')::timestamptz >= ${start}
         AND (payload->>'startAt')::timestamptz < ${end}
    `;
    const linked = inspections.map((row) => row.jobberVisitId).filter((id): id is string => Boolean(id));
    const visitIds = [...new Set([...linked, ...onTheDay.map((row) => row.jobberVisitId)])];
    const stored = visitIds.length
      ? await this.prisma.jobberVisitImport.findMany({
          where: { organizationId, jobberVisitId: { in: visitIds } },
          select: {
            jobberVisitId: true,
            status: true,
            failureMessage: true,
            inspectionId: true,
            lastAttemptAt: true,
            payload: true,
          },
        })
      : [];
    const visits: StoredJobberVisit[] = stored.map((row) => {
      const parsed = row.payload ? jobberVisitSchema.safeParse(row.payload) : null;
      return { ...row, payload: parsed?.success ? parsed.data : null };
    });

    // A visit of the day whose inspection sits on another day here.
    const ofTheDay = new Set(inspections.map((row) => row.id));
    const elsewhereIds = visits
      .map((visit) => visit.inspectionId)
      .filter((id): id is string => Boolean(id) && !ofTheDay.has(id!));
    const elsewhere = elsewhereIds.length
      ? await this.prisma.inspection.findMany({
          where: { organizationId, id: { in: elsewhereIds } },
          select: {
            id: true,
            status: true,
            scheduledAt: true,
            propertywareBuilding: { select: { name: true, addressLine1: true } },
            assignments: { where: { isCurrent: true }, select: { technicianId: true } },
          },
        })
      : [];

    const people = new Map(technicians.map((person) => [person.id, person]));
    for (const row of inspections) {
      const person = row.assignments[0]?.technician;
      if (person && !people.has(person.id)) people.set(person.id, person);
    }

    return compareJobberDay({
      date,
      inspections: inspections.map((row) => ({
        id: row.id,
        status: row.status,
        inspectionType: row.inspectionType,
        scheduledStartAt: row.scheduledStartAt,
        jobberVisitId: row.jobberVisitId,
        property:
          row.propertywareBuilding?.addressLine1 ?? row.propertywareBuilding?.name ?? 'Property snapshot',
        technician: row.assignments[0]?.technician ?? null,
        waitingKinds: row.jobberOutboundTasks.map((task) => task.kind),
      })),
      visits,
      linkedElsewhere: new Map(
        elsewhere.map((row) => [
          row.id,
          {
            date: row.scheduledAt.toISOString().slice(0, 10),
            status: row.status,
            property:
              row.propertywareBuilding?.addressLine1 ?? row.propertywareBuilding?.name ?? 'Property snapshot',
            technicianId: row.assignments[0]?.technicianId ?? null,
          },
        ]),
      ),
      technicians: [...people.values()],
      connection: connection
        ? {
            connected: connection.status === JobberConnectionStatus.CONNECTED,
            lastSyncStartedAt: connection.lastSyncStartedAt,
            lastSyncCompletedAt: connection.lastSyncCompletedAt,
          }
        : null,
      pushesEnabled: getJobberConfig().pushEditsEnabled,
      actionsEnabled: getJobberConfig().dayActionsEnabled,
    });
  }
}
