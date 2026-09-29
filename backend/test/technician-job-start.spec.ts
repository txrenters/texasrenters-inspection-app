import { InspectionStatus, InspectionType } from '@prisma/client';
import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { ApplicationError } from '../src/common/errors';
import { JOB_START_TRUST_WINDOW_MS, jobStartTime } from '../src/technician/job-start-time';
import { TechnicianService } from '../src/technician/technician.service';

/**
 * Start job arrives late, and sometimes twice (the office, 2026-09-29): the
 * phone saves the start when it is pressed and sends it when it can, again on
 * the next launch if the app was closed before the reply.
 */

const technician: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000004',
  authUserId: 'auth-technician',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Moses',
  roles: [UserRole.INSPECTION_TECHNICIAN],
  permissions: [],
  mustChangePassword: false,
  principalType: 'USER',
};

const NOW = new Date('2026-09-29T15:10:00.000Z');

const job = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  inspectionType: InspectionType.OCCUPIED,
  baselineInspectionId: null,
  baselineInspection: null,
  scheduledAt: new Date('2026-09-29T05:00:00.000Z'),
  scheduledStartAt: null,
  scheduledEndAt: null,
  status: InspectionStatus.SCHEDULED,
  priority: 'STANDARD',
  internalNotes: null,
  startedAt: null,
  submittedAt: null,
  allowTechnicianAreaCapture: false,
  reopenReason: null,
  servicesReport: null,
  jobberVisitTitle: null,
  jobberVisitDetails: null,
  propertywareUnit: null,
  propertywareBuilding: null,
  areas: [],
  ...over,
});

function build(record = job()) {
  let stored = record;
  const prisma = {
    inspection: {
      findFirst: jest.fn(async () => stored),
      updateMany: jest.fn(async ({ where, data }: { where: { status: string }; data: object }) => {
        if (stored.status !== where.status) return { count: 0 };
        stored = { ...stored, ...data };
        return { count: 1 };
      }),
      findUniqueOrThrow: jest.fn(async () => stored),
    },
  };
  const service = new TechnicianService(prisma as never, {} as never, {} as never, {
    queue: jest.fn(),
    advanceInspection: jest.fn().mockResolvedValue(undefined),
  } as never);
  return { service, prisma };
}

beforeAll(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
});
afterAll(() => jest.useRealTimers());

describe('the time a job started', () => {
  it('is when Start job was pressed, by the phone', () => {
    expect(jobStartTime('2026-09-29T15:02:11.000Z', NOW).toISOString()).toBe('2026-09-29T15:02:11.000Z');
  });

  it('is now when the phone sent none, as before', () => {
    expect(jobStartTime(undefined, NOW)).toEqual(NOW);
  });

  it('is never in the future, whatever the phone’s clock says', () => {
    expect(jobStartTime('2026-09-29T16:00:00.000Z', NOW)).toEqual(NOW);
  });

  it('is now when the claim is older than a day: that is a wrong clock, not a long job', () => {
    const tooOld = new Date(NOW.getTime() - JOB_START_TRUST_WINDOW_MS - 60_000).toISOString();
    expect(jobStartTime(tooOld, NOW)).toEqual(NOW);
  });
});

describe('starting a job', () => {
  it('records the moment it was pressed', async () => {
    const { service, prisma } = build();
    const started = await service.startInspection(technician, 'job-1', '2026-09-29T15:02:11.000Z');
    expect(prisma.inspection.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: InspectionStatus.SCHEDULED },
      data: { status: InspectionStatus.IN_PROGRESS, startedAt: new Date('2026-09-29T15:02:11.000Z') },
    });
    expect(started.startedAt).toBe('2026-09-29T15:02:11.000Z');
  });

  it('answers a second start with the job, keeping the first start', async () => {
    const { service, prisma } = build(
      job({ status: InspectionStatus.IN_PROGRESS, startedAt: new Date('2026-09-29T15:02:11.000Z') }),
    );
    const again = await service.startInspection(technician, 'job-1', '2026-09-29T15:09:00.000Z');
    expect(prisma.inspection.updateMany).not.toHaveBeenCalled();
    expect(again.startedAt).toBe('2026-09-29T15:02:11.000Z');
  });

  it('still refuses a job that has already been submitted', async () => {
    const { service } = build(job({ status: InspectionStatus.TECHNICIAN_SUBMITTED }));
    await expect(service.startInspection(technician, 'job-1')).rejects.toBeInstanceOf(ApplicationError);
  });
});
