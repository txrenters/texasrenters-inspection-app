import { InspectionSource, InspectionStatus, InspectionType } from '@prisma/client';
import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { ApplicationError } from '../src/common/errors';
import { TechnicianService, unfinishedRoomsMessage } from '../src/technician/technician.service';

/**
 * End job refused because rooms are not finished on the server (2026-10-12).
 *
 * Moses pressed End job on a move-out whose last three videos were still
 * sending from his phone. The phone showed every room done; the server said
 * only "Complete or provide an authorized skip reason for every required room",
 * which sent nobody looking at the uploads. It now names the rooms and says
 * their videos may still be sending.
 */

const technician = {
  id: '10000000-0000-4000-8000-000000000002',
  authUserId: 'auth-tech',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Technician',
  roles: [UserRole.INSPECTION_TECHNICIAN],
  permissions: [],
  mustChangePassword: false,
  principalType: 'USER',
} as unknown as AuthenticatedUser;

const moveOut = {
  id: 'job-1',
  inspectionType: InspectionType.MOVE_OUT,
  baselineInspectionId: null,
  baselineInspection: null,
  scheduledAt: new Date('2026-10-12T00:00:00.000Z'),
  scheduledStartAt: null,
  scheduledEndAt: null,
  status: InspectionStatus.IN_PROGRESS,
  priority: 'STANDARD',
  internalNotes: null,
  startedAt: new Date('2026-10-12T21:04:00.000Z'),
  submittedAt: null,
  propertywareLeaseId: null,
  jobberVisitTitle: 'Move Out Inspection',
  jobberVisitDetails: null,
  source: InspectionSource.JOBBER,
  jobberVisitId: 'visit-1',
  jobberJobId: 'jobber-job-1',
  allowTechnicianAreaCapture: false,
  reopenReason: null,
  propertywareUnit: null,
  propertywareBuilding: {
    id: 'building-1',
    name: '9 Example St',
    addressLine1: '9 Example St',
    city: 'Katy',
    state: 'TX',
    postalCode: '77494',
  },
  areas: [],
};

function build(unfinished: string[]) {
  const prisma = {
    inspection: { findFirst: jest.fn().mockResolvedValue(moveOut), update: jest.fn() },
    inspectionArea: {
      count: jest.fn().mockResolvedValue(unfinished.length),
      findMany: jest
        .fn()
        .mockResolvedValue(unfinished.map((name, index) => ({ id: `area-${index}`, propertyArea: { name } }))),
    },
    $transaction: jest.fn(),
  };
  const service = new TechnicianService(prisma as never, {} as never, {} as never, {} as never);
  return { service, prisma };
}

describe('End job with rooms not finished on the server', () => {
  it('names the rooms and says their videos may still be sending, and submits nothing', async () => {
    const { service, prisma } = build(['Bathroom 2', 'Bathroom 1', 'Bedroom 1']);

    const refusal = await service.completeInspection(technician, 'job-1').catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ApplicationError);
    expect(refusal).toMatchObject({
      code: 'REQUIRED_ROOMS_INCOMPLETE',
      details: [
        { areaId: 'area-0', name: 'Bathroom 2' },
        { areaId: 'area-1', name: 'Bathroom 1' },
        { areaId: 'area-2', name: 'Bedroom 1' },
      ],
    });
    expect((refusal as Error).message).toBe(
      'Bathroom 2, Bathroom 1 and Bedroom 1 are not finished on the server yet. If you have recorded them, ' +
        'their videos are still sending from your phone: keep the app open with signal and end the job again ' +
        'in a few minutes. Otherwise record or skip them.',
    );
    // The same rule both times: the rooms named are the rooms counted.
    expect(prisma.inspectionArea.findMany.mock.calls[0][0].where).toEqual(
      prisma.inspectionArea.count.mock.calls[0][0].where,
    );
    expect(prisma.inspection.update).not.toHaveBeenCalled();
  });
});

describe('the message', () => {
  it('speaks of one room as one', () => {
    expect(unfinishedRoomsMessage(['Kitchen'])).toBe(
      'Kitchen is not finished on the server yet. If you have recorded it, its video is still sending from ' +
        'your phone: keep the app open with signal and end the job again in a few minutes. Otherwise record or skip it.',
    );
  });

  it('names four and counts the rest', () => {
    expect(unfinishedRoomsMessage(['Kitchen', 'Hallway', 'Bedroom 1', 'Bedroom 2', 'Bedroom 3', 'Attic'])).toMatch(
      /^Kitchen, Hallway, Bedroom 1, Bedroom 2 and 2 more are not finished/,
    );
    // More counted than fetched: the total is what is said.
    expect(unfinishedRoomsMessage(['Kitchen', 'Hallway'], 25)).toMatch(/^Kitchen, Hallway and 23 more are/);
  });
});
