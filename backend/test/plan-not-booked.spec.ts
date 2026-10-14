import { TbpStopStatus } from '@prisma/client';

import { PlanningController } from '../src/planning/planning.controller';

/**
 * A quarter's properties whose visit is not booked yet, for the Group maker
 * (the office, 2026-10-15: unschedule the rest of Q4 "so we can regroup them
 * using the tbp group maker"). Ids invented.
 */

function controllerWith(prisma: object) {
  return new PlanningController(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

const request = { user: { organizationId: 'org-1' } } as never;

describe('a quarter’s properties not booked yet', () => {
  it('asks for every visit without an inspection, left out of nothing, and names each property once', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { propertywareBuildingId: 'building-1' },
      { propertywareBuildingId: 'building-2' },
      // Two tenancies of one building: one property on the map.
      { propertywareBuildingId: 'building-2' },
    ]);
    const controller = controllerWith({
      tbpQuarterPlan: { findFirst: jest.fn().mockResolvedValue({ id: 'plan-1', quarterYear: 2026, quarterNumber: 4 }) },
      tbpQuarterPlanStop: { findMany },
    });

    await expect(controller.notBooked(request, 'plan-1')).resolves.toEqual({
      planId: 'plan-1',
      quarter: 'Q4 2026',
      visits: 3,
      buildingIds: ['building-1', 'building-2'],
    });
    expect(findMany.mock.calls[0][0].where).toEqual({
      planId: 'plan-1',
      organizationId: 'org-1',
      inspectionId: null,
      propertywareBuildingId: { not: null },
      status: { not: TbpStopStatus.EXCLUDED },
      // A stop with no code at all is kept: a bare "not" would leave it out.
      OR: [{ blockedCode: null }, { blockedCode: { not: 'ZONE_EXCLUDED' } }],
    });
  });

  it('refuses a plan that is not the organization’s', async () => {
    const controller = controllerWith({ tbpQuarterPlan: { findFirst: jest.fn().mockResolvedValue(null) } });

    await expect(controller.notBooked(request, 'plan-9')).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });
});
