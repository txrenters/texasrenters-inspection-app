import { JobberOutboundKind, JobberOutboundStatus } from '@prisma/client';

import { businessClockTime, businessInstant } from '../src/common/business-day';
import type { PrismaService } from '../src/common/prisma.service';
import type { JobberClient } from '../src/integrations/jobber/jobber.client';
import { requestVisitPush } from '../src/integrations/jobber/jobber.outbound';
import type { JobberVisit } from '../src/integrations/jobber/jobber.schemas';
import { JobberOutboundWorker } from '../src/workers/jobber-sync/jobber-outbound.worker';
import { JobberSyncWorker, type JobberSyncResult } from '../src/workers/jobber-sync/jobber-sync.worker';

/**
 * Edits made in the console to a visit Jobber already has: a new day, a new
 * technician, new Details, a cancellation. People and ids invented.
 */

const jobberEnvironment = {
  JOBBER_CLIENT_ID: 'client-id',
  JOBBER_CLIENT_SECRET: 'client-secret',
  JOBBER_API_VERSION: '2025-01-20',
  JOBBER_OAUTH_REDIRECT_URI: 'https://backend.example.com/api/v1/integrations/jobber/oauth/callback',
};

const withEnvironment = <T>(overrides: Record<string, string | undefined>, build: () => T): T => {
  const previous = { ...process.env };
  Object.assign(process.env, jobberEnvironment, overrides);
  try {
    return build();
  } finally {
    process.env = previous;
  }
};

const READ_AT = new Date('2026-09-15T12:00:00.000Z');

const editTask = (kind: JobberOutboundKind, overrides: Record<string, unknown> = {}) => ({
  id: 'task-1',
  inspectionId: 'inspection-1',
  kind,
  jobberVisitId: 'visit-9',
  jobberJobId: 'job-9',
  createdById: 'coordinator-1',
  servicesNoteSentAt: null,
  jobTitle: null,
  attempts: 0,
  nextAttemptAt: READ_AT,
  ...overrides,
});

