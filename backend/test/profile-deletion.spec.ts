import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import type { ApplicationError } from '../src/common/errors';
import { ProfileDeletionService } from '../src/admin/profile-deletion.service';

const ORG = '10000000-0000-4000-8000-000000000001';
const OTHER_ORG = '10000000-0000-4000-8000-0000000000ff';
const ACTOR_ID = '10000000-0000-4000-8000-000000000002';
const TARGET_ID = '10000000-0000-4000-8000-000000000003';

const actor: AuthenticatedUser = {
  id: ACTOR_ID,
  authUserId: 'auth-admin',
  organizationId: ORG,
  displayName: 'System Admin',
  roles: [UserRole.SYSTEM_ADMIN],
  permissions: ['users:manage', 'technicians:manage'],
  mustChangePassword: false,
};

interface Counts {
  media?: number;
  photos?: number;
  reviews?: number;
  finalized?: number;
  shares?: number;
  assignedForOthers?: number;
  ongoing?: number;
  totalAssignments?: number;
  roleAssignments?: number;
  devices?: number;
  /** Memberships left after this organization's are removed. */
  remainingMemberships?: number;
}

function profileRecord(role: UserRole = UserRole.INSPECTION_TECHNICIAN) {
  return {
    id: TARGET_ID,
    email: 'tech@example.com',
    displayName: 'Field Tech',
    authUserId: 'auth-tech',
    memberships: [{ role }],
  };
}

