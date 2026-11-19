import type { PrismaService } from '../src/common/prisma.service';
import { QuarterCoverageService } from '../src/planning/quarter-coverage.service';

/**
 * Where every property in the benefit package stands for a quarter (the office,
 * 2026-11-20). The cases are the ones production turned up that day: a lease
 * that changed hands after its visit, a visit re-booked in Jobber after its
 * stop was taken out, a property that joined after the quarter was built, and
 * one that left with its visit still booked. Places invented.
 */

const ORG = 'org-1';
const Q4 = { id: 'plan-q4', quarterYear: 2026, quarterNumber: 4 };
// 21:00 on Nov 19 in Texas: yesterday's visits there are not past their day yet.
const NOW = new Date('2026-11-20T03:00:00Z');

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

const inspection = (id: string, status: string, scheduledOn: string, jobber = true) => ({
  id,
  status,
  scheduledAt: day(scheduledOn),
  jobberVisitId: jobber ? `visit-${id}` : null,
  assignments: [{ technician: { displayName: 'Sam Tech' } }],
});

const stop = (
  id: string,
  buildingId: string | null,
  status: string,
  options: {
    inspection?: ReturnType<typeof inspection> | null;
    scheduledOn?: string | null;
    leaseActive?: boolean;
    tenantBuildingId?: string | null;
    note?: string | null;
    type?: string;
  } = {},
) => ({
  id,
  propertywareBuildingId: buildingId,
  status,
  scheduledOn: options.scheduledOn ? day(options.scheduledOn) : null,
  inspectionType: options.type ?? 'HVAC',
  jobberVisitId: null,
  blockedMessage: options.note ?? null,
  assignedTechnician: options.scheduledOn ? { displayName: 'Plan Tech' } : null,
  tenant: { isActive: options.leaseActive ?? true, propertywareBuildingId: options.tenantBuildingId ?? buildingId },
  inspection: options.inspection ?? null,
});

const STOPS = [
  stop('s-review', 'REVIEW', 'PUBLISHED', { inspection: inspection('i-review', 'REVIEW_REQUIRED', '2026-10-06') }),
  stop('s-done', 'DONE', 'PUBLISHED', { inspection: inspection('i-done', 'COMPLETED', '2026-09-22') }),
  stop('s-late', 'LATE', 'PUBLISHED', { inspection: inspection('i-late', 'SCHEDULED', '2026-11-16', false) }),
  // Its day is yesterday in UTC but today in Texas.
  stop('s-today', 'TODAY', 'PUBLISHED', { inspection: inspection('i-today', 'SCHEDULED', '2026-11-19') }),
  stop('s-noday', 'NODAY', 'UNSCHEDULED'),
  // No building on the stop: the lease says where it is.
  stop('s-blocked', null, 'BLOCKED', { tenantBuildingId: 'BLOCKED', note: 'Choose the unit.' }),
  // Its inspection was cancelled: the stop is all there is.
  stop('s-cancelled', 'CANCELLED', 'PUBLISHED', { inspection: inspection('i-cancelled', 'CANCELLED', '2026-11-10') }),
  stop('s-excluded', 'EXCLUDED', 'EXCLUDED', { note: 'Its Jobber visit was deleted on 2026-11-12.' }),
  // Visited for its old tenant; a new lease began since.
  stop('s-old', 'NEWLEASE', 'PUBLISHED', {
    inspection: inspection('i-old', 'REVIEW_REQUIRED', '2026-10-07'),
    leaseActive: false,
    type: 'OCCUPIED',
  }),
  // Taken out of the plan, then booked again straight in Jobber.
  stop('s-rebooked', 'REBOOKED', 'EXCLUDED'),
  // Booked now, and an old lease's visit still on Jobber's Unscheduled list.
  stop('s-current', 'LEFTOVER', 'PUBLISHED', { inspection: inspection('i-current', 'SCHEDULED', '2026-11-25') }),
  stop('s-leftover', 'LEFTOVER', 'UNSCHEDULED', { leaseActive: false }),
  // Out of the package now, still booked.
  stop('s-gone', 'GONE', 'PUBLISHED', { inspection: inspection('i-gone', 'SCHEDULED', '2026-11-25') }),
  // Out of the package, its visit long done: nothing to act on.
  stop('s-gone-done', 'GONEDONE', 'PUBLISHED', { inspection: inspection('i-gone-done', 'COMPLETED', '2026-10-01') }),
];

