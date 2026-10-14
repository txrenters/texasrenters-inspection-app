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

/**
 * Grouped by the build's own rules, for the Group maker to make a template of
 * in one step (the office, 2026-10-15). Ids invented; the places are near
 * downtown Houston.
 */
describe('a quarter’s unscheduled visits grouped into days', () => {
  const building = (id: string, latitude: number, extra: Record<string, unknown> = {}) => ({
    propertywareBuildingId: id,
    sequence: 1,
    onSiteMinutes: 20,
    inspectionType: 'HVAC',
    zone: '1',
    propertywareBuilding: { latitude, longitude: -95.37, geofence: null },
    ...extra,
  });

  it('groups the properties, a building’s tenancies together, and counts those with no position', async () => {
    const stops = [
      ...Array.from({ length: 12 }, (_, index) => building(`near-${index}`, 29.76 + index * 0.002)),
      // A second tenancy of the same building: one stop, two visits.
      building('near-0', 29.76),
      building('nowhere', 0, { propertywareBuilding: { latitude: null, longitude: null, geofence: null } }),
    ];
    const controller = controllerWith({
      tbpQuarterPlan: { findFirst: jest.fn().mockResolvedValue({ id: 'plan-1', quarterYear: 2026, quarterNumber: 4 }) },
      tbpQuarterPlanStop: { findMany: jest.fn().mockResolvedValue(stops) },
    });

    const result = await controller.notBookedGroups(request, 'plan-1');

    expect(result).toMatchObject({ planId: 'plan-1', quarter: 'Q4 2026', visits: 14, withoutPosition: 1 });
    const placed = result.groups.flatMap((group) => group.buildingIds);
    expect(placed.sort()).toEqual(Array.from({ length: 12 }, (_, index) => `near-${index}`).sort());
    // Twelve close properties: days of nine to ten, so two.
    expect(result.groups).toHaveLength(2);
    expect(result.groups.reduce((total, group) => total + group.visits, 0)).toBe(13);
  });
});
