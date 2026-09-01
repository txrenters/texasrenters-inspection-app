import { InspectionSource, JobberOutboundStatus, Prisma } from '@prisma/client';

import type { JobberClient } from '../src/integrations/jobber/jobber.client';
import { enqueueJobberCompletion } from '../src/integrations/jobber/jobber.outbound';
import type { PrismaService } from '../src/common/prisma.service';
import { JobberOutboundWorker } from '../src/workers/jobber-sync/jobber-outbound.worker';

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

const task = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'task-1',
  inspectionId: 'inspection-1',
  jobberVisitId: 'visit-1',
  jobberJobId: 'job-1',
  createdById: 'user-1',
  attempts: 0,
  ...overrides,
});

describe('enqueueJobberCompletion', () => {
  const tx = () => ({
    inspection: { findFirst: jest.fn() },
    jobberOutboundTask: { create: jest.fn() },
  });

  it('does nothing for an inspection this app scheduled itself', async () => {
    const client = tx();
    client.inspection.findFirst.mockResolvedValue({
      source: InspectionSource.MANUAL,
      jobberVisitId: null,
      jobberJobId: null,
    });

    await expect(
      enqueueJobberCompletion(client as never, {
        organizationId: 'org-1',
        inspectionId: 'inspection-1',
        finalizedById: 'user-1',
      }),
    ).resolves.toBeNull();
    expect(client.jobberOutboundTask.create).not.toHaveBeenCalled();
  });

  it('queues a completion for a Jobber-sourced inspection', async () => {
    const client = tx();
    client.inspection.findFirst.mockResolvedValue({
      source: InspectionSource.JOBBER,
      jobberVisitId: 'visit-1',
      jobberJobId: 'job-1',
    });
    client.jobberOutboundTask.create.mockResolvedValue({ id: 'task-1' });

    await enqueueJobberCompletion(client as never, {
      organizationId: 'org-1',
      inspectionId: 'inspection-1',
      finalizedById: 'user-1',
    });
    expect(client.jobberOutboundTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ jobberVisitId: 'visit-1', createdById: 'user-1' }),
      }),
    );
  });

  it('treats an already-queued completion as done, so a re-finalize cannot double-push', async () => {
    const client = tx();
    client.inspection.findFirst.mockResolvedValue({
      source: InspectionSource.JOBBER,
      jobberVisitId: 'visit-1',
      jobberJobId: 'job-1',
    });
    client.jobberOutboundTask.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      enqueueJobberCompletion(client as never, {
        organizationId: 'org-1',
        inspectionId: 'inspection-1',
        finalizedById: 'user-1',
      }),
    ).resolves.toBeNull();
  });
});

