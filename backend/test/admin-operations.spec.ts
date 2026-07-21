import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { AdminService } from '../src/admin/admin.service';
import { TechnicianProvisioningService } from '../src/admin/technician-provisioning.service';

const user: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-property-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Property Admin',
  roles: [UserRole.PROPERTY_ADMIN],
  mustChangePassword: false,
};

describe('administrator catalog operations', () => {
  it('paginates and searches active portfolios without loading the full catalog', async () => {
    const items = [{ id: 'portfolio-11', name: 'Austin Residential' }];
    const prisma = {
      propertywarePortfolio: {
        findMany: jest.fn().mockResolvedValue(items),
        count: jest.fn().mockResolvedValue(21),
      },
      $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    };
    const service = new AdminService(prisma as never);

    await expect(
      service.portfolios(user, { page: 2, pageSize: 10, search: 'Austin' }),
    ).resolves.toEqual({ items, page: 2, pageSize: 10, total: 21, totalPages: 3 });
    expect(prisma.propertywarePortfolio.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 10,
        take: 10,
        where: expect.objectContaining({
          organizationId: user.organizationId,
          isActive: true,
          OR: expect.any(Array),
        }),
      }),
    );
  });

  it('batches technician workload counts and scopes them to the administrator organization', async () => {
    const profiles = [
      {
        id: 'technician-1',
        email: 'one@example.com',
        displayName: 'Technician One',
        isActive: true,
        createdAt: new Date(),
      },
      {
        id: 'technician-2',
        email: 'two@example.com',
        displayName: 'Technician Two',
        isActive: true,
        createdAt: new Date(),
      },
    ];
    const groupBy = jest
      .fn()
      .mockResolvedValueOnce([{ technicianId: 'technician-1', _count: { _all: 2 } }])
      .mockResolvedValueOnce([{ technicianId: 'technician-1', _count: { _all: 1 } }])
      .mockResolvedValueOnce([{ technicianId: 'technician-2', _count: { _all: 3 } }]);
    const prisma = {
      userProfile: {
        findMany: jest.fn().mockResolvedValue(profiles),
        count: jest.fn().mockResolvedValue(2),
      },
      inspectionAssignment: { groupBy },
    };
    const service = new AdminService(prisma as never);

    const result = await service.technicians(user, { page: 1, pageSize: 20 });

    expect(groupBy).toHaveBeenCalledTimes(3);
    for (const [request] of groupBy.mock.calls) {
      expect(request.where.inspection.organizationId).toBe(user.organizationId);
      expect(request.where.technicianId.in).toEqual(['technician-1', 'technician-2']);
    }
    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'technician-1',
        workload: { current: 2, inProgress: 1, completed: 0 },
      }),
      expect.objectContaining({
        id: 'technician-2',
        workload: { current: 0, inProgress: 0, completed: 3 },
      }),
    ]);
  });
});