function prismaFor(counts: Counts, profile: unknown = profileRecord()) {
  const tx = {
    inspectionAssignment: {
      deleteMany: jest.fn().mockResolvedValue({ count: counts.totalAssignments ?? 0 }),
    },
    userRoleAssignment: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    organizationMember: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(counts.remainingMemberships ?? 0),
    },
    userProfile: { delete: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    userProfile: { findFirst: jest.fn().mockResolvedValue(profile), delete: jest.fn() },
    inspectionMedia: { count: jest.fn().mockResolvedValue(counts.media ?? 0) },
    inspectionPhoto: { count: jest.fn().mockResolvedValue(counts.photos ?? 0) },
    findingReview: { count: jest.fn().mockResolvedValue(counts.reviews ?? 0) },
    inspection: { count: jest.fn().mockResolvedValue(counts.finalized ?? 0) },
    inspectionReportShare: { count: jest.fn().mockResolvedValue(counts.shares ?? 0) },
    userRoleAssignment: { count: jest.fn().mockResolvedValue(counts.roleAssignments ?? 0) },
    mobilePushDevice: { count: jest.fn().mockResolvedValue(counts.devices ?? 0) },
    inspectionAssignment: {
      // Three different questions share this table, told apart by their filter:
      // work this account handed to others, its own live assignments, and its
      // assignments overall.
      count: jest.fn((args: { where: Record<string, unknown> }) => {
        if ('assignedById' in args.where) return Promise.resolve(counts.assignedForOthers ?? 0);
        if (args.where.isCurrent === true) return Promise.resolve(counts.ongoing ?? 0);
        return Promise.resolve(counts.totalAssignments ?? 0);
      }),
    },
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  return { prisma, tx };
}

const identitiesOk = () => ({ deleteIdentity: jest.fn().mockResolvedValue(undefined) });

function serviceFor(counts: Counts, profile?: unknown, identities = identitiesOk()) {
  const { prisma, tx } = prismaFor(counts, profile);
  return {
    service: new ProfileDeletionService(prisma as never, identities as never),
    prisma,
    tx,
    identities,
  };
}

describe('deletion preflight', () => {
  it('reports a clean account as deletable', async () => {
    const { service } = serviceFor({});
    const preflight = await service.preflight(actor, TARGET_ID, 'TECHNICIAN');
    expect(preflight.canDelete).toBe(true);
    expect(preflight.blockers).toEqual([]);
  });

  it('counts ongoing inspections as released, not as a blocker', async () => {
    // Assignments are scheduling. Releasing them returns the inspection to the
    // pool, which is the whole point of allowing the delete rather than
    // refusing it.
    const { service } = serviceFor({ ongoing: 3, totalAssignments: 5 });
    const preflight = await service.preflight(actor, TARGET_ID, 'TECHNICIAN');
    expect(preflight.canDelete).toBe(true);
    expect(preflight.releases.ongoingInspections).toBe(3);
    expect(preflight.releases.totalAssignments).toBe(5);
  });

  it('names each kind of evidence with its count', async () => {
    const { service } = serviceFor({ media: 42, reviews: 1 });
    const preflight = await service.preflight(actor, TARGET_ID, 'TECHNICIAN');
    expect(preflight.canDelete).toBe(false);
    expect(preflight.blockers).toEqual([
      { kind: 'MEDIA_CAPTURED', count: 42, label: '42 video captures' },
      { kind: 'FINDINGS_REVIEWED', count: 1, label: '1 reviewed finding' },
    ]);
  });
});

describe('account deletion', () => {
  it('releases assignments and removes the profile and its identity', async () => {
    const { service, tx, identities } = serviceFor({ ongoing: 2, totalAssignments: 2 });
    const result = await service.remove(actor, TARGET_ID, 'TECHNICIAN');

    expect(result.deleted).toBe(true);
    expect(result.releasedInspections).toBe(2);
    expect(result.identityRemoved).toBe(true);
    expect(tx.inspectionAssignment.deleteMany).toHaveBeenCalled();
    expect(tx.userProfile.delete).toHaveBeenCalledWith({ where: { id: TARGET_ID } });
    expect(identities.deleteIdentity).toHaveBeenCalledWith('auth-tech');
  });

  it('refuses an account that captured evidence, and destroys nothing', async () => {
    // The refusal is the feature: this technician's name is on video that may
    // justify a charge against a tenant.
    const { service, tx, identities } = serviceFor({ media: 12, photos: 4 });
    await expect(service.remove(actor, TARGET_ID, 'TECHNICIAN')).rejects.toMatchObject({
      code: 'ACCOUNT_HAS_HISTORY',
    });
    expect(tx.userProfile.delete).not.toHaveBeenCalled();
    expect(tx.inspectionAssignment.deleteMany).not.toHaveBeenCalled();
    expect(identities.deleteIdentity).not.toHaveBeenCalled();
  });

  it('says what is blocking rather than only that something is', async () => {
    const { service } = serviceFor({ reviews: 3 });
    await expect(service.remove(actor, TARGET_ID, 'TECHNICIAN')).rejects.toThrow(
      /3 reviewed findings/,
    );
  });

  it('refuses when the account assigned work to other technicians', async () => {
    // Those rows carry other people's assignments; deleting this account would
    // take them along and silently unassign technicians who are not involved.
    const { service, tx } = serviceFor({ assignedForOthers: 7 });
    await expect(service.remove(actor, TARGET_ID, 'CONSOLE')).rejects.toMatchObject({
      code: 'ACCOUNT_HAS_HISTORY',
    });
    expect(tx.userProfile.delete).not.toHaveBeenCalled();
  });

  it('refuses to delete the caller', async () => {
    const { service } = serviceFor({});
    await expect(service.remove(actor, ACTOR_ID, 'CONSOLE')).rejects.toMatchObject({
      code: 'CANNOT_DELETE_SELF',
    });
  });

  it('refuses to delete a system administrator', async () => {
    const { service } = serviceFor({}, profileRecord(UserRole.SYSTEM_ADMIN));
    await expect(service.remove(actor, TARGET_ID, 'CONSOLE')).rejects.toMatchObject({
      code: 'SYSTEM_ADMIN_PROTECTED',
    });
  });

  it('scopes the lookup to the surface the caller is deleting from', async () => {
    // `technicians:manage` must not reach a web user, and vice versa. The scope
    // is part of the query, so the wrong surface yields a plain not-found.
    const { service, prisma } = serviceFor({});
    await service.preflight(actor, TARGET_ID, 'TECHNICIAN');
    expect(prisma.userProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          memberships: { some: expect.objectContaining({ role: UserRole.INSPECTION_TECHNICIAN }) },
        }),
      }),
    );

    const console = serviceFor({});
    await console.service.preflight(actor, TARGET_ID, 'CONSOLE');
    expect(console.prisma.userProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          memberships: {
            some: expect.objectContaining({ role: { not: UserRole.INSPECTION_TECHNICIAN } }),
          },
        }),
      }),
    );
  });

  it('reports an account outside the organization as not found', async () => {
    const { service } = serviceFor({}, null);
    await expect(service.remove(actor, TARGET_ID, 'CONSOLE')).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
  });

  it('keeps a profile that another organization still claims', async () => {
    // Revoking access here must not evict someone from an organization this
    // administrator has no authority over — and their sign-in must survive.
    const { service, tx, identities } = serviceFor({ remainingMemberships: 1 });
    const result = await service.remove(actor, TARGET_ID, 'CONSOLE');
    expect(tx.organizationMember.deleteMany).toHaveBeenCalled();
    expect(tx.userProfile.delete).not.toHaveBeenCalled();
    expect(identities.deleteIdentity).not.toHaveBeenCalled();
    expect(result.identityRemoved).toBe(false);
  });

  it('reports a stranded identity instead of failing a completed deletion', async () => {
    // The profile is already gone; throwing here would tell the administrator
    // the delete failed when it did not. The flag is how they learn the address
    // is still claimed upstream.
    const identities = { deleteIdentity: jest.fn().mockRejectedValue(new Error('upstream down')) };
    const { service, tx } = serviceFor({}, undefined, identities);
    const result = await service.remove(actor, TARGET_ID, 'CONSOLE');
    expect(tx.userProfile.delete).toHaveBeenCalled();
    expect(result.deleted).toBe(true);
    expect(result.identityRemoved).toBe(false);
  });

  it('writes an audit event that outlives the account', async () => {
    // AuditLog.actorUserId carries no foreign key, which is what lets the
    // record survive the profile it refers to.
    const { service, tx } = serviceFor({ ongoing: 1, totalAssignments: 1 });
    await service.remove(actor, TARGET_ID, 'TECHNICIAN');
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'ACCOUNT_DELETED',
        entityType: 'UserProfile',
        entityId: TARGET_ID,
        metadata: expect.objectContaining({
          email: 'tech@example.com',
          releasedInspections: 1,
          profileRemoved: true,
        }),
      }),
    });
  });

  it('carries the blocker list on the error for the caller to render', async () => {
    const { service } = serviceFor({ finalized: 2 });
    await service.remove(actor, TARGET_ID, 'CONSOLE').catch((error: ApplicationError) => {
      expect(error.details).toEqual([
        { kind: 'INSPECTIONS_FINALIZED', count: 2, label: '2 finalized inspections' },
      ]);
    });
    expect.assertions(1);
  });
});

describe('organization scoping', () => {
  it('never counts another organization when deciding what blocks a delete', async () => {
    // A count that forgot its organization filter would refuse deletions over
    // records the administrator cannot even see.
    const { service, prisma } = serviceFor({});
    await service.preflight(actor, TARGET_ID, 'TECHNICIAN');
    for (const table of [
      prisma.inspectionMedia,
      prisma.inspectionPhoto,
      prisma.inspection,
      prisma.inspectionReportShare,
    ]) {
      expect(table.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG }) }),
      );
    }
    expect(prisma.findingReview.count).toHaveBeenCalledWith({
      where: { reviewerId: TARGET_ID, finding: { inspection: { organizationId: ORG } } },
    });
    expect(OTHER_ORG).not.toBe(ORG);
  });
});
