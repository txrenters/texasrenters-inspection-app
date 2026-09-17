import { InspectionStatus } from '@prisma/client';

import { PlanBuildGuard } from '../src/planning/plan-build-guard';
import { PlanningController } from '../src/planning/planning.controller';

const request = { user: { organizationId: 'org-1' } } as never;

const day = {
  id: 'day-1',
  date: new Date('2026-10-14T00:00:00.000Z'),
  technicianId: 'moses',
  technician: { id: 'moses', displayName: 'Moses Rodriguez' },
  stopCount: 9,
  onSiteMinutes: 240,
  hvacStopCount: 3,
  totalDriveSeconds: 3600,
  totalDriveMeters: 50_000,
  homeDriveSeconds: 900,
  homeDriveMeters: 12_000,
  originKind: 'HOME',
  durationSource: 'GOOGLE_TRAFFIC_AWARE',
  departureAssumedAt: null,
};

const anchor = (id: string, overrides: { assigned?: string | null; scheduledAt?: string; status?: InspectionStatus } = {}) => ({
  id,
  inspectionId: `inspection-${id}`,
  technicianId: 'moses',
  date: new Date('2026-10-14T00:00:00.000Z'),
  onSiteMinutes: 60,
  positionInDay: 4,
  driveSecondsForecast: 420,
  inspection: {
    scheduledAt: new Date(`${overrides.scheduledAt ?? '2026-10-14'}T00:00:00.000Z`),
    status: overrides.status ?? InspectionStatus.SCHEDULED,
    propertywareBuilding: { addressLine1: '9 Move Out Ln', city: 'Katy', latitude: 29.7, longitude: -95.7 },
    assignments:
      overrides.assigned === null
        ? []
        : [{ technician: { id: overrides.assigned ?? 'moses', displayName: overrides.assigned === 'amy' ? 'Amy Wilson' : 'Moses Rodriguez' } }],
  },
});

function controllerWith(anchors: ReturnType<typeof anchor>[]) {
  const prisma = {
    tbpQuarterPlanDay: { findMany: jest.fn().mockResolvedValue([day]) },
    tbpQuarterPlanStop: { findMany: jest.fn().mockResolvedValue([]) },
    tbpQuarterPlanAnchor: { findMany: jest.fn().mockResolvedValue(anchors) },
  };
  return new PlanningController(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    new PlanBuildGuard(),
  );
}

/** The office (2026-09-17): move-outs are Moses's, and his days are built around them. */
describe('the move-outs a planned day is built around', () => {
  it('comes with its day, in its place in the route', async () => {
    const [result] = await controllerWith([anchor('a1')]).days(request, 'plan-1');

    expect(result!.anchors).toEqual([
      {
        id: 'a1',
        inspectionId: 'inspection-a1',
        positionInDay: 4,
        onSiteMinutes: 60,
        driveSecondsForecast: 420,
        address: '9 Move Out Ln',
        city: 'Katy',
        latitude: 29.7,
        longitude: -95.7,
        assignedTechnician: { id: 'moses', displayName: 'Moses Rodriguez' },
        needsReassigning: false,
        scheduledOn: '2026-10-14',
        cancelled: false,
      },
    ]);
  });

  it('asks to reassign a move-out assigned to anyone but the day’s technician, or to nobody', async () => {
    const [result] = await controllerWith([anchor('amy', { assigned: 'amy' }), anchor('nobody', { assigned: null })]).days(
      request,
      'plan-1',
    );

    expect(result!.anchors.map((entry) => [entry.id, entry.needsReassigning])).toEqual([
      ['amy', true],
      ['nobody', true],
    ]);
  });

  it('says when a move-out moved or was cancelled after the plan was laid out', async () => {
    const [result] = await controllerWith([
      anchor('moved', { scheduledAt: '2026-10-20' }),
      anchor('cancelled', { status: InspectionStatus.CANCELLED }),
    ]).days(request, 'plan-1');

    expect(result!.anchors.map((entry) => [entry.id, entry.scheduledOn, entry.cancelled])).toEqual([
      ['moved', '2026-10-20', false],
      ['cancelled', '2026-10-14', true],
    ]);
  });
});