describe('administrator inspection operations', () => {
  it('paginates the inspection audit trail without exposing audit metadata', async () => {
    const event = { id: 'audit-1', action: 'INSPECTION_CREATED', createdAt: new Date() };
    const prisma = {
      auditLog: {
        findMany: jest.fn().mockResolvedValue([event]),
        count: jest.fn().mockResolvedValue(21),
      },
    };
    const service = new AdminService(prisma as never);

    await expect(
      service.inspectionAudit(user, 'inspection-1', { page: 2, pageSize: 20 }),
    ).resolves.toEqual({ items: [event], page: 2, pageSize: 20, total: 21, totalPages: 2 });
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: user.organizationId,
        entityType: 'Inspection',
        entityId: 'inspection-1',
      },
      orderBy: { createdAt: 'desc' },
      skip: 20,
      take: 20,
      select: { id: true, action: true, createdAt: true },
    });
  });

  it('creates a scheduled building-level inspection when no unit is available', async () => {
    const property = {
      id: 'property-1',
      organizationId: user.organizationId,
      externalId: 'pw-building-1',
      name: 'Active Property',
      addressLine1: '100 Main Street',
      addressLine2: null,
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      portfolio: { id: 'portfolio-1', name: 'Active Portfolio', isActive: true },
      isActive: true,
    };
    const created = { id: 'inspection-1', status: 'SCHEDULED' };
    const tx = {
      propertywareBuilding: { findFirst: jest.fn().mockResolvedValue(property) },
      propertywareUnit: { findFirst: jest.fn() },
      propertywareLease: { findFirst: jest.fn() },
      propertyArea: {
        findMany: jest.fn().mockResolvedValue([{ id: 'area-1' }, { id: 'area-2' }]),
      },
      inspection: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(created),
        findUnique: jest.fn().mockResolvedValue({ ...created, assignments: [] }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new AdminService(prisma as never);

    await service.createInspection(user, {
      propertyId: property.id,
      scheduledAt: '2026-08-01T15:00:00.000Z',
      inspectionType: 'MOVE_IN',
      priority: 'STANDARD',
    });

    expect(tx.propertywareUnit.findFirst).not.toHaveBeenCalled();
    expect(tx.propertywareLease.findFirst).not.toHaveBeenCalled();
    expect(tx.inspection.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        propertywareBuildingId: property.id,
        propertywareUnitId: undefined,
        leaseSnapshot: expect.anything(),
        propertySnapshot: expect.objectContaining({ unit: null }),
        areas: {
          create: [{ propertyAreaId: 'area-1' }, { propertyAreaId: 'area-2' }],
        },
      }),
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'INSPECTION_CREATED' }) }),
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: 15_000, maxWait: 5_000 }),
    );
  });

  it('requires a completed move-in baseline before an occupied inspection', async () => {
    const property = {
      id: 'property-1',
      organizationId: user.organizationId,
      externalId: 'pw-building-1',
      name: 'Active Property',
      addressLine1: '100 Main Street',
      addressLine2: null,
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      portfolio: { id: 'portfolio-1', name: 'Active Portfolio', isActive: true },
      isActive: true,
    };
    const tx = {
      propertywareBuilding: { findFirst: jest.fn().mockResolvedValue(property) },
      propertywareUnit: { findFirst: jest.fn() },
      propertywareLease: { findFirst: jest.fn() },
      propertyArea: { findMany: jest.fn() },
      inspection: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new AdminService(prisma as never);

    await expect(
      service.createInspection(user, {
        propertyId: property.id,
        scheduledAt: '2026-08-01T15:00:00.000Z',
        inspectionType: 'OCCUPIED',
        priority: 'STANDARD',
      }),
    ).rejects.toMatchObject({ code: 'MOVE_IN_BASELINE_REQUIRED', status: 409 });
    expect(tx.inspection.create).not.toHaveBeenCalled();
  });

  it('links an occupied inspection to its completed move-in baseline', async () => {
    const property = {
      id: 'property-1',
      organizationId: user.organizationId,
      externalId: 'pw-building-1',
      name: 'Active Property',
      addressLine1: '100 Main Street',
      addressLine2: null,
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      portfolio: { id: 'portfolio-1', name: 'Active Portfolio', isActive: true },
      isActive: true,
    };
    const tx = {
      propertywareBuilding: { findFirst: jest.fn().mockResolvedValue(property) },
      propertywareUnit: { findFirst: jest.fn() },
      propertywareLease: { findFirst: jest.fn() },
      propertyArea: { findMany: jest.fn().mockResolvedValue([{ id: 'area-1' }]) },
      inspection: {
        findFirst: jest.fn().mockResolvedValueOnce({ id: 'move-in-1' }).mockResolvedValueOnce(null),
        create: jest.fn().mockResolvedValue({ id: 'occupied-1' }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new AdminService(prisma as never);

    await service.createInspection(user, {
      propertyId: property.id,
      scheduledAt: '2026-08-01T15:00:00.000Z',
      inspectionType: 'OCCUPIED',
      priority: 'STANDARD',
    });

    expect(tx.inspection.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inspectionType: 'OCCUPIED',
        baselineInspectionId: 'move-in-1',
      }),
    });
  });

  it.each([
    ['BACK_TO_MARKET', 'OCCUPIED'],
    ['MOVE_OUT', 'BACK_TO_MARKET'],
  ] as const)(
    'requires a completed %s predecessor after the move-in baseline',
    async (inspectionType, requiredPredecessor) => {
      const property = {
        id: 'property-1',
        organizationId: user.organizationId,
        externalId: 'pw-building-1',
        name: 'Active Property',
        addressLine1: '100 Main Street',
        addressLine2: null,
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        portfolio: { id: 'portfolio-1', name: 'Active Portfolio', isActive: true },
        isActive: true,
      };
      const tx = {
        propertywareBuilding: { findFirst: jest.fn().mockResolvedValue(property) },
        propertywareUnit: { findFirst: jest.fn() },
        propertywareLease: { findFirst: jest.fn() },
        propertyArea: { findMany: jest.fn() },
        inspection: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce({ id: 'move-in-1' })
            .mockResolvedValueOnce(null),
          create: jest.fn(),
        },
      };
      const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
      const service = new AdminService(prisma as never);

      await expect(
        service.createInspection(user, {
          propertyId: property.id,
          scheduledAt: '2026-08-01T15:00:00.000Z',
          inspectionType,
          priority: 'STANDARD',
        }),
      ).rejects.toMatchObject({
        code: 'INSPECTION_SEQUENCE_REQUIRED',
        message: expect.stringContaining(requiredPredecessor.toLowerCase().replaceAll('_', ' ')),
        status: 409,
      });
      expect(tx.inspection.create).not.toHaveBeenCalled();
    },
  );

  it('rejects assignment after an inspection is finalized', async () => {
    const tx = {
      inspection: {
        findFirst: jest.fn().mockResolvedValue({ id: 'inspection-1', status: 'COMPLETED' }),
      },
      inspectionAssignment: { findFirst: jest.fn(), create: jest.fn() },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new AdminService(prisma as never);

    await expect(
      service.assign(user, 'inspection-1', { technicianId: 'technician-1' }),
    ).rejects.toMatchObject({ code: 'INSPECTION_NOT_ASSIGNABLE', status: 409 });
    expect(tx.inspectionAssignment.create).not.toHaveBeenCalled();
  });

  it('cancels an inspection and closes its current assignment in one transaction', async () => {
    const existing = {
      id: 'inspection-1',
      status: 'SCHEDULED',
      propertywareBuildingId: 'property-1',
      propertywareUnitId: null,
    };
    const tx = {
      inspection: {
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({ ...existing, status: 'CANCELLED' }),
      },
      inspectionAssignment: {
        findFirst: jest.fn().mockResolvedValue({ id: 'assignment-1' }),
        update: jest.fn().mockResolvedValue({ id: 'assignment-1', isCurrent: false }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const prisma = {
      inspection: { findFirst: jest.fn().mockResolvedValue(existing) },
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new AdminService(prisma as never);

    await service.updateInspection(user, existing.id, {
      status: 'CANCELLED',
      cancellationReason: 'Resident extended the lease',
    });

    expect(tx.inspectionAssignment.update).toHaveBeenCalledWith({
      where: { id: 'assignment-1' },
      data: expect.objectContaining({
        isCurrent: false,
        status: 'UNASSIGNED',
        endedById: user.id,
      }),
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'INSPECTION_CANCELLED' }),
      }),
    );
  });

  it('rejects unassignment after an inspection is finalized', async () => {
    const tx = {
      inspection: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'inspection-1',
          status: 'COMPLETED',
        }),
      },
      inspectionAssignment: { findFirst: jest.fn(), update: jest.fn() },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new AdminService(prisma as never);

    await expect(
      service.unassign(user, 'inspection-1', { reason: 'Schedule changed' }),
    ).rejects.toMatchObject({ status: 409, code: 'INSPECTION_NOT_ASSIGNABLE' });
    expect(tx.inspectionAssignment.findFirst).not.toHaveBeenCalled();
  });
});

