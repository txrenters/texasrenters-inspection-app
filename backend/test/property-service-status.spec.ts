import { InspectionStatus, InspectionType, TbpStopStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../src/common/auth';
import { PropertyServiceStatusService } from '../src/planning/property-service-status.service';

/**
 * The two switches on a property's Details tab (the office, 2026-10-08):
 * "owner ended the management" stops everything booked there, "opted out of the
 * benefit package" only the quarterly occupied and HVAC visits. People and
 * places invented.
 */

/** Thursday 8 October 2026, ten in the morning in Texas. */
const NOW = new Date('2026-10-08T15:00:00Z');

const date = (value: string) => new Date(`${value}T00:00:00.000Z`);

const office: AuthenticatedUser = {
  id: 'user-1',
  authUserId: 'auth-1',
  organizationId: 'org-1',
  displayName: 'Pat Office',
  roles: [],
  permissions: ['properties:read', 'properties:manage', 'inspections:read'],
  mustChangePassword: false,
  principalType: 'USER',
};

type Switches = {
  managementEndedAt?: Date | null;
  tbpOptedOutAt?: Date | null;
};

const statusRow = (switches: Switches | null) =>
  switches
    ? {
        managementEndedAt: switches.managementEndedAt ?? null,
        tbpOptedOutAt: switches.tbpOptedOutAt ?? null,
        managementEndedBy: switches.managementEndedAt ? { id: 'user-1', displayName: 'Pat Office' } : null,
        tbpOptedOutBy: switches.tbpOptedOutAt ? { id: 'user-1', displayName: 'Pat Office' } : null,
      }
    : null;

function build(options: { before?: Switches | null; after?: Switches | null; scheduleOn?: boolean; stillBooked?: unknown[] } = {}) {
  const tx = {
    propertyServiceStatus: { upsert: jest.fn().mockResolvedValue({}) },
    tbpQuarterPlanStop: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    propertywareBuilding: {
      findFirst: jest
        .fn()
        .mockResolvedValueOnce({ id: 'building-1', serviceStatus: statusRow(options.before ?? null) })
        .mockResolvedValue({ id: 'building-1', serviceStatus: statusRow(options.after ?? options.before ?? null) }),
    },
    inspection: { findMany: jest.fn().mockResolvedValue(options.stillBooked ?? []) },
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  const leases = {
    run: jest.fn().mockResolvedValue({ counts: { BOOK: 0, ALREADY_BOOKED: 0, NEEDS_UNIT: 0, NOT_BOOKABLE: 0, MOVE: 0, CALL_OFF: 1 } }),
  };
  const schedule = { describe: jest.fn().mockReturnValue({ enabled: options.scheduleOn ?? true }) };
  const cache = { bump: jest.fn() };
  const service = new PropertyServiceStatusService(prisma as never, leases as never, schedule as never, cache as never);
  return { service, prisma, tx, leases, cache };
}

describe('the owner ended the management', () => {
  it('is recorded with who and when, audited, and the lease schedule runs for the property at once', async () => {
    const { service, tx, leases, cache } = build({ after: { managementEndedAt: NOW } });

    const change = await service.set(office, 'building-1', { managementEnded: true }, NOW);

    expect(tx.propertyServiceStatus.upsert).toHaveBeenCalledWith({
      where: { buildingId: 'building-1' },
      create: { organizationId: 'org-1', buildingId: 'building-1', managementEndedAt: NOW, managementEndedById: 'user-1' },
      update: { managementEndedAt: NOW, managementEndedById: 'user-1' },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-1',
        actorUserId: 'user-1',
        action: 'PROPERTY_MANAGEMENT_ENDED_SET',
        entityType: 'PropertywareBuilding',
        entityId: 'building-1',
      }),
    });
    // Called off there and then, not overnight -- for this property only.
    expect(leases.run).toHaveBeenCalledWith('org-1', { now: NOW, buildingId: 'building-1' });
    expect(change).toMatchObject({ calledOff: 1, booked: 0, status: { managementEnded: { by: { displayName: 'Pat Office' } }, tbpOptedOut: null } });
    expect(cache.bump).toHaveBeenCalledWith('propertyDetails', 'org-1');
  });

  it('takes the quarter’s unpublished visits there out of the plan, saying why', async () => {
    const { service, tx } = build({ after: { managementEndedAt: NOW } });

    await service.set(office, 'building-1', { managementEnded: true }, NOW);

    expect(tx.tbpQuarterPlanStop.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        propertywareBuildingId: 'building-1',
        inspectionId: null,
        status: { in: [TbpStopStatus.PLANNED, TbpStopStatus.BLOCKED, TbpStopStatus.FAILED] },
        OR: [{ scheduledOn: null }, { scheduledOn: { gte: date('2026-10-08') } }],
      },
      data: {
        status: TbpStopStatus.EXCLUDED,
        blockedCode: 'PROPERTY_LEFT_PACKAGE',
        blockedMessage: expect.stringContaining('ended the management'),
      },
    });
  });

  it('lists every kind of visit still booked there from today, for a person to cancel', async () => {
    const { service, prisma } = build({
      after: { managementEndedAt: NOW },
      stillBooked: [
        {
          id: 'inspection-9',
          inspectionType: 'MOVE_OUT',
          status: InspectionStatus.SCHEDULED,
          scheduledAt: date('2026-10-23'),
          assignments: [{ technician: { displayName: 'Sam Tech' } }],
        },
      ],
    });

    const change = await service.set(office, 'building-1', { managementEnded: true }, NOW);

    const where = prisma.inspection.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      organizationId: 'org-1',
      propertywareBuildingId: 'building-1',
      status: { in: [InspectionStatus.SCHEDULED, InspectionStatus.IN_PROGRESS] },
      scheduledAt: { gte: date('2026-10-08') },
    });
    expect(change.stillBooked).toEqual([
      { inspectionId: 'inspection-9', inspectionType: 'MOVE_OUT', status: 'SCHEDULED', scheduledOn: '2026-10-23', technician: 'Sam Tech' },
    ]);
  });

  it('books nothing and calls nothing off by itself while the lease schedule is switched off', async () => {
    const { service, tx, leases } = build({ after: { managementEndedAt: NOW }, scheduleOn: false });

    const change = await service.set(office, 'building-1', { managementEnded: true }, NOW);

    expect(tx.propertyServiceStatus.upsert).toHaveBeenCalled();
    expect(leases.run).not.toHaveBeenCalled();
    expect(change).toMatchObject({ calledOff: 0, booked: 0, leaseScheduleOn: false });
  });

  it('stays switched on when the lease run fails: tonight’s run does the same work', async () => {
    const { service, tx, leases } = build({ after: { managementEndedAt: NOW } });
    leases.run.mockRejectedValue(new Error('pool exhausted'));

    await expect(service.set(office, 'building-1', { managementEnded: true }, NOW)).resolves.toMatchObject({ calledOff: 0 });
    expect(tx.propertyServiceStatus.upsert).toHaveBeenCalled();
  });

  it('turned off, puts the visits it took out back in the plan and runs the lease schedule again', async () => {
    const { service, tx, leases } = build({ before: { managementEndedAt: date('2026-10-01') }, after: null });
    leases.run.mockResolvedValue({ counts: { BOOK: 1, ALREADY_BOOKED: 0, NEEDS_UNIT: 0, NOT_BOOKABLE: 0, MOVE: 0, CALL_OFF: 0 } });

    const change = await service.set(office, 'building-1', { managementEnded: false }, NOW);

    expect(tx.propertyServiceStatus.upsert.mock.calls[0][0].update).toEqual({ managementEndedAt: null, managementEndedById: null });
    expect(tx.tbpQuarterPlanStop.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        propertywareBuildingId: 'building-1',
        inspectionId: null,
        status: TbpStopStatus.EXCLUDED,
        blockedCode: 'PROPERTY_LEFT_PACKAGE',
      },
      data: { status: TbpStopStatus.PLANNED, blockedCode: null, blockedMessage: null },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'PROPERTY_MANAGEMENT_ENDED_CLEARED' }) });
    expect(change.booked).toBe(1);
  });
});

