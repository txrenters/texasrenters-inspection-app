import { Inject, Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

/**
 * Who the work-order matcher may pick: the office's crew for work orders.
 *
 * Empty means every active technician, which is how matching worked before
 * the list existed, so an office that never opens it loses nothing. Once
 * anyone is on it, only they are considered; their skills still decide who
 * fits.
 */

export interface WorkOrderCrewEntry {
  technicianId: string;
  displayName: string;
  inCrew: boolean;
  /** Skills held and not revoked, from the Scope of Work sheet or by hand. */
  skills: number;
}

/** The technicians a work order may go to: the crew, or everyone when there is none. */
export async function crewFilter(
  prisma: Pick<PrismaService, 'workOrderCrewMember'>,
  organizationId: string,
): Promise<string[] | null> {
  const members = await prisma.workOrderCrewMember.findMany({
    where: { organizationId },
    select: { technicianId: true },
  });
  return members.length ? members.map((member) => member.technicianId) : null;
}

@Injectable()
export class WorkOrderCrewService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser): Promise<WorkOrderCrewEntry[]> {
    const organizationId = user.organizationId;
    const [technicians, crew, grants] = await Promise.all([
      this.prisma.userProfile.findMany({
        where: {
          isActive: true,
          memberships: { some: { organizationId, role: UserRole.INSPECTION_TECHNICIAN } },
        },
        select: { id: true, displayName: true },
        orderBy: { displayName: 'asc' },
      }),
      crewFilter(this.prisma, organizationId),
      this.prisma.technicianSkillGrant.groupBy({
        by: ['technicianId'],
        where: { organizationId, revokedAt: null, skill: { isActive: true } },
        _count: { _all: true },
      }),
    ]);
    const skills = new Map(grants.map((row) => [row.technicianId, row._count._all]));
    const inCrew = crew ? new Set(crew) : null;
    return technicians.map((technician) => ({
      technicianId: technician.id,
      displayName: technician.displayName,
      inCrew: inCrew ? inCrew.has(technician.id) : true,
      skills: skills.get(technician.id) ?? 0,
    }));
  }

  /** Replaces the crew. An empty list goes back to everyone. */
  async set(user: AuthenticatedUser, technicianIds: string[]): Promise<WorkOrderCrewEntry[]> {
    const organizationId = user.organizationId;
    const wanted = [...new Set(technicianIds)];
    const valid = await this.prisma.userProfile.findMany({
      where: {
        id: { in: wanted },
        isActive: true,
        memberships: { some: { organizationId, role: UserRole.INSPECTION_TECHNICIAN } },
      },
      select: { id: true },
    });
    if (valid.length !== wanted.length)
      throw new ApplicationError(
        422,
        'INVALID_ACTIVE_TECHNICIAN',
        'Only active inspection technicians can be on the work-order crew.',
      );

    await this.prisma.$transaction(async (tx) => {
      const before = await tx.workOrderCrewMember.findMany({
        where: { organizationId },
        select: { technicianId: true },
      });
      const had = new Set(before.map((member) => member.technicianId));
      const added = wanted.filter((id) => !had.has(id));
      const removed = [...had].filter((id) => !wanted.includes(id));
      if (!added.length && !removed.length) return;
      if (removed.length)
        await tx.workOrderCrewMember.deleteMany({
          where: { organizationId, technicianId: { in: removed } },
        });
      if (added.length)
        await tx.workOrderCrewMember.createMany({
          data: added.map((technicianId) => ({
            organizationId,
            technicianId,
            addedById: user.principalType === 'API_KEY' ? null : user.id,
          })),
        });
      await tx.auditLog.create({
        data: {
          organizationId,
          ...auditActor(user),
          action: 'WORK_ORDER_CREW_CHANGED',
          entityType: 'Organization',
          entityId: organizationId,
          metadata: { added, removed, crew: wanted },
        },
      });
    });
    return this.list(user);
  }
}
