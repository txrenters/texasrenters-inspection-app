import { AdminService } from '../src/admin/admin.service';

/**
 * What one job says about itself (2026-11-06): TBP or not, occupied or not,
 * its quarter and zone. Only the private read is tested: `inspection()` itself
 * is covered with its doubles elsewhere. Ids invented.
 */

const ORG = '20000000-0000-4000-8000-000000000001';
const BUILDING = '20000000-0000-4000-8000-000000000030';
const UNIT = '20000000-0000-4000-8000-000000000031';

function service(tenancies: { tbpEnrollment: string | null; zone: string | null }[], leases: number) {
  const prisma = {
    propertywareTenant: { findMany: jest.fn().mockResolvedValue(tenancies) },
    propertywareLease: { count: jest.fn().mockResolvedValue(leases) },
  };
  const admin = Object.create(AdminService.prototype) as AdminService;
  Object.assign(admin, { prisma });
  const standing = (buildingId: string | null, unitId: string | null = null) =>
    (admin as unknown as { jobStanding: (o: string, b: string | null, u: string | null) => Promise<Record<string, unknown>> }).jobStanding(ORG, buildingId, unitId);
  return { prisma, standing };
}

describe("a job's standing", () => {
  it('is occupied with an active lease or tenancy, and carries the enrolment and zone', async () => {
    const { standing, prisma } = service([{ tbpEnrollment: 'Yes', zone: 'Zone 3' }], 1);
    expect(await standing(BUILDING)).toEqual({ tbp: 'ENROLLED', occupancy: 'OCCUPIED', zone: '3' });
    expect(prisma.propertywareTenant.findMany.mock.calls[0][0].where).toEqual({ organizationId: ORG, isActive: true, propertywareBuildingId: BUILDING });
    expect(prisma.propertywareLease.count.mock.calls[0][0].where).toEqual({ organizationId: ORG, isActive: true, buildingId: BUILDING });
  });

  it('is vacant with neither, as the property page derives it, and not "not enrolled": nobody is there to enrol', async () => {
    expect(await service([], 0).standing(BUILDING)).toEqual({ tbp: null, occupancy: 'VACANT', zone: null });
  });

  it('is decided by the lease on a job for one unit: a tenancy has no unit to answer for', async () => {
    const { standing, prisma } = service([{ tbpEnrollment: 'No', zone: null }], 0);
    expect(await standing(BUILDING, UNIT)).toMatchObject({ occupancy: 'VACANT', tbp: 'NOT_ENROLLED' });
    expect(prisma.propertywareLease.count.mock.calls[0][0].where).toMatchObject({ OR: [{ unitId: UNIT }, { unitId: null }] });
  });

  it('asks nothing with no property', async () => {
    const { standing, prisma } = service([], 0);
    expect(await standing(null)).toEqual({ tbp: null, occupancy: null, zone: null });
    expect(prisma.propertywareTenant.findMany).not.toHaveBeenCalled();
  });
});

