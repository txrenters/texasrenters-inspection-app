import { JobberMirrorService } from '../src/integrations/jobber/jobber-mirror.service';

/** How far the copy has got, for the office to check before Jobber is closed (2026-11-24). */

const ORG = '30000000-0000-4000-8000-000000000001';
const user = { id: 'user-1', organizationId: ORG } as never;

function setup() {
  const prisma = {
    jobberRecord: {
      groupBy: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ('deletedInJobberAt' in where && where.deletedInJobberAt === null && !('extractFailed' in where))
          return [{ kind: 'JOB', _count: { _all: 120 } }];
        if ('extractFailed' in where) return [{ kind: 'JOB', _count: { _all: 2 } }];
        return [{ kind: 'JOB', _count: { _all: 3 } }];
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    jobberRecordFile: { findMany: jest.fn().mockResolvedValue([
      { storageKey: 'k', copyAttempts: 1, record: { kind: 'JOB' } },
      { storageKey: null, copyAttempts: 1, record: { kind: 'JOB' } },
      { storageKey: null, copyAttempts: 5, record: { kind: 'JOB' } },
    ]) },
    jobberMirrorCursor: { findMany: jest.fn().mockResolvedValue([
      { kind: 'JOB', walkCompletedAt: null, walkCursor: 'c-1', lastCheckedAt: null, lastError: null, lastErrorAt: null },
    ]) },
  };
  return { prisma, service: new JobberMirrorService(prisma as never) };
}

it('reports every kind, with records, deletions, unreadable rows and files, scoped to the organization', async () => {
  const { prisma, service } = setup();

  const { kinds } = await service.status(user);

  expect(kinds.map((k) => k.kind)).toEqual(['CLIENT', 'PROPERTY', 'JOB', 'VISIT', 'QUOTE', 'REQUEST']);
  expect(kinds.find((k) => k.kind === 'JOB')).toEqual({
    kind: 'JOB',
    records: 120,
    deleted: 3,
    extractFailed: 2,
    filesStored: 1,
    filesPending: 1,
    filesFailed: 1,
    walkCompletedAt: null,
    walkInProgress: true,
    lastCheckedAt: null,
    lastError: null,
    lastErrorAt: null,
  });
  for (const [call] of prisma.jobberRecord.groupBy.mock.calls) expect(call.where.organizationId).toBe(ORG);
});

it('marks a visit Jobber deleted, never erasing it', async () => {
  const { prisma, service } = setup();
  await service.markVisitDeleted(ORG, 'visit-1');
  expect(prisma.jobberRecord.updateMany).toHaveBeenCalledWith({
    where: { organizationId: ORG, kind: 'VISIT', jobberId: 'visit-1', deletedInJobberAt: null },
    data: { deletedInJobberAt: expect.any(Date) },
  });
});
