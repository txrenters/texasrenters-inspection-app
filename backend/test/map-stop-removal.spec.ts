import { InspectionStatus } from '@prisma/client';

import { removalOf, RouteService } from '../src/routing/route.service';

/**
 * Whether the technician map may take a visit off its technician's day (the
 * office, 2026-10-02: an "x" on each visit in the roster). It unassigns, as the
 * inspection page's Unassign does -- and only where that would stick.
 */

describe('removalOf', () => {
  it('allows a visit nobody has started', () => {
    expect(removalOf({ status: InspectionStatus.SCHEDULED, jobberVisitId: null }, false)).toEqual({
      removable: true,
      notRemovableBecause: null,
    });
  });

  it('refuses one under way or handed in', () => {
    expect(removalOf({ status: InspectionStatus.IN_PROGRESS, jobberVisitId: null }, true)).toEqual({
      removable: false,
      notRemovableBecause: 'STARTED',
    });
    expect(
      removalOf({ status: InspectionStatus.TECHNICIAN_SUBMITTED, jobberVisitId: null }, true),
    ).toEqual({ removable: false, notRemovableBecause: 'FINISHED' });
  });

  it('refuses a Jobber visit while console edits are not sent to Jobber, which would put it back', () => {
    expect(
      removalOf({ status: InspectionStatus.SCHEDULED, jobberVisitId: 'jobber-visit' }, false),
    ).toEqual({ removable: false, notRemovableBecause: 'JOBBER_EDITS_OFF' });
    expect(
      removalOf({ status: InspectionStatus.SCHEDULED, jobberVisitId: 'jobber-visit' }, true).removable,
    ).toBe(true);
  });
});

describe('the map day carries the answer', () => {
  const previous = process.env.JOBBER_PUSH_EDITS_ENABLED;
  afterEach(() => {
    if (previous === undefined) delete process.env.JOBBER_PUSH_EDITS_ENABLED;
    else process.env.JOBBER_PUSH_EDITS_ENABLED = previous;
  });

  it('marks each stop', async () => {
    process.env.JOBBER_PUSH_EDITS_ENABLED = 'false';
    const row = (id: string, status: InspectionStatus, jobberVisitId: string | null) => ({
      technicianId: 'tech-1',
      technician: { displayName: 'A Technician' },
      inspection: {
        id,
        propertywareBuildingId: `building-${id}`,
        inspectionType: 'MOVE_OUT',
        status,
        startedAt: null,
        submittedAt: null,
        completedAt: null,
        jobberVisitId,
        propertywareBuilding: { name: `${id} address` },
        property: null,
      },
    });
    const prisma = {
      inspectionAssignment: {
        findMany: async () => [
          row('a', InspectionStatus.SCHEDULED, null),
          row('b', InspectionStatus.SCHEDULED, 'jobber-visit'),
          row('c', InspectionStatus.IN_PROGRESS, null),
        ],
      },
    };
    const service = new RouteService(prisma as never, {} as never, {} as never, {} as never);

    const [day] = await service.assignmentsByTechnician('org-1', new Date('2026-10-02T12:00:00.000Z'));

    expect(day!.stops.map((stop) => [stop.inspectionId, stop.removable, stop.notRemovableBecause])).toEqual([
      ['a', true, null],
      ['b', false, 'JOBBER_EDITS_OFF'],
      ['c', false, 'STARTED'],
    ]);
  });
});
