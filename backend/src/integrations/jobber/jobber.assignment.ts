import { UserRole } from '@prisma/client';

import type { PrismaService } from '../../common/prisma.service';
import type { JobberVisit } from './jobber.schemas';

/**
 * Copying a coordinator's technician across from Jobber.
 *
 * Matched on **email**, never on name. Jobber holds "kevin granados" where this
 * app holds "Kevin Granados", and the same person's name is spelled differently
 * in the two systems often enough that name matching would be a coin toss.
 * `UserProfile.email` is unique and required, which makes it a real key.
 *
 * About half of the assignees on a live calendar are people this app does not
 * know — 5 of 11 on the first measurement, including a Beatriz Iniguez and a
 * Moses Rodriguez who are Jobber users but not inspection technicians here.
 * Those are left unassigned rather than approximated: putting the wrong
 * technician on an inspection sends the wrong person to somebody's home, and an
 * unassigned inspection already announces itself in the console.
 */

export interface AssignmentMatch {
  technicianId: string;
  email: string;
}

export interface AssignmentMiss {
  email: string | null;
  name: string | null;
}

export type AssignmentResolution =
  | { outcome: 'MATCHED'; match: AssignmentMatch }
  | { outcome: 'NO_ASSIGNEE' }
  | { outcome: 'UNKNOWN_ASSIGNEE'; misses: AssignmentMiss[] };

/** The assignees Jobber reports, in the order it reports them. */
export function visitAssignees(visit: JobberVisit) {
  return (visit.assignedUsers?.nodes ?? []).map((user) => ({
    email: user.email?.raw?.trim().toLowerCase() || null,
    name: user.name?.full ?? null,
  }));
}

/**
 * Resolves the first Jobber assignee that is a technician here.
 *
 * First rather than all, because an inspection carries one current technician.
 * A visit with two assignees where only one is known to us is a match on that
 * one; a visit where none is known is left alone with every name recorded, so
 * the console can say who Jobber actually named.
 */
export async function resolveAssignment(
  prisma: PrismaService,
  organizationId: string,
  visit: JobberVisit,
): Promise<AssignmentResolution> {
  const assignees = visitAssignees(visit);
  if (!assignees.length) return { outcome: 'NO_ASSIGNEE' };

  const emails = assignees.map((a) => a.email).filter((email): email is string => Boolean(email));
  if (!emails.length) return { outcome: 'UNKNOWN_ASSIGNEE', misses: assignees };

  /**
   * Only active inspection technicians of this organization.
   *
   * An administrator with a matching email is not a technician, and assigning
   * work to them would put an inspection in a queue nobody looks at.
   */
  const candidates = await prisma.userProfile.findMany({
    where: {
      email: { in: emails, mode: 'insensitive' },
      isActive: true,
      memberships: {
        some: { organizationId, role: UserRole.INSPECTION_TECHNICIAN },
      },
    },
    select: { id: true, email: true },
  });
  const byEmail = new Map(candidates.map((c) => [c.email.toLowerCase(), c.id]));

  // Jobber's own ordering is respected: the first assignee it lists that we
  // recognise is the one the coordinator put there first.
  for (const assignee of assignees) {
    const technicianId = assignee.email ? byEmail.get(assignee.email) : undefined;
    if (technicianId) return { outcome: 'MATCHED', match: { technicianId, email: assignee.email! } };
  }
  return { outcome: 'UNKNOWN_ASSIGNEE', misses: assignees };
}

/** Why an inspection was left unassigned, in words the console can show. */
export function unknownAssigneeReason(misses: AssignmentMiss[]): string {
  const named = misses
    .map((miss) => miss.name ?? miss.email)
    .filter(Boolean)
    .join(', ');
  return named
    ? `Jobber assigned ${named}, who is not an active inspection technician here.`
    : 'Jobber named an assignee this app does not recognise.';
}