describe('the property opted out of the benefit package', () => {
  it('stops the quarter’s visits there and leaves the move-ins and move-outs alone', async () => {
    const { service, tx, leases, prisma } = build({ after: { tbpOptedOutAt: NOW } });

    await service.set(office, 'building-1', { tbpOptedOut: true }, NOW);

    expect(tx.propertyServiceStatus.upsert.mock.calls[0][0].update).toEqual({ tbpOptedOutAt: NOW, tbpOptedOutById: 'user-1' });
    expect(tx.tbpQuarterPlanStop.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ blockedMessage: expect.stringContaining('opted out of the benefit package') }) }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'PROPERTY_TBP_OPTED_OUT_SET' }) });
    expect(leases.run).not.toHaveBeenCalled();
    // Only the package's own visits are listed as still booked.
    expect(prisma.inspection.findMany.mock.calls[0][0].where.inspectionType).toEqual({ in: [InspectionType.OCCUPIED, InspectionType.HVAC] });
  });

  it('turned off while the management is still ended, keeps the visits out of the plan', async () => {
    const { service, tx } = build({
      before: { managementEndedAt: date('2026-10-01'), tbpOptedOutAt: date('2026-10-01') },
      after: { managementEndedAt: date('2026-10-01') },
    });

    await service.set(office, 'building-1', { tbpOptedOut: false }, NOW);

    expect(tx.tbpQuarterPlanStop.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'PROPERTY_TBP_OPTED_OUT_CLEARED' }) });
  });
});

describe('guards', () => {
  it('writes nothing when the switch is already where it was asked to be', async () => {
    const { service, prisma, leases, cache } = build({ before: { managementEndedAt: date('2026-10-01') } });

    await service.set(office, 'building-1', { managementEnded: true }, NOW);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(leases.run).not.toHaveBeenCalled();
    expect(cache.bump).not.toHaveBeenCalled();
  });

  it('refuses a property of another organization', async () => {
    const { service, prisma } = build();
    prisma.propertywareBuilding.findFirst.mockReset().mockResolvedValue(null);

    await expect(service.set(office, 'building-x', { managementEnded: true }, NOW)).rejects.toMatchObject({ code: 'PROPERTY_NOT_FOUND' });
    expect(prisma.propertywareBuilding.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'building-x', organizationId: 'org-1' } }),
    );
  });

  it('records no person for an integration, which is not one', async () => {
    const { service, tx } = build({ after: { tbpOptedOutAt: NOW } });

    await service.set({ ...office, id: 'client-1', principalType: 'API_KEY', apiClientId: 'client-1' }, 'building-1', { tbpOptedOut: true }, NOW);

    expect(tx.propertyServiceStatus.upsert.mock.calls[0][0].update).toEqual({ tbpOptedOutAt: NOW, tbpOptedOutById: null });
  });

  it('lists nothing still booked to someone who may not read inspections', async () => {
    const { service, prisma } = build({ before: { managementEndedAt: date('2026-10-01') } });

    const view = await service.view({ ...office, permissions: ['properties:read'] }, 'building-1', NOW);

    expect(view.stillBooked).toEqual([]);
    expect(prisma.inspection.findMany).not.toHaveBeenCalled();
  });
});