const JOBBER_VISITS = [
  {
    id: 'j-rebooked',
    propertywareBuildingId: 'REBOOKED',
    status: 'REVIEW_REQUIRED',
    scheduledAt: day('2026-10-21'),
    inspectionType: 'HVAC',
    jobberVisitId: 'visit-j-rebooked',
    jobberVisitTitle: 'Somewhere - Zone 1 - Q4 2026 Tenant Benefit Package',
    assignments: [],
  },
];

const tenancy = (buildingId: string, options: { enrolled?: string; active?: boolean; zone?: string; firstSyncedAt?: string } = {}) => ({
  propertywareBuildingId: buildingId,
  isActive: options.active ?? true,
  tbpEnrollment: options.enrolled ?? 'Yes',
  zone: options.zone ?? 'Zone 2',
  deactivatedAt: null,
  firstSyncedAt: new Date(options.firstSyncedAt ?? '2026-09-04T08:00:00Z'),
});

const TENANCIES = [
  ...['REVIEW', 'DONE', 'LATE', 'TODAY', 'NODAY', 'BLOCKED', 'CANCELLED', 'EXCLUDED', 'REBOOKED', 'LEFTOVER'].map((id) => tenancy(id)),
  tenancy('NEWLEASE', { active: false }),
  tenancy('NEWLEASE', { firstSyncedAt: '2026-11-14T08:00:00Z' }),
  // Joined after the quarter was built: in no plan.
  tenancy('JOINER', { zone: 'Zone 3', firstSyncedAt: '2026-10-20T08:00:00Z' }),
  // Two enrolled units.
  tenancy('UNITS'),
  tenancy('UNITS'),
  tenancy('GONE', { enrolled: 'No' }),
  tenancy('GONEDONE', { active: false }),
  // Zone 5 is not the package.
  tenancy('FAR', { zone: 'Zone 5' }),
];

type In = { in?: string[]; not?: null };

function build(options: { plan?: typeof Q4 | null } = {}) {
  const plan = options.plan === undefined ? Q4 : options.plan;
  const only = (ids: In | undefined, id: string | null) => !ids?.in || (id !== null && ids.in.includes(id));
  const prisma = {
    tbpQuarterPlan: {
      findFirst: jest.fn(({ where }: { where: { id: string; organizationId: string } }) =>
        Promise.resolve(plan && where.id === plan.id && where.organizationId === ORG ? plan : null),
      ),
    },
    tbpQuarterPlanStop: { findMany: jest.fn().mockResolvedValue(STOPS) },
    inspection: { findMany: jest.fn().mockResolvedValue(JOBBER_VISITS) },
    propertywareTenant: {
      findMany: jest.fn(({ where }: { where: { isActive?: boolean; propertywareBuildingId: In } }) =>
        Promise.resolve(
          TENANCIES.filter(
            (row) =>
              (where.isActive === undefined || row.isActive === where.isActive) &&
              only(where.propertywareBuildingId, row.propertywareBuildingId),
          ),
        ),
      ),
    },
    propertyServiceStatus: { findMany: jest.fn().mockResolvedValue([]) },
    propertywareBuilding: {
      findMany: jest.fn(({ where }: { where: { id: In } }) =>
        Promise.resolve(
          [...new Set(TENANCIES.map((row) => row.propertywareBuildingId))]
            .filter((id) => only(where.id, id))
            .map((id) => ({ id, addressLine1: `${id} Oak St`, name: id, city: 'Houston' })),
        ),
      ),
    },
  };
  return { service: new QuarterCoverageService(prisma as unknown as PrismaService), prisma };
}

const placeOf = async (buildingId: string) => {
  const coverage = await build().service.coverage(ORG, Q4.id, NOW);
  return coverage.properties.find((property) => property.buildingId === buildingId);
};