describe('administrator assignment operations', () => {
  it('filters assignment history by inspection and skips the unassigned query when requested', async () => {
    const prisma = {
      inspectionAssignment: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      inspection: { findMany: jest.fn(), count: jest.fn() },
    };
    const service = new AdminService(prisma as never);

    await expect(
      service.assignments(user, {
        page: 1,
        pageSize: 20,
        inspectionId: 'inspection-1',
        includeUnassigned: 'false',
      }),
    ).resolves.toMatchObject({ items: [], total: 0 });
    expect(prisma.inspectionAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          inspection: expect.objectContaining({
            id: 'inspection-1',
            organizationId: user.organizationId,
          }),
        }),
      }),
    );
    expect(prisma.inspection.findMany).not.toHaveBeenCalled();
  });

  it('lists inspections without a current assignment under the unassigned filter', async () => {
    const inspection = {
      id: 'inspection-unassigned',
      status: 'SCHEDULED',
      inspectionType: 'MOVE_OUT',
      priority: 'STANDARD',
      scheduledAt: new Date('2026-08-01T15:00:00.000Z'),
      createdAt: new Date('2026-07-21T10:00:00.000Z'),
      updatedAt: new Date('2026-07-21T10:00:00.000Z'),
      internalNotes: null,
      propertywareBuilding: { id: 'building-1', name: '100 Main Street' },
      propertywareUnit: { id: 'unit-1', name: 'Unit A' },
      assignments: [],
    };
    const prisma = {
      inspection: {
        findMany: jest.fn().mockResolvedValue([inspection]),
        count: jest.fn().mockResolvedValue(1),
      },
      inspectionAssignment: { findMany: jest.fn(), count: jest.fn() },
    };
    const service = new AdminService(prisma as never);

    await expect(
      service.assignments(user, {
        page: 1,
        pageSize: 20,
        assignmentStatus: 'UNASSIGNED',
      }),
    ).resolves.toMatchObject({
      total: 1,
      items: [
        {
          id: 'unassigned:inspection-unassigned',
          inspectionId: 'inspection-unassigned',
          recordType: 'UNASSIGNED_INSPECTION',
          status: 'UNASSIGNED',
          technicianId: null,
        },
      ],
    });
    expect(prisma.inspection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: user.organizationId,
          assignments: { none: { isCurrent: true } },
        }),
      }),
    );
    expect(prisma.inspectionAssignment.findMany).not.toHaveBeenCalled();
  });

  it('publishes an assignment event only after the transaction succeeds', async () => {
    const assignment = { id: 'assignment-1', technicianId: 'technician-1' };
    const tx = {
      inspection: {
        findFirst: jest.fn().mockResolvedValue({ id: 'inspection-1', status: 'SCHEDULED' }),
      },
      inspectionAssignment: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(assignment),
      },
      userProfile: { findFirst: jest.fn().mockResolvedValue({ id: 'technician-1' }) },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const events = { publish: jest.fn() };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new AdminService(prisma as never, events as never);

    await expect(
      service.assign(user, 'inspection-1', { technicianId: 'technician-1' }),
    ).resolves.toBe(assignment);
    expect(events.publish).toHaveBeenCalledWith('technician-1', 'inspection-1', 'ASSIGNED');
    expect(events.publish.mock.invocationCallOrder[0]).toBeGreaterThan(
      prisma.$transaction.mock.invocationCallOrder[0]!,
    );
  });

  it('atomically closes the current assignment and appends its successor', async () => {
    const current = {
      id: 'assignment-old',
      inspectionId: 'inspection-1',
      technicianId: 'technician-old',
    };
    const tx = {
      inspection: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'inspection-1',
          status: 'SCHEDULED',
        }),
      },
      inspectionAssignment: {
        findFirst: jest.fn().mockResolvedValue(current),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({ ...current, isCurrent: false }),
        create: jest.fn().mockResolvedValue({
          id: 'assignment-new',
          technicianId: 'technician-new',
          supersedesId: current.id,
        }),
      },
      userProfile: { findFirst: jest.fn().mockResolvedValue({ id: 'technician-new' }) },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new AdminService(prisma as never);

    await service.reassign(user, 'inspection-1', {
      technicianId: 'technician-new',
      reason: 'Coverage change',
      idempotencyKey: 'request-1',
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.inspectionAssignment.update).toHaveBeenCalledWith({
      where: { id: current.id },
      data: expect.objectContaining({ isCurrent: false, status: 'REASSIGNED', endedById: user.id }),
    });
    expect(tx.inspectionAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          inspectionId: 'inspection-1',
          technicianId: 'technician-new',
          assignedById: user.id,
          supersedesId: current.id,
        }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'INSPECTION_REASSIGNED' }),
      }),
    );
  });

  it('returns the original assignment when an idempotent request is replayed', async () => {
    const assignment = {
      id: 'assignment-1',
      inspectionId: 'inspection-1',
      technicianId: 'technician-1',
      inspection: { organizationId: user.organizationId },
    };
    const tx = {
      inspection: { findFirst: jest.fn() },
      inspectionAssignment: {
        findUnique: jest.fn().mockResolvedValue(assignment),
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const events = { publish: jest.fn() };
    const service = new AdminService(prisma as never, events as never);

    await expect(
      service.assign(user, assignment.inspectionId, {
        technicianId: assignment.technicianId,
        idempotencyKey: 'request-1',
      }),
    ).resolves.toBe(assignment);
    expect(tx.inspection.findFirst).not.toHaveBeenCalled();
    expect(tx.inspectionAssignment.create).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('rejects deactivation while a technician owns current assignments', async () => {
    const prisma = {
      userProfile: {
        findFirst: jest.fn().mockResolvedValue({ id: 'technician-1', isActive: true }),
        update: jest.fn(),
      },
      inspectionAssignment: { count: jest.fn().mockResolvedValue(2) },
    };
    const service = new AdminService(prisma as never);

    await expect(
      service.updateTechnicianStatus(user, 'technician-1', { isActive: false }),
    ).rejects.toMatchObject({ code: 'TECHNICIAN_HAS_ACTIVE_ASSIGNMENTS', status: 409 });
    expect(prisma.userProfile.update).not.toHaveBeenCalled();
  });

  it('returns a compact technician profile with a current-assignment count', async () => {
    const prisma = {
      userProfile: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'technician-1',
          email: 'tech@example.com',
          displayName: 'Field Technician',
          isActive: true,
          createdAt: new Date(),
          _count: { assignments: 3 },
        }),
      },
    };
    const service = new AdminService(prisma as never);

    const result = await service.technician(user, 'technician-1');

    expect(result).toMatchObject({ id: 'technician-1', workload: { current: 3 } });
    expect(result).not.toHaveProperty('_count');
    expect(prisma.userProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          id: true,
          _count: { select: { assignments: { where: { isCurrent: true } } } },
        }),
      }),
    );
  });
});

