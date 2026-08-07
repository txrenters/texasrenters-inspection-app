import { Inject, Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import type { AccountDeletionBlocker, AccountDeletionPreflight } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { IDENTITY_PROVIDER, type IdentityProvider } from './identity-provider';

/**
 * Everything that makes an account undeletable, in one table.
 *
 * Web users and technicians are the same `UserProfile` row, so both delete
 * paths run this list. Kept declarative because the failure mode of splitting
 * it is silent and severe: one path grows a check the other lacks, and the
 * weaker path erases an inspector from the evidence behind a tenant charge.
 *
 * Every entry is a required foreign key that Postgres would refuse anyway.
 * Resolving them here turns a 500 from a constraint violation into an answer
 * that names what exists and how much of it.
 */
const BLOCKERS: {
  kind: AccountDeletionBlocker['kind'];
  noun: [singular: string, plural: string];
  count: (prisma: PrismaService, profileId: string, organizationId: string) => Promise<number>;
}[] = [
  {
    kind: 'MEDIA_CAPTURED',
    noun: ['video capture', 'video captures'],
    count: (prisma, technicianId, organizationId) =>
      prisma.inspectionMedia.count({ where: { technicianId, organizationId } }),
  },
  {
    kind: 'PHOTOS_CAPTURED',
    noun: ['photo', 'photos'],
    count: (prisma, capturedById, organizationId) =>
      prisma.inspectionPhoto.count({ where: { capturedById, organizationId } }),
  },
  {
    // The decision that can put money on a tenant's account. It has to stay
    // attributable to a named human for as long as the charge can be disputed.
    kind: 'FINDINGS_REVIEWED',
    noun: ['reviewed finding', 'reviewed findings'],
    count: (prisma, reviewerId, organizationId) =>
      prisma.findingReview.count({
        where: { reviewerId, finding: { inspection: { organizationId } } },
      }),
  },
  {
    kind: 'INSPECTIONS_FINALIZED',
    noun: ['finalized inspection', 'finalized inspections'],
    count: (prisma, finalizedById, organizationId) =>
      prisma.inspection.count({ where: { finalizedById, organizationId } }),
  },
  {
    kind: 'REPORTS_SHARED',
    noun: ['shared report', 'shared reports'],
    count: (prisma, createdById, organizationId) =>
      prisma.inspectionReportShare.count({ where: { createdById, organizationId } }),
  },
  {
    // Assignments this account handed to *other* people. Deleting the account
    // would take those rows with it and silently unassign technicians who have
    // nothing to do with this deletion. Their own assignments are released
    // deliberately and are not counted here.
    kind: 'WORK_ASSIGNED_TO_OTHERS',
    noun: ['assignment made for another technician', 'assignments made for other technicians'],
    count: (prisma, assignedById, organizationId) =>
      prisma.inspectionAssignment.count({
        where: {
          assignedById,
          technicianId: { not: assignedById },
          inspection: { organizationId },
        },
      }),
  },
];

/**
 * Which surface the caller is deleting from.
 *
 * Web users and technicians share the `UserProfile` table but are governed by
 * different permissions — `users:manage` and `technicians:manage`. Without this,
 * either permission would reach every account in the organization, and the
 * separation the Technicians page relies on would be decorative.
 */
export type ProfileScope = 'CONSOLE' | 'TECHNICIAN';

@Injectable()
export class ProfileDeletionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IDENTITY_PROVIDER) private readonly identities: IdentityProvider,
  ) {}

  /**
   * What deleting this account would cost, resolved before anything is
   * destroyed. The confirmation dialog is built from this, so the numbers an
   * administrator agrees to are the numbers the delete will act on.
   */
  async preflight(
    actor: AuthenticatedUser,
    profileId: string,
    scope: ProfileScope,
  ): Promise<AccountDeletionPreflight> {
    const profile = await this.requireProfile(actor, profileId, scope);
    const organizationId = actor.organizationId;

    const [blockerCounts, ongoingInspections, totalAssignments, roleAssignments, mobileDevices] =
      await Promise.all([
        Promise.all(BLOCKERS.map((blocker) => blocker.count(this.prisma, profile.id, organizationId))),
        this.prisma.inspectionAssignment.count({
          where: { technicianId: profile.id, isCurrent: true, inspection: { organizationId } },
        }),
        this.prisma.inspectionAssignment.count({
          where: { technicianId: profile.id, inspection: { organizationId } },
        }),
        this.prisma.userRoleAssignment.count({
          where: { userProfileId: profile.id, organizationId },
        }),
        this.prisma.mobilePushDevice.count({ where: { userProfileId: profile.id } }),
      ]);

    const blockers = BLOCKERS.map((blocker, index) => ({
      kind: blocker.kind,
      count: blockerCounts[index] ?? 0,
    }))
      .filter((blocker) => blocker.count > 0)
      .map(({ kind, count }) => {
        const [singular, plural] = BLOCKERS.find((entry) => entry.kind === kind)!.noun;
        return { kind, count, label: `${count} ${count === 1 ? singular : plural}` };
      });

    return {
      id: profile.id,
      displayName: profile.displayName,
      email: profile.email,
      canDelete: blockers.length === 0,
      blockers,
      releases: { ongoingInspections, totalAssignments, roleAssignments, mobileDevices },
    };
  }

  /**
   * Delete the account, releasing its assignments.
   *
   * The preflight runs again here rather than trusting the one the dialog was
   * built from: a technician can be handed an inspection, or capture a video,
   * between the confirmation appearing and being accepted.
   */
  async remove(actor: AuthenticatedUser, profileId: string, scope: ProfileScope) {
    const profile = await this.requireProfile(actor, profileId, scope);
    const organizationId = actor.organizationId;
    const preflight = await this.preflight(actor, profileId, scope);

    if (!preflight.canDelete)
      throw new ApplicationError(
        409,
        'ACCOUNT_HAS_HISTORY',
        `This account cannot be deleted because it owns inspection records that must stay attributed to it: ${preflight.blockers
          .map((blocker) => blocker.label)
          .join(', ')}. Deactivate it instead — that revokes access and keeps the record intact.`,
        preflight.blockers,
      );

    const outcome = await this.prisma.$transaction(async (tx) => {
      // Scheduling, not evidence. Removing these rows leaves each inspection
      // with no current assignment, which is exactly the unassigned state the
      // assignment screen offers for reassignment.
      const released = await tx.inspectionAssignment.deleteMany({
        where: { technicianId: profile.id, inspection: { organizationId } },
      });
      await tx.userRoleAssignment.deleteMany({
        where: { userProfileId: profile.id, organizationId },
      });
      await tx.organizationMember.deleteMany({
        where: { userProfileId: profile.id, organizationId },
      });

      // Only destroy the profile once nothing else claims it. A profile shared
      // with another organization keeps its account there and merely loses
      // access here; deleting it outright would evict someone from an
      // organization this administrator has no authority over.
      const remaining = await tx.organizationMember.count({
        where: { userProfileId: profile.id },
      });
      if (remaining === 0) await tx.userProfile.delete({ where: { id: profile.id } });

      // AuditLog.actorUserId carries no foreign key, so this row and every
      // earlier one attributed to this account survive the deletion.
      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: actor.id,
          action: 'ACCOUNT_DELETED',
          entityType: 'UserProfile',
          entityId: profile.id,
          metadata: {
            email: profile.email,
            displayName: profile.displayName,
            releasedInspections: released.count,
            profileRemoved: remaining === 0,
          },
        },
      });
      return { released: released.count, profileRemoved: remaining === 0 };
    });

    // After the transaction commits: the database is the source of truth, and
    // an orphaned sign-in identity is recoverable where a deleted profile with
    // a live identity is not. Reported rather than thrown — the account is
    // already gone, and failing the request would imply otherwise.
    let identityRemoved = false;
    if (outcome.profileRemoved) {
      try {
        await this.identities.deleteIdentity(profile.authUserId);
        identityRemoved = true;
      } catch {
        identityRemoved = false;
      }
    }

    return {
      id: profile.id,
      deleted: true as const,
      deletedAt: new Date().toISOString(),
      releasedInspections: outcome.released,
      identityRemoved,
    };
  }

  /**
   * Resolve the account within the caller's organization.
   *
   * Membership is the ownership boundary: an administrator can only reach an
   * account that belongs to their own organization, whatever id they supply.
   */
  private async requireProfile(
    actor: AuthenticatedUser,
    profileId: string,
    scope: ProfileScope,
  ) {
    if (profileId === actor.id)
      throw new ApplicationError(
        409,
        'CANNOT_DELETE_SELF',
        'You cannot delete your own account.',
      );

    // The scope is part of the lookup rather than a check afterwards, so an
    // account on the wrong surface is simply not found — `technicians:manage`
    // cannot enumerate web users by probing ids for a different error.
    const membership =
      scope === 'TECHNICIAN'
        ? { organizationId: actor.organizationId, role: UserRole.INSPECTION_TECHNICIAN }
        : {
            organizationId: actor.organizationId,
            role: { not: UserRole.INSPECTION_TECHNICIAN },
          };

    const profile = await this.prisma.userProfile.findFirst({
      where: { id: profileId, memberships: { some: membership } },
      select: {
        id: true,
        email: true,
        displayName: true,
        authUserId: true,
        memberships: {
          where: { organizationId: actor.organizationId },
          select: { role: true },
        },
      },
    });
    if (!profile)
      throw new ApplicationError(404, 'ACCOUNT_NOT_FOUND', 'That account was not found.');

    if (profile.memberships.some((membership) => membership.role === UserRole.SYSTEM_ADMIN))
      throw new ApplicationError(
        409,
        'SYSTEM_ADMIN_PROTECTED',
        'A system administrator account cannot be deleted from user management.',
      );

    return profile;
  }
}