function build({
  task,
  inspection = {},
  assignment = { technician: { email: 'tech@example.com' } },
  jobberUsers = [{ id: 'jobber-user-7' }],
  otherVisitsOnJob = 0,
  environment = { JOBBER_BOOKING_ENABLED: 'true' },
  response = {},
}: {
  task: ReturnType<typeof editTask>;
  inspection?: Record<string, unknown>;
  assignment?: { technician: { email: string } } | null;
  jobberUsers?: { id: string }[];
  otherVisitsOnJob?: number;
  environment?: Record<string, string | undefined>;
  response?: Record<string, unknown>;
}) {
  const prisma = {
    jobberOutboundTask: {
      findMany: jest.fn().mockResolvedValue([task]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    inspection: {
      findFirst: jest.fn().mockResolvedValue({
        scheduledAt: new Date('2026-09-22T00:00:00.000Z'),
        scheduledStartAt: null,
        scheduledEndAt: null,
        jobberVisitTitle: '100 Main St - Zone 3 - Move in Inspection',
        jobberVisitDetails: 'Completion Instruction',
        id: 'inspection-1',
        ...inspection,
      }),
    },
    inspectionAssignment: { findFirst: jest.fn().mockResolvedValue(assignment) },
    jobberVisitImport: { count: jest.fn().mockResolvedValue(otherVisitsOnJob) },
    $queryRaw: jest.fn().mockResolvedValue(jobberUsers),
  };
  const request = jest.fn().mockResolvedValue(response);
  const worker = withEnvironment(
    environment,
    () => new JobberOutboundWorker(prisma as unknown as PrismaService, { request } as unknown as JobberClient),
  );
  return { worker, prisma, request };
}

describe('pushing a console edit to Jobber', () => {
  it('moves a whole-day visit to the new day', async () => {
    const { worker, request } = build({
      task: editTask(JobberOutboundKind.VISIT_RESCHEDULE),
      response: { visitEditSchedule: { userErrors: [] } },
    });

    await expect(worker.run('org-1')).resolves.toMatchObject({ sent: 1 });
    expect(request.mock.calls[0][2]).toEqual({
      id: 'visit-9',
      input: {
        startAt: { date: '2026-09-22', timezone: 'America/Chicago' },
        endAt: { date: '2026-09-22', timezone: 'America/Chicago' },
      },
    });
  });

  it('keeps the Texas clock time of a visit that had one', async () => {
    const { worker, request } = build({
      task: editTask(JobberOutboundKind.VISIT_RESCHEDULE),
      inspection: {
        // 9:00 to 10:30 in the morning in Texas (CDT), on the 22nd.
        scheduledStartAt: new Date('2026-09-22T14:00:00.000Z'),
        scheduledEndAt: new Date('2026-09-22T15:30:00.000Z'),
      },
      response: { visitEditSchedule: { userErrors: [] } },
    });

    await worker.run('org-1');
    expect(request.mock.calls[0][2].input).toEqual({
      startAt: { date: '2026-09-22', time: '09:00:00', timezone: 'America/Chicago' },
      endAt: { date: '2026-09-22', time: '10:30:00', timezone: 'America/Chicago' },
    });
  });

  it('puts the current technician on the visit by the Jobber id their email has', async () => {
    const { worker, request } = build({
      task: editTask(JobberOutboundKind.VISIT_ASSIGN),
      response: { visitEditAssignedUsers: { userErrors: [] } },
    });
    await worker.run('org-1');
    expect(request.mock.calls[0][2]).toEqual({ visitId: 'visit-9', input: { assignedUserIds: ['jobber-user-7'] } });
  });

  it('leaves the visit unassigned in Jobber when nobody, or nobody Jobber knows, is on it', async () => {
    const unknown = build({
      task: editTask(JobberOutboundKind.VISIT_ASSIGN),
      jobberUsers: [],
      response: { visitEditAssignedUsers: { userErrors: [] } },
    });
    await unknown.worker.run('org-1');
    expect(unknown.request.mock.calls[0][2].input).toEqual({ assignedUserIds: [] });

    const nobody = build({
      task: editTask(JobberOutboundKind.VISIT_ASSIGN),
      assignment: null,
      response: { visitEditAssignedUsers: { userErrors: [] } },
    });
    await nobody.worker.run('org-1');
    expect(nobody.request.mock.calls[0][2].input).toEqual({ assignedUserIds: [] });
    expect(nobody.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('writes the edited title and Details onto the visit', async () => {
    const { worker, request } = build({
      task: editTask(JobberOutboundKind.VISIT_EDIT),
      response: { visitEdit: { userErrors: [] } },
    });
    await worker.run('org-1');
    expect(request.mock.calls[0][2]).toEqual({
      id: 'visit-9',
      attributes: { title: '100 Main St - Zone 3 - Move in Inspection', instructions: 'Completion Instruction' },
    });
  });

  const jobVisits = (nodes: { id: string; isComplete: boolean }[], hasNextPage = false) => ({
    job: { visits: { nodes, pageInfo: { hasNextPage } } },
  });

  it("closes a cancelled inspection's job and removes its open visit, when it is the job's only open one", async () => {
    const { worker, request } = build({ task: editTask(JobberOutboundKind.VISIT_CANCEL) });
    request
      .mockResolvedValueOnce(jobVisits([{ id: 'visit-9', isComplete: false }, { id: 'visit-1', isComplete: true }]))
      .mockResolvedValueOnce({ jobClose: { userErrors: [] } });

    await expect(worker.run('org-1')).resolves.toMatchObject({ sent: 1 });
    expect(request.mock.calls[0][2]).toEqual({ id: 'job-9' });
    expect(request.mock.calls[1][1]).toContain('jobClose');
    expect(request.mock.calls[1][2]).toEqual({ jobId: 'job-9', input: { modifyIncompleteVisitsBy: 'DESTROY_ALL' } });
  });

  it('deletes only the visit when Jobber shows other open visits on the job', async () => {
    const { worker, request } = build({ task: editTask(JobberOutboundKind.VISIT_CANCEL) });
    request
      .mockResolvedValueOnce(jobVisits([{ id: 'visit-9', isComplete: false }, { id: 'visit-10', isComplete: false }]))
      .mockResolvedValueOnce({ visitDelete: { userErrors: [] } });

    await worker.run('org-1');
    expect(request.mock.calls[1][1]).toContain('visitDelete');
    expect(request.mock.calls[1][2]).toEqual({ visitIds: ['visit-9'] });
  });

  it('deletes only the visit when the job has more visits than one page shows', async () => {
    const { worker, request } = build({ task: editTask(JobberOutboundKind.VISIT_CANCEL) });
    request
      .mockResolvedValueOnce(jobVisits([{ id: 'visit-9', isComplete: false }], true))
      .mockResolvedValueOnce({ visitDelete: { userErrors: [] } });

    await worker.run('org-1');
    expect(request.mock.calls[1][1]).toContain('visitDelete');
  });

  it('marks an edit sent only if the office has not edited again while it was going', async () => {
    const { worker, prisma } = build({
      task: editTask(JobberOutboundKind.VISIT_EDIT),
      response: { visitEdit: { userErrors: [] } },
    });
    // The re-arm moved attempts and nextAttemptAt, so nothing matches.
    prisma.jobberOutboundTask.updateMany.mockResolvedValue({ count: 0 });

    await worker.run('org-1');
    expect(prisma.jobberOutboundTask.update).not.toHaveBeenCalled();
    expect(prisma.jobberOutboundTask.updateMany).toHaveBeenCalledWith({
      where: { id: 'task-1', attempts: 0, nextAttemptAt: READ_AT },
      data: expect.objectContaining({ status: JobberOutboundStatus.SENT }),
    });
  });

  it('fails and retries when Jobber refuses the change inside a 200', async () => {
    const { worker, prisma } = build({
      task: editTask(JobberOutboundKind.VISIT_RESCHEDULE),
      response: { visitEditSchedule: { userErrors: [{ message: 'Visit is complete', path: [] }] } },
    });
    await expect(worker.run('org-1')).resolves.toMatchObject({ failed: 1 });
    expect(prisma.jobberOutboundTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: JobberOutboundStatus.FAILED }) }),
    );
  });

  it('holds every edit back while pushing edits is switched off', async () => {
    const { worker, prisma } = build({
      task: editTask(JobberOutboundKind.VISIT_EDIT),
      environment: { JOBBER_BOOKING_ENABLED: 'true', JOBBER_PUSH_EDITS_ENABLED: 'false' },
    });
    prisma.jobberOutboundTask.findMany.mockResolvedValue([]);
    await worker.run('org-1');
    expect(prisma.jobberOutboundTask.findMany.mock.calls[0][0].where.kind.notIn).toEqual(
      expect.arrayContaining([
        JobberOutboundKind.VISIT_RESCHEDULE,
        JobberOutboundKind.VISIT_ASSIGN,
        JobberOutboundKind.VISIT_EDIT,
        JobberOutboundKind.VISIT_CANCEL,
      ]),
    );
  });
});

describe('queueing a console edit', () => {
  const client = (visit: { jobberVisitId: string | null; jobberJobId: string | null } | null) => ({
    inspection: { findFirst: jest.fn().mockResolvedValue(visit) },
    jobberOutboundTask: { upsert: jest.fn().mockResolvedValue({ id: 'task-1' }) },
  });

  it('re-arms the one task of its kind, so the latest edit is what goes', async () => {
    const tx = client({ jobberVisitId: 'visit-9', jobberJobId: 'job-9' });
    await requestVisitPush(tx as never, {
      organizationId: 'org-1',
      inspectionId: 'inspection-1',
      kind: JobberOutboundKind.VISIT_RESCHEDULE,
      requestedById: 'coordinator-1',
    });

    const [[call]] = tx.jobberOutboundTask.upsert.mock.calls;
    expect(call.where).toEqual({
      organizationId_inspectionId_kind: {
        organizationId: 'org-1',
        inspectionId: 'inspection-1',
        kind: JobberOutboundKind.VISIT_RESCHEDULE,
      },
    });
    expect(call.update).toMatchObject({
      status: JobberOutboundStatus.PENDING,
      attempts: 0,
      lastError: null,
      sentAt: null,
      jobberVisitId: 'visit-9',
    });
  });

  it('queues nothing for an inspection with no Jobber visit', async () => {
    const tx = client({ jobberVisitId: null, jobberJobId: null });
    await expect(
      requestVisitPush(tx as never, {
        organizationId: 'org-1',
        inspectionId: 'inspection-1',
        kind: JobberOutboundKind.VISIT_EDIT,
        requestedById: 'coordinator-1',
      }),
    ).resolves.toBeNull();
    expect(tx.jobberOutboundTask.upsert).not.toHaveBeenCalled();
  });
});

describe('the sync while a console edit is on its way to Jobber', () => {
  const result = (): JobberSyncResult => ({
    correlationId: 'c1',
    visitsSeen: 1,
    imported: 0,
    rescheduled: 0,
    unmatched: 0,
    rejected: 0,
    alreadyComplete: 0,
    notSynced: 0,
    assigned: 0,
    completedFromJobber: 0,
    skipped: 0,
    truncated: false,
  });

  function syncWith(waiting: JobberOutboundKind[]) {
    const prisma = {
      jobberOutboundTask: { findMany: jest.fn().mockResolvedValue(waiting.map((kind) => ({ kind }))) },
      inspection: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'inspection-1',
          status: 'SCHEDULED',
          startedAt: null,
          // Moved to the 22nd in the console; Jobber still says the 16th.
          scheduledAt: new Date('2026-09-22T00:00:00Z'),
          scheduledStartAt: null,
          scheduledEndAt: null,
          jobberVisitTitle: 'Edited title',
          jobberVisitDetails: 'Edited details',
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(),
    };
    const worker = new JobberSyncWorker(prisma as never, {} as never, {} as never) as unknown as {
      applyAssignment: jest.Mock;
      completeFromJobber: jest.Mock;
      applyChanges: (organizationId: string, visit: JobberVisit, inspectionId: string, result: JobberSyncResult) => Promise<void>;
    };
    worker.applyAssignment = jest.fn().mockResolvedValue(undefined);
    worker.completeFromJobber = jest.fn().mockResolvedValue(undefined);
    return { worker, prisma };
  }

  const jobberCopy = {
    id: 'visit-9',
    title: 'Old title',
    instructions: 'Old details',
    startAt: '2026-09-16T05:00:00Z',
    endAt: '2026-09-17T04:59:59Z',
  } as unknown as JobberVisit;

  it("keeps the console's day, technician and Details until they have gone", async () => {
    const { worker, prisma } = syncWith([
      JobberOutboundKind.VISIT_RESCHEDULE,
      JobberOutboundKind.VISIT_ASSIGN,
      JobberOutboundKind.VISIT_EDIT,
    ]);

    await worker.applyChanges('org-1', jobberCopy, 'inspection-1', result());

    expect(worker.applyAssignment).not.toHaveBeenCalled();
    expect(prisma.inspection.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.jobberOutboundTask.findMany.mock.calls[0][0].where.status).toEqual({
      in: [JobberOutboundStatus.PENDING, JobberOutboundStatus.FAILED],
    });
  });

  it("goes back to Jobber's copy once nothing is waiting", async () => {
    const { worker, prisma } = syncWith([]);

    await worker.applyChanges('org-1', jobberCopy, 'inspection-1', result());

    expect(worker.applyAssignment).toHaveBeenCalled();
    expect(prisma.inspection.updateMany).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

describe('a Texas clock time on another day', () => {
  it('reads the wall-clock time an instant shows in Texas', () => {
    expect(businessClockTime(new Date('2026-09-22T14:00:00.000Z'))).toBe('09:00:00');
    expect(businessClockTime(new Date('2026-12-01T15:00:00.000Z'))).toBe('09:00:00');
  });

  it('keeps nine in the morning across a daylight-saving change', () => {
    // CDT in October, CST in November: the same wall time is an hour apart in UTC.
    expect(businessInstant('2026-10-30', '09:00:00').toISOString()).toBe('2026-10-30T14:00:00.000Z');
    expect(businessInstant('2026-11-02', '09:00:00').toISOString()).toBe('2026-11-02T15:00:00.000Z');
  });
});