describe('technician account provisioning', () => {
  it('claims the auth-triggered profile and creates membership without auditing the password', async () => {
    const createdAt = new Date();
    const tx = {
      userProfile: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'technician-1',
          authUserId: 'auth-tech-1',
          email: 'tech@example.com',
        }),
        update: jest.fn().mockResolvedValue({
          id: 'technician-1',
          email: 'tech@example.com',
          displayName: 'Field Technician',
          isActive: true,
          createdAt,
        }),
        create: jest.fn(),
      },
      organizationMember: { upsert: jest.fn().mockResolvedValue({ id: 'membership-1' }) },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const prisma = {
      userProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    };
    const identities = {
      createTechnicianIdentity: jest.fn().mockResolvedValue({ authUserId: 'auth-tech-1' }),
      deleteIdentity: jest.fn(),
    };
    const service = new TechnicianProvisioningService(prisma as never, identities as never);

    const result = await service.create(user, {
      email: ' Tech@Example.com ',
      displayName: ' Field Technician ',
    });

    expect(identities.createTechnicianIdentity).toHaveBeenCalledWith(
      'tech@example.com',
      expect.stringMatching(/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[!@#$%]).{8}$/),
      'Field Technician',
    );
    expect(tx.userProfile.update).toHaveBeenCalledWith({
      where: { id: 'technician-1' },
      data: {
        email: 'tech@example.com',
        displayName: 'Field Technician',
        isActive: true,
      },
    });
    expect(tx.organizationMember.upsert).toHaveBeenCalledWith({
      where: {
        organizationId_userProfileId_role: {
          organizationId: user.organizationId,
          userProfileId: 'technician-1',
          role: UserRole.INSPECTION_TECHNICIAN,
        },
      },
      update: {},
      create: {
        organizationId: user.organizationId,
        userProfileId: 'technician-1',
        role: UserRole.INSPECTION_TECHNICIAN,
      },
    });
    expect(tx.userProfile.create).not.toHaveBeenCalled();
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain(result.temporaryPassword);
    expect(result).toMatchObject({ mustChangePassword: true, email: 'tech@example.com' });
  });

  it('repairs a profile orphaned by a prior compensated identity', async () => {
    const createdAt = new Date();
    const tx = {
      userProfile: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'technician-new',
          authUserId: 'auth-tech-new',
        }),
        update: jest.fn().mockResolvedValue({
          id: 'technician-new',
          email: 'tech@example.com',
          displayName: 'Field Technician',
          isActive: true,
          createdAt,
        }),
        create: jest.fn(),
      },
      organizationMember: { upsert: jest.fn().mockResolvedValue({ id: 'membership-new' }) },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-new' }) },
    };
    const prisma = {
      userProfile: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'orphan-profile',
          authUserId: 'deleted-auth-user',
          memberships: [],
        }),
        delete: jest.fn().mockResolvedValue({ id: 'orphan-profile' }),
      },
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    };
    const identities = {
      identityExists: jest.fn().mockResolvedValue(false),
      createTechnicianIdentity: jest.fn().mockResolvedValue({ authUserId: 'auth-tech-new' }),
      deleteIdentity: jest.fn(),
    };
    const service = new TechnicianProvisioningService(prisma as never, identities as never);

    await expect(
      service.create(user, { email: 'tech@example.com', displayName: 'Field Technician' }),
    ).resolves.toMatchObject({ id: 'technician-new', mustChangePassword: true });
    expect(identities.identityExists).toHaveBeenCalledWith('deleted-auth-user');
    expect(prisma.userProfile.delete).toHaveBeenCalledWith({ where: { id: 'orphan-profile' } });
  });

  it('does not repair a profile while its Supabase identity still exists', async () => {
    const prisma = {
      userProfile: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'existing-profile',
          authUserId: 'existing-auth-user',
          memberships: [],
        }),
        delete: jest.fn(),
      },
    };
    const identities = {
      identityExists: jest.fn().mockResolvedValue(true),
      createTechnicianIdentity: jest.fn(),
    };
    const service = new TechnicianProvisioningService(prisma as never, identities as never);

    await expect(
      service.create(user, { email: 'tech@example.com', displayName: 'Field Technician' }),
    ).rejects.toMatchObject({ status: 409, code: 'TECHNICIAN_EMAIL_EXISTS' });
    expect(prisma.userProfile.delete).not.toHaveBeenCalled();
    expect(identities.createTechnicianIdentity).not.toHaveBeenCalled();
  });

  it('removes the external identity when local provisioning fails', async () => {
    const prisma = {
      userProfile: {
        findUnique: jest.fn().mockResolvedValue(null),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn().mockRejectedValue(new Error('database unavailable')),
    };
    const identities = {
      createTechnicianIdentity: jest.fn().mockResolvedValue({ authUserId: 'auth-tech-2' }),
      deleteIdentity: jest.fn().mockResolvedValue(undefined),
    };
    const service = new TechnicianProvisioningService(prisma as never, identities as never);

    await expect(
      service.create(user, { email: 'tech@example.com', displayName: 'Field Technician' }),
    ).rejects.toThrow('database unavailable');
    expect(identities.deleteIdentity).toHaveBeenCalledWith('auth-tech-2');
    expect(prisma.userProfile.deleteMany).toHaveBeenCalledWith({
      where: {
        authUserId: 'auth-tech-2',
        memberships: { none: {} },
      },
    });
  });
});