describe('a quarter’s coverage', () => {
  it('reads the day in Texas', async () => {
    const coverage = await build().service.coverage(ORG, Q4.id, NOW);

    expect(coverage).toMatchObject({ planId: 'plan-q4', quarterYear: 2026, quarterNumber: 4, today: '2026-11-19' });
  });

  it('puts a submitted visit under completed, waiting for review, and a finished one as finished', async () => {
    expect(await placeOf('REVIEW')).toMatchObject({ group: 'COMPLETED', detail: 'IN_REVIEW' });
    expect(await placeOf('DONE')).toMatchObject({
      group: 'COMPLETED',
      detail: 'FINISHED',
      visit: expect.objectContaining({ inspectionId: 'i-done', scheduledOn: '2026-09-22', technician: 'Sam Tech' }),
    });
  });

  it('puts a booked visit under scheduled, and calls it past its day only once the Texas day has gone', async () => {
    expect(await placeOf('LATE')).toMatchObject({
      group: 'SCHEDULED',
      detail: 'PAST_DUE',
      visit: expect.objectContaining({ bookedInJobber: false }),
    });
    expect(await placeOf('TODAY')).toMatchObject({ group: 'SCHEDULED', detail: 'UPCOMING' });
  });

  it('puts a visit with no booking under not scheduled, saying why', async () => {
    expect(await placeOf('NODAY')).toMatchObject({ group: 'NOT_SCHEDULED', detail: 'NO_DAY' });
    expect(await placeOf('BLOCKED')).toMatchObject({
      group: 'NOT_SCHEDULED',
      detail: 'NEEDS_PERSON',
      visit: expect.objectContaining({ stopId: 's-blocked', note: 'Choose the unit.' }),
    });
    // A cancelled inspection is no visit.
    expect(await placeOf('CANCELLED')).toMatchObject({
      group: 'NOT_SCHEDULED',
      detail: 'NOT_SENT',
      visit: expect.objectContaining({ inspectionId: null, inspectionStatus: null }),
    });
  });

  it('puts a property with no visit, or only one taken out, under none', async () => {
    expect(await placeOf('JOINER')).toEqual({
      buildingId: 'JOINER',
      address: 'JOINER Oak St',
      city: 'Houston',
      zone: 'Zone 3',
      leases: 1,
      firstOnReport: '2026-10-20T08:00:00.000Z',
      group: 'NONE',
      detail: 'NOT_PLANNED',
      visit: null,
      previousLeaseOpen: 0,
    });
    expect(await placeOf('EXCLUDED')).toMatchObject({
      group: 'NONE',
      detail: 'EXCLUDED',
      visit: expect.objectContaining({ note: 'Its Jobber visit was deleted on 2026-11-12.' }),
    });
  });

  it('counts the visit an ended lease had: the property was visited this quarter', async () => {
    expect(await placeOf('NEWLEASE')).toMatchObject({
      group: 'COMPLETED',
      leases: 1,
      firstOnReport: '2026-11-14T08:00:00.000Z',
      visit: expect.objectContaining({ inspectionId: 'i-old', previousLease: true, inspectionType: 'OCCUPIED' }),
    });
  });

  it('counts a visit booked straight in Jobber under the programme’s name over a stop taken out', async () => {
    const { service, prisma } = build();
    const coverage = await service.coverage(ORG, Q4.id, NOW);

    expect(coverage.properties.find((property) => property.buildingId === 'REBOOKED')).toMatchObject({
      group: 'COMPLETED',
      detail: 'IN_REVIEW',
      visit: expect.objectContaining({ inspectionId: 'j-rebooked', stopId: null, fromJobber: true, bookedInJobber: true }),
    });
    expect(prisma.inspection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tbpPlanStop: { is: null },
          status: { not: 'CANCELLED' },
          AND: [
            { jobberVisitTitle: { contains: 'tenant benefit package', mode: 'insensitive' } },
            { jobberVisitTitle: { contains: 'Q4 2026', mode: 'insensitive' } },
          ],
        }),
      }),
    );
  });

  it('says when an ended lease’s visit is still waiting beside the current one', async () => {
    expect(await placeOf('LEFTOVER')).toMatchObject({
      group: 'SCHEDULED',
      visit: expect.objectContaining({ stopId: 's-current' }),
      previousLeaseOpen: 1,
    });
  });

  it('lists every property in the package once, by group, and none outside it', async () => {
    const coverage = await build().service.coverage(ORG, Q4.id, NOW);

    expect(coverage.properties.map((property) => property.buildingId)).toEqual([
      'REVIEW',
      'NEWLEASE',
      'REBOOKED',
      'DONE',
      'LATE',
      'TODAY',
      'LEFTOVER',
      'BLOCKED',
      'NODAY',
      'CANCELLED',
      'JOINER',
      'UNITS',
      'EXCLUDED',
    ]);
    expect(coverage.properties.find((property) => property.buildingId === 'UNITS')).toMatchObject({ leases: 2, group: 'NONE' });
  });

  it('lists a property out of the package whose visit is still booked, and not one whose visit is done', async () => {
    const coverage = await build().service.coverage(ORG, Q4.id, NOW);

    expect(coverage.leftWithOpenVisit).toEqual([
      {
        buildingId: 'GONE',
        address: 'GONE Oak St',
        city: 'Houston',
        visit: expect.objectContaining({ inspectionId: 'i-gone', scheduledOn: '2026-11-25' }),
      },
    ]);
  });

  it('refuses a plan of another organization', async () => {
    await expect(build().service.coverage('org-2', Q4.id, NOW)).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
    await expect(build({ plan: null }).service.coverage(ORG, Q4.id, NOW)).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });
});
