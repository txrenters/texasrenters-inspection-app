import { JobberConnectionStatus } from '@prisma/client';

import { downloadFile } from '../src/workers/jobber-sync/jobber-invoice-files.worker';
import { JobberMirrorFileWorker, mirrorFileKey } from '../src/workers/jobber-sync/jobber-mirror-files.worker';

jest.mock('../src/workers/jobber-sync/jobber-invoice-files.worker', () => {
  const actual = jest.requireActual('../src/workers/jobber-sync/jobber-invoice-files.worker');
  return { ...actual, downloadFile: jest.fn().mockResolvedValue(Buffer.from('bytes')) };
});

/** Note attachments copied out of Jobber before its links stop working (2026-11-24). Ids invented. */

const ORG = '30000000-0000-4000-8000-000000000001';
const record = { id: 'rec-1', kind: 'JOB', jobberId: 'job-1' };
const link = (id: string) => ({
  id,
  fileName: `${id}.jpg`,
  contentType: 'image/jpeg',
  fileSize: 5,
  url: `https://files.example.com/${id}`,
  downloadUrl: null,
  downloadContentType: null,
});

function setup({ copiedToday = 0, pending = [] as object[] } = {}) {
  const prisma = {
    jobberConnection: { findUnique: jest.fn().mockResolvedValue({ status: JobberConnectionStatus.CONNECTED }) },
    jobberRecord: {
      // Prisma's field reference, used to compare filesListedAt with jobberUpdatedAt.
      fields: { jobberUpdatedAt: 'jobberUpdatedAt' },
      findMany: jest.fn().mockResolvedValueOnce([record]).mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    jobberRecordFile: {
      count: jest.fn().mockResolvedValue(copiedToday),
      findMany: jest.fn().mockResolvedValue(pending),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const client = { request: jest.fn() };
  const storage = { put: jest.fn().mockResolvedValue(undefined) };
  const worker = new JobberMirrorFileWorker(prisma as never, client as never, storage as never);
  return { prisma, client, storage, worker };
}

beforeEach(() => jest.mocked(downloadFile).mockClear().mockResolvedValue(Buffer.from('bytes')));

it('lists a record\'s attachments, then copies the ones not yet stored into our storage', async () => {
  const { prisma, client, storage, worker } = setup({
    pending: [{ id: 'file-a', recordId: 'rec-1', jobberFileId: 'att-1', contentType: 'image/jpeg', copyAttempts: 0, copyAttemptedAt: null }],
  });
  client.request.mockResolvedValueOnce({ job: { id: 'job-1', noteAttachments: { totalCount: 1, nodes: [link('att-1')] } } });

  const result = await worker.run(ORG);

  expect(result).toEqual({ listed: 1, copied: 1, failed: 0, skipped: null });
  expect(prisma.jobberRecordFile.upsert).toHaveBeenCalledWith(
    expect.objectContaining({ where: { organizationId_jobberFileId: { organizationId: ORG, jobberFileId: 'att-1' } } }),
  );
  expect(prisma.jobberRecord.update).toHaveBeenCalledWith({ where: { id: 'rec-1' }, data: { filesListedAt: expect.any(Date), filesTruncated: false } });
  expect(storage.put).toHaveBeenCalledWith(mirrorFileKey(ORG, 'rec-1', 'file-a'), Buffer.from('bytes'), 'image/jpeg');
  // The link is used, never kept.
  expect(JSON.stringify(prisma.jobberRecordFile.update.mock.calls)).not.toContain('files.example.com');
});

it("ends a gone record's files as failed instead of retrying forever", async () => {
  const { prisma, client, worker } = setup({
    pending: [{ id: 'file-a', recordId: 'rec-1', jobberFileId: 'att-1', contentType: null, copyAttempts: 0, copyAttemptedAt: null }],
  });
  client.request.mockResolvedValueOnce({ job: null });

  const result = await worker.run(ORG);

  expect(result.failed).toBe(1);
  expect(prisma.jobberRecordFile.update).toHaveBeenCalledWith({
    where: { id: 'file-a' },
    data: { copyProblem: 'Jobber no longer has this record.', copyAttempts: 5 },
  });
});

it('copies nothing once the daily ceiling is reached', async () => {
  const { client, worker } = setup({ copiedToday: 2_000 });
  expect(await worker.run(ORG)).toEqual({ listed: 0, copied: 0, failed: 0, skipped: 'CEILING' });
  expect(client.request).not.toHaveBeenCalled();
});

it('stamps a record Jobber no longer has as listed, so it is not asked about every tick', async () => {
  const { prisma, client, worker } = setup();
  client.request.mockResolvedValueOnce({ job: null });

  await worker.run(ORG);

  expect(prisma.jobberRecord.update).toHaveBeenCalledWith({
    where: { id: 'rec-1' },
    data: { filesListedAt: expect.any(Date), filesTruncated: false },
  });
});

it('carries on with the next record when listing one fails', async () => {
  const { prisma, client, worker } = setup();
  prisma.jobberRecord.findMany = jest
    .fn()
    .mockResolvedValueOnce([record, { id: 'rec-2', kind: 'JOB', jobberId: 'job-2' }])
    .mockResolvedValue([]);
  client.request
    .mockRejectedValueOnce(new Error('Jobber said no'))
    .mockResolvedValueOnce({ job: { id: 'job-2', noteAttachments: { totalCount: 0, nodes: [] } } });

  const result = await worker.run(ORG);

  expect(client.request).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({ listed: 1, failed: 0 });
});

it('flags a record with more attachments than one listing carries', async () => {
  const { prisma, client, worker } = setup();
  client.request.mockResolvedValueOnce({ job: { id: 'job-1', noteAttachments: { totalCount: 150, nodes: [link('att-1')] } } });

  await worker.run(ORG);

  expect(prisma.jobberRecord.update).toHaveBeenCalledWith({
    where: { id: 'rec-1' },
    data: { filesListedAt: expect.any(Date), filesTruncated: true },
  });
});
