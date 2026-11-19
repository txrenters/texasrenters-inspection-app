import { TbpPlanStatus, TbpStopStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../src/common/auth';
import type { PrismaService } from '../src/common/prisma.service';
import { TbpPlanService } from '../src/planning/tbp-plan.service';

/**
 * A property in the package given a visit in a quarter already built, from the
 * plan's Coverage tab (the office, 2026-11-20): on production that day, nine
 * properties had a lease that began after Q4 was built and so no visit at all.
 * Ids and addresses invented.
 */

const ORG = 'org-1';
const USER = { id: 'user-1', organizationId: ORG, email: 'office@example.com', displayName: 'Office' } as unknown as AuthenticatedUser;
const PLAN = {
  id: 'plan-q4',
  status: TbpPlanStatus.PUBLISHED as TbpPlanStatus,
  quarterYear: 2026,
  quarterNumber: 4,
  officeDetailsRows: [{ address: '14 Joiner Way', postalCode: '77449', details: 'Filter Change: 20x25x1 + Pest Control' }],
};

const tenancy = (id: string, buildingId: string, overrides: Record<string, unknown> = {}) => ({
  id,
  externalId: `ext-${id}`,
  leaseName: `Tenant ${id}`,
  startDate: new Date('2026-10-16T00:00:00.000Z'),
  zone: '2',
  addressLine1: '14 Joiner Way',
  postalCode: '77449',
  hvacFilterSizes: ['20x25x1'],
  hvacFilterLocation: null,
  managementPlan: 'Premium',
  hvacPlan: 'On our AC plan',
  propertywareBuildingId: buildingId,
  unitExternalId: null,
  unitName: null,
  contactName: null,
  contactPhones: [],
  contactEmail: null,
  tbpEnrollment: 'Yes',
  building: { details: null, serviceStatus: null },
  ...overrides,
});

function build(options: { plan?: typeof PLAN | null; existing?: { id: string; propertywareTenantId: string }[]; lastSequence?: number | null } = {}) {
  const plan = options.plan === undefined ? PLAN : options.plan;
  const tenancies = [
    tenancy('joiner', 'building-j'),
    // Not "Yes": no visit.
    tenancy('unverified', 'building-u', { tbpEnrollment: 'Not Verified', addressLine1: '3 Unsure Rd' }),
    // Zone 5 is not the package.
    tenancy('far', 'building-f', { zone: '5', addressLine1: '5 Far Ln' }),
    // Two enrolled units at one building.
    tenancy('unit-a', 'building-two', { addressLine1: '7 Pair St' }),
    tenancy('unit-b', 'building-two', { addressLine1: '7 Pair St' }),
  ];
  const created: Record<string, unknown>[] = [];
  const prisma = {
    tbpQuarterPlan: {
      findFirst: jest.fn(({ where }: { where: { id: string; organizationId: string } }) =>
        Promise.resolve(plan && where.id === plan.id && where.organizationId === ORG ? plan : null),
      ),
      // Last quarter, published: the joiner was not in it.
      findMany: jest.fn().mockResolvedValue([
        {
          quarterYear: 2026,
          quarterNumber: 3,
          stops: [{ tenantExternalId: 'ext-someone-else', sequence: 1, assignedTechnicianId: 'tech-1', scheduledOn: null }],
        },
      ]),
      update: jest.fn().mockResolvedValue({}),
    },
    propertywareTenant: { findMany: jest.fn().mockResolvedValue(tenancies) },
    propertywareUnit: { findMany: jest.fn().mockResolvedValue([]) },
    tbpQuarterPlanStop: {
      findMany: jest
        .fn()
        // The leases' stops already in the plan.
        .mockResolvedValueOnce(options.existing ?? [])
        // The stops just made.
        .mockImplementationOnce(() => Promise.resolve(created.map((stop) => ({ id: `stop-${stop.propertywareTenantId}` })))),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(({ create }: { create: Record<string, unknown> }) => {
        created.push(create);
        return Promise.resolve({});
      }),
      aggregate: jest.fn().mockResolvedValue({ _max: { sequence: options.lastSequence === undefined ? 407 : options.lastSequence } }),
      count: jest.fn().mockResolvedValue(408),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  return { service: new TbpPlanService(prisma as unknown as PrismaService), prisma, created };
}

describe('adding a property to a quarter already built', () => {
  it('makes a stop for its enrolled lease at the end of the queue, with no day, ready to be given one', async () => {
    const { service, prisma, created } = build();

    const result = await service.addToQuarter(USER, PLAN.id, 'building-j');

    expect(result).toEqual({ planId: 'plan-q4', added: ['stop-joiner'], kept: [] });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      organizationId: ORG,
      planId: 'plan-q4',
      propertywareTenantId: 'joiner',
      tenantExternalId: 'ext-joiner',
      sequence: 408,
      orderSource: 'NEW_ENROLLMENT',
      previousSequence: null,
      status: TbpStopStatus.PLANNED,
      propertywareBuildingId: 'building-j',
      // HVAC in Q4 for a tenancy on the HVAC plan, as a rebuild would decide.
      inspectionType: 'HVAC',
      // The office's sheet for the quarter, matched by address.
      officeDetails: 'Filter Change: 20x25x1 + Pest Control',
    });
    expect(created[0]).not.toHaveProperty('scheduledOn');
    expect(prisma.tbpQuarterPlan.update).toHaveBeenCalledWith({ where: { id: 'plan-q4' }, data: { stopCount: 408 } });
  });

  it('records who added it', async () => {
    const { service, prisma } = build();

    await service.addToQuarter(USER, PLAN.id, 'building-j');

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: ORG,
        action: 'TBP_PLAN_PROPERTY_ADDED',
        entityType: 'TbpQuarterPlan',
        entityId: 'plan-q4',
        metadata: { quarter: 'Q4 2026', buildingId: 'building-j', stopIds: ['stop-joiner'], keptStopIds: [] },
      }),
    });
  });

  it('adds only the leases with no stop, and adds nothing on a second press', async () => {
    const half = build({ existing: [{ id: 'stop-a', propertywareTenantId: 'unit-a' }] });
    expect(await half.service.addToQuarter(USER, PLAN.id, 'building-two')).toEqual({
      planId: 'plan-q4',
      added: ['stop-unit-b'],
      kept: ['stop-a'],
    });
    expect(half.created.map((stop) => stop.propertywareTenantId)).toEqual(['unit-b']);

    const again = build({ existing: [{ id: 'stop-joiner', propertywareTenantId: 'joiner' }] });
    expect(await again.service.addToQuarter(USER, PLAN.id, 'building-j')).toEqual({
      planId: 'plan-q4',
      added: [],
      kept: ['stop-joiner'],
    });
    expect(again.prisma.tbpQuarterPlanStop.upsert).not.toHaveBeenCalled();
    expect(again.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('numbers two new leases one after the other, from the first stop of an empty draft', async () => {
    const { service, created } = build({ lastSequence: null, plan: { ...PLAN, status: TbpPlanStatus.DRAFT } });

    await service.addToQuarter(USER, PLAN.id, 'building-two');

    expect(created.map((stop) => stop.sequence)).toEqual([1, 2]);
  });

  it('refuses a property outside the package: not enrolled, or in zone 5', async () => {
    for (const buildingId of ['building-u', 'building-f', 'building-nowhere']) {
      const { service, prisma } = build();
      await expect(service.addToQuarter(USER, PLAN.id, buildingId)).rejects.toMatchObject({ code: 'NOT_IN_PACKAGE' });
      expect(prisma.tbpQuarterPlanStop.upsert).not.toHaveBeenCalled();
    }
  });

  it('refuses a plan being published or called off, and one of another organization', async () => {
    for (const status of [TbpPlanStatus.PUBLISHING, TbpPlanStatus.CANCELLED]) {
      const { service, prisma } = build({ plan: { ...PLAN, status } });
      await expect(service.addToQuarter(USER, PLAN.id, 'building-j')).rejects.toMatchObject({ code: 'PLAN_NOT_OPEN' });
      expect(prisma.tbpQuarterPlanStop.upsert).not.toHaveBeenCalled();
    }
    const { service } = build();
    await expect(
      service.addToQuarter({ ...USER, organizationId: 'org-2' } as AuthenticatedUser, PLAN.id, 'building-j'),
    ).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });
});