describe('Jobber outbound worker', () => {
  const build = (
    overrides: Record<string, string | undefined>,
    rows: ReturnType<typeof task>[],
    request: jest.Mock,
  ) => {
    const prisma = {
      inspection: { findUnique: jest.fn().mockResolvedValue({ finalizedAt: new Date('2026-09-01T10:00:00Z') }) },
      jobberOutboundTask: {
        findMany: jest.fn().mockResolvedValue(rows),
        update: jest.fn().mockResolvedValue({}),
      },
      inspectionReportShare: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const worker = withEnvironment(
      overrides,
      () =>
        new JobberOutboundWorker(prisma as unknown as PrismaService, {
          request,
        } as unknown as JobberClient),
    );
    return { worker, prisma };
  };

  it('marks a visit complete and stops there when the link push is off', async () => {
    const request = jest.fn().mockResolvedValue({ visitComplete: { userErrors: [] } });
    const { worker, prisma } = build({ JOBBER_PUSH_REPORT_LINK: 'false' }, [task()], request);

    await expect(worker.run('org-1')).resolves.toMatchObject({ sent: 1, failed: 0 });
    expect(request).toHaveBeenCalledTimes(1);
    // No share token is minted when the link is not going anywhere.
    expect(prisma.inspectionReportShare.create).not.toHaveBeenCalled();
    expect(prisma.jobberOutboundTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: JobberOutboundStatus.SENT }),
      }),
    );
  });

  it('attaches the report link when that is turned on', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({ visitComplete: { userErrors: [] } })
      .mockResolvedValueOnce({ jobCreateNote: { userErrors: [] } });
    const { worker, prisma } = build({ JOBBER_PUSH_REPORT_LINK: 'true' }, [task()], request);

    await expect(worker.run('org-1')).resolves.toMatchObject({ sent: 1 });
    expect(prisma.inspectionReportShare.create).toHaveBeenCalled();
    expect(request.mock.calls[1][2]).toMatchObject({
      input: { message: expect.stringContaining('/report/') },
    });
  });

  it('reuses a live share rather than minting a new bearer link on every retry', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({ visitComplete: { userErrors: [] } })
      .mockResolvedValueOnce({ jobCreateNote: { userErrors: [] } });
    const { worker, prisma } = build({ JOBBER_PUSH_REPORT_LINK: 'true' }, [task()], request);
    prisma.inspectionReportShare.findFirst.mockResolvedValue({ token: 'existing-token' });

    await worker.run('org-1');
    expect(prisma.inspectionReportShare.create).not.toHaveBeenCalled();
    expect(request.mock.calls[1][2]).toMatchObject({
      input: { message: expect.stringContaining('existing-token') },
    });
  });

  it('fails the task when Jobber rejects the mutation inside a 200', async () => {
    // userErrors in an otherwise successful response is the trap: treating the
    // status alone as success marks the task SENT while nothing happened.
    const request = jest
      .fn()
      .mockResolvedValue({ visitComplete: { userErrors: [{ message: 'Visit already complete' }] } });
    const { worker, prisma } = build({ JOBBER_PUSH_REPORT_LINK: 'false' }, [task()], request);

    await expect(worker.run('org-1')).resolves.toMatchObject({ sent: 0, failed: 1 });
    expect(prisma.jobberOutboundTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: JobberOutboundStatus.FAILED, attempts: 1 }),
      }),
    );
  });

  it('gives up after the last attempt instead of retrying for ever', async () => {
    const request = jest.fn().mockRejectedValue(new Error('network'));
    const { worker, prisma } = build(
      { JOBBER_PUSH_REPORT_LINK: 'false' },
      [task({ attempts: 5 })],
      request,
    );

    await expect(worker.run('org-1')).resolves.toMatchObject({ abandoned: 1 });
    expect(prisma.jobberOutboundTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: JobberOutboundStatus.ABANDONED }),
      }),
    );
  });
});

describe('what the completion tells Jobber', () => {
  it('sends our sign-off time, not the moment the outbox happened to drain', () => {
    // The two differ by however long the queue waited -- minutes normally,
    // hours after an outage -- and only the first is a fact about the work.
    const finalizedAt = new Date('2026-09-01T10:00:00Z');
    const request = jest.fn().mockResolvedValue({ visitComplete: { userErrors: [] } });
    const prisma = {
      inspection: { findUnique: jest.fn().mockResolvedValue({ finalizedAt }) },
      jobberOutboundTask: {
        findMany: jest.fn().mockResolvedValue([task()]),
        update: jest.fn().mockResolvedValue({}),
      },
      inspectionReportShare: { findFirst: jest.fn(), create: jest.fn() },
    };
    const worker = withEnvironment(
      { JOBBER_PUSH_REPORT_LINK: 'false' },
      () => new JobberOutboundWorker(prisma as unknown as PrismaService, { request } as unknown as JobberClient),
    );

    return worker.run('org-1').then(() => {
      expect(request.mock.calls[0][2]).toMatchObject({
        visitId: 'visit-1',
        input: { completedAt: finalizedAt.toISOString() },
      });
    });
  });
});
