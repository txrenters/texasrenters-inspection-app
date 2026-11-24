import { JobberRecordKind } from '@prisma/client';

import { markUnseenDeleted, saveMirrorPage } from '../src/integrations/jobber/jobber-mirror.store';

/** Writing mirrored records (2026-11-24): one row per record, however often it is read. Ids invented. */

const ORG = '30000000-0000-4000-8000-000000000001';
const SEEN = new Date('2026-11-24T12:00:00Z');

function setup() {
  const tx = {
    jobberRecord: {
      upsert: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    jobberMirrorCursor: { upsert: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { ...tx, $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)) };
  return { prisma, tx };
}

describe('saveMirrorPage', () => {
  it('upserts each record by organization, kind and Jobber id, and moves the cursor in the same transaction', async () => {
    const { prisma, tx } = setup();
    const node = { id: 'job-1', jobNumber: 7, title: 'Fix sink', createdAt: '2026-11-01T00:00:00Z' };

    const result = await saveMirrorPage(prisma as never, ORG, JobberRecordKind.JOB, [node], SEEN, { walkCursor: 'c-1' });

    expect(result).toEqual({ saved: 1, extractFailed: 0 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const call = tx.jobberRecord.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ organizationId_kind_jobberId: { organizationId: ORG, kind: 'JOB', jobberId: 'job-1' } });
    expect(call.update).toMatchObject({ payload: node, number: '7', lastSeenAt: SEEN, deletedInJobberAt: null, extractFailed: false });
    expect(call.create).toMatchObject({ organizationId: ORG, kind: 'JOB', jobberId: 'job-1' });
    expect(tx.jobberMirrorCursor.upsert).toHaveBeenCalledWith({
      where: { organizationId_kind: { organizationId: ORG, kind: 'JOB' } },
      create: { organizationId: ORG, kind: 'JOB', walkCursor: 'c-1' },
      update: { walkCursor: 'c-1' },
    });
  });

  it('brings a record back that Jobber had deleted and restored', async () => {
    const { prisma, tx } = setup();
    await saveMirrorPage(prisma as never, ORG, JobberRecordKind.CLIENT, [{ id: 'client-1', name: 'Back again' }], SEEN, {});
    expect(tx.jobberRecord.upsert.mock.calls[0][0].update.deletedInJobberAt).toBeNull();
  });

  it('keeps the payload of a record it cannot summarize, flagged', async () => {
    const { prisma, tx } = setup();
    const odd = { id: 'job-2', createdAt: 'yesterday-ish' };
    const result = await saveMirrorPage(prisma as never, ORG, JobberRecordKind.JOB, [odd], SEEN, {});
    expect(result).toEqual({ saved: 1, extractFailed: 1 });
    expect(tx.jobberRecord.upsert.mock.calls[0][0].update).toMatchObject({ payload: odd, extractFailed: true, number: null });
  });
});

describe('markUnseenDeleted', () => {
  it('marks rows the finished walk did not see', async () => {
    const { prisma, tx } = setup();
    tx.jobberRecord.count.mockResolvedValue(100);
    tx.jobberRecord.updateMany.mockResolvedValue({ count: 3 });
    const started = new Date('2026-11-24T00:00:00Z');

    const result = await markUnseenDeleted(prisma as never, ORG, JobberRecordKind.JOB, started, 97);

    expect(result).toEqual({ deleted: 3, short: false });
    expect(tx.jobberRecord.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, kind: 'JOB', deletedInJobberAt: null, lastSeenAt: { lt: started } },
      data: { deletedInJobberAt: expect.any(Date) },
    });
  });

  it('marks nothing when the walk saw under half of what is live -- Jobber hid records, they were not deleted', async () => {
    const { prisma, tx } = setup();
    tx.jobberRecord.count.mockResolvedValue(1_000);

    const result = await markUnseenDeleted(prisma as never, ORG, JobberRecordKind.JOB, new Date(), 400);

    expect(result).toEqual({ deleted: 0, short: true });
    expect(tx.jobberRecord.updateMany).not.toHaveBeenCalled();
  });
});
