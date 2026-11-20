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

/** A stop the quarter made for a lease at the property that has ended since. */
interface EndedStop {
  id: string;
  status: TbpStopStatus;
  sequence: number;
  inspectionId: string | null;
  inspection: { status: string; scheduledAt: Date } | null;
}

function build(
  options: {
    plan?: typeof PLAN | null;
    existing?: { id: string; propertywareTenantId: string }[];
    ended?: EndedStop[];
    lastSequence?: number | null;
  } = {},
) {
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
  // Stops moved to another lease, by the lease now theirs.
  const moved = new Map<string, EndedStop>();
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
      findMany: jest.fn(({ where }: { where: { tenant?: unknown; propertywareTenantId?: { in: string[] } } }) => {
        // The stops of leases at the property that have ended.
        if (where.tenant) return Promise.resolve(options.ended ?? []);
        const leases = where.propertywareTenantId?.in ?? [];
        // Before anything is written, the leases' stops already in the plan; after, the ones written.
        if (!created.length && !moved.size)
          return Promise.resolve((options.existing ?? []).filter((stop) => leases.includes(stop.propertywareTenantId)));
        return Promise.resolve([
          ...[...moved].filter(([lease]) => leases.includes(lease)).map(([, stop]) => ({ id: stop.id })),
          ...created.map((stop) => ({ id: `stop-${stop.propertywareTenantId}` })),
        ]);
      }),
      findUnique: jest.fn(({ where }: { where: { planId_propertywareTenantId: { propertywareTenantId: string } } }) => {
        const stop = moved.get(where.planId_propertywareTenantId.propertywareTenantId);
        return Promise.resolve(
          stop
            ? {
                ...stop,
                sequenceOverriddenAt: null,
                inspectionType: 'OCCUPIED',
                inspectionTypeOverriddenAt: null,
                visitDetails: null,
                visitTitleOverriddenAt: null,
                visitDetailsOverriddenAt: null,
                propertywareUnitId: null,
                unitOverriddenAt: null,
              }
            : null,
        );
      }),
      update: jest.fn(({ where, data }: { where: { id: string }; data: { propertywareTenantId: string } }) => {
        const stop = (options.ended ?? []).find((candidate) => candidate.id === where.id)!;
        moved.set(data.propertywareTenantId, stop);
        return Promise.resolve({});
      }),
      upsert: jest.fn(
        ({ where, create }: { where: { planId_propertywareTenantId: { propertywareTenantId: string } }; create: Record<string, unknown> }) => {
          if (!moved.has(where.planId_propertywareTenantId.propertywareTenantId)) created.push(create);
          return Promise.resolve({});
        },
      ),
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

    expect(result).toEqual({ planId: 'plan-q4', added: ['stop-joiner'], kept: [], carried: [] });
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
        metadata: { quarter: 'Q4 2026', buildingId: 'building-j', stopIds: ['stop-joiner'], keptStopIds: [], carriedStopIds: [] },
      }),
    });
  });

  it('adds only the leases with no stop, and adds nothing on a second press', async () => {
    const half = build({ existing: [{ id: 'stop-a', propertywareTenantId: 'unit-a' }] });
    expect(await half.service.addToQuarter(USER, PLAN.id, 'building-two')).toEqual({
      planId: 'plan-q4',
      added: ['stop-unit-b'],
      kept: ['stop-a'],
      carried: [],
    });
    expect(half.created.map((stop) => stop.propertywareTenantId)).toEqual(['unit-b']);

    const again = build({ existing: [{ id: 'stop-joiner', propertywareTenantId: 'joiner' }] });
    expect(await again.service.addToQuarter(USER, PLAN.id, 'building-j')).toEqual({
      planId: 'plan-q4',
      added: [],
      kept: ['stop-joiner'],
      carried: [],
    });
    expect(again.prisma.tbpQuarterPlanStop.upsert).not.toHaveBeenCalled();
    expect(again.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('numbers two new leases one after the other, from the first stop of an empty draft', async () => {
    const { service, created } = build({ lastSequence: null, plan: { ...PLAN, status: TbpPlanStatus.DRAFT } });

    await service.addToQuarter(USER, PLAN.id, 'building-two');

    expect(created.map((stop) => stop.sequence)).toEqual([1, 2]);
  });

  it('carries an ended lease’s visit still waiting for its day over to the new lease, rather than adding a second', async () => {
    const waiting: EndedStop = { id: 'stop-old', status: TbpStopStatus.UNSCHEDULED, sequence: 12, inspectionId: null, inspection: null };
    const { service, prisma, created } = build({ ended: [waiting] });

    const result = await service.addToQuarter(USER, PLAN.id, 'building-j');

    expect(result).toEqual({ planId: 'plan-q4', added: [], kept: [], carried: ['stop-old'] });
    expect(created).toHaveLength(0);
    expect(prisma.tbpQuarterPlanStop.update).toHaveBeenCalledWith({
      where: { id: 'stop-old' },
      data: {
        propertywareTenantId: 'joiner',
        tenantExternalId: 'ext-joiner',
        visitTitleOverriddenAt: null,
        visitDetailsOverriddenAt: null,
        unitOverriddenAt: null,
        inspectionTypeOverriddenAt: null,
      },
    });
    // Rewritten for the new lease, in its old place in the queue, keeping its Jobber visit.
    const [{ update }] = prisma.tbpQuarterPlanStop.upsert.mock.calls[0]! as unknown as [{ update: Record<string, unknown> }];
    expect(update).toMatchObject({
      sequence: 12,
      status: TbpStopStatus.PLANNED,
      inspectionType: 'HVAC',
      officeDetails: 'Filter Change: 20x25x1 + Pest Control',
    });
    expect(update).not.toHaveProperty('jobberVisitId');
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({ stopIds: [], carriedStopIds: ['stop-old'] }),
      }),
    });
  });

  it('refuses a second visit beside one booked for the ended lease', async () => {
    const booked: EndedStop = {
      id: 'stop-old',
      status: TbpStopStatus.PUBLISHED,
      sequence: 12,
      inspectionId: 'inspection-old',
      inspection: { status: 'SCHEDULED', scheduledAt: new Date('2026-11-25T00:00:00.000Z') },
    };
    const { service, prisma } = build({ ended: [booked] });

    await expect(service.addToQuarter(USER, PLAN.id, 'building-j')).rejects.toMatchObject({
      code: 'ALREADY_BOOKED',
      message: expect.stringContaining('2026-11-25'),
    });
    expect(prisma.tbpQuarterPlanStop.upsert).not.toHaveBeenCalled();
    expect(prisma.tbpQuarterPlanStop.update).not.toHaveBeenCalled();
  });

  it('adds a visit beside one the ended lease already had done, and does not guess between two units', async () => {
    const done: EndedStop = {
      id: 'stop-old',
      status: TbpStopStatus.PUBLISHED,
      sequence: 12,
      inspectionId: 'inspection-old',
      inspection: { status: 'REVIEW_REQUIRED', scheduledAt: new Date('2026-10-07T00:00:00.000Z') },
    };
    const afterDone = build({ ended: [done] });
    expect(await afterDone.service.addToQuarter(USER, PLAN.id, 'building-j')).toMatchObject({ added: ['stop-joiner'], carried: [] });

    const waiting: EndedStop = { id: 'stop-old', status: TbpStopStatus.UNSCHEDULED, sequence: 12, inspectionId: null, inspection: null };
    const twoUnits = build({ ended: [waiting] });
    expect(await twoUnits.service.addToQuarter(USER, PLAN.id, 'building-two')).toMatchObject({
      added: ['stop-unit-a', 'stop-unit-b'],
      carried: [],
    });
    expect(twoUnits.prisma.tbpQuarterPlanStop.update).not.toHaveBeenCalled();
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
