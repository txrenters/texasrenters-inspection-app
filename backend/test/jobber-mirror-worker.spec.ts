import { JobberConnectionStatus, JobberRecordKind } from '@prisma/client';

import { MIRROR_KINDS } from '../src/integrations/jobber/jobber-mirror.kinds';
import { markUnseenDeleted, saveMirrorPage } from '../src/integrations/jobber/jobber-mirror.store';
import { JobberError } from '../src/integrations/jobber/jobber.errors';
import { JobberMirrorWorker } from '../src/workers/jobber-sync/jobber-mirror.worker';

jest.mock('../src/integrations/jobber/jobber-mirror.store', () => ({
  saveMirrorPage: jest.fn().mockResolvedValue({ saved: 0, extractFailed: 0 }),
  markUnseenDeleted: jest.fn().mockResolvedValue({ deleted: 0, short: false }),
}));

/**
 * The mirror's bounded run (2026-11-24): walk every record once, keep its
 * place, then read only what changed; one kind failing never stops the next.
 * Ids invented.
 */

const ORG = '30000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-24T12:00:00Z');
const HOUR = 3_600_000;

const page = (connection: string, nodes: object[], hasNextPage: boolean, endCursor: string | null, available = 9_000) => ({
  data: { [connection]: { nodes, pageInfo: { hasNextPage, endCursor } } },
  cost: { requestedQueryCost: 1_000, actualQueryCost: 300, throttleStatus: { maximumAvailable: 10_000, currentlyAvailable: available, restoreRate: 500 } },
});

type Cursor = Partial<{
  walkCursor: string | null;
  walkStartedAt: Date | null;
  walkCompletedAt: Date | null;
  walkSeen: number;
  changesCursor: string | null;
  changesStartedAt: Date | null;
  changesCompletedAt: Date | null;
  changesSince: Date | null;
  previousWalkStartedAt: Date | null;
}>;

/** Every kind caught up an hour ago unless a test says otherwise, so only the kind under test reads. */
const caughtUp: Cursor = {
  walkCompletedAt: new Date(NOW.getTime() - HOUR),
  walkStartedAt: new Date(NOW.getTime() - 2 * HOUR),
  changesCompletedAt: new Date(NOW.getTime() - 10 * 60_000),
  changesSince: new Date(NOW.getTime() - HOUR),
};

function setup(cursors: Partial<Record<JobberRecordKind, Cursor>> = {}, connected = true) {
  const prisma = {
    jobberConnection: {
      findUnique: jest.fn().mockResolvedValue(connected ? { status: JobberConnectionStatus.CONNECTED } : null),
    },
    jobberMirrorCursor: {
      findUnique: jest.fn(async ({ where }: { where: { organizationId_kind: { kind: JobberRecordKind } } }) => {
        const kind = where.organizationId_kind.kind;
        return { walkSeen: 0, ...(cursors[kind] ?? caughtUp) };
      }),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
  const client = { requestDetailed: jest.fn(), request: jest.fn() };
  const worker = new JobberMirrorWorker(prisma as never, client as never);
  const sleep = jest.spyOn(worker as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockResolvedValue();
  const savedCursors = () => jest.mocked(saveMirrorPage).mock.calls.map((call) => call[5]);
  return { prisma, client, worker, sleep, savedCursors };
}

beforeEach(() => {
  jest.mocked(saveMirrorPage).mockClear();
  jest.mocked(markUnseenDeleted).mockClear().mockResolvedValue({ deleted: 0, short: false });
});

describe('the first walk', () => {
  it('pages through every job, keeps its place each page, and hands over to "what changed"', async () => {
    const { client, worker, savedCursors } = setup({ JOB: {} });
    client.requestDetailed
      .mockResolvedValueOnce(page('jobs', [{ id: 'job-1' }, { id: 'job-2' }], true, 'c-1'))
      .mockResolvedValueOnce(page('jobs', [{ id: 'job-3' }], false, 'c-2'));

    const result = await worker.run(ORG, NOW);

    expect(result.kinds).toEqual([
      expect.objectContaining({ kind: 'JOB', mode: 'walk', pages: 2, saved: 3, caughtUp: true, problem: null }),
    ]);
    expect(client.requestDetailed.mock.calls[0][2]).toEqual({ first: 25, after: null });
    expect(client.requestDetailed.mock.calls[1][2]).toEqual({ first: 25, after: 'c-1' });
    const [first, last] = savedCursors();
    expect(first).toMatchObject({ walkCursor: 'c-1', walkStartedAt: NOW, walkSeen: 2, lastError: null });
    expect(last).toMatchObject({ walkCursor: null, walkCompletedAt: NOW, walkSeen: 3, changesCursor: null });
    // Five minutes before the walk began, so what changed during it is read again.
    expect(last.changesSince).toEqual(new Date(NOW.getTime() - 5 * 60_000));
    // A first walk has nothing to compare with: nothing is marked deleted.
    expect(markUnseenDeleted).not.toHaveBeenCalled();
  });

  it('resumes a walk from the cursor it saved, counting what it already saw', async () => {
    const started = new Date(NOW.getTime() - 3 * HOUR);
    const before = new Date(NOW.getTime() - 8 * 24 * HOUR);
    const { client, worker, savedCursors } = setup({
      JOB: { walkCursor: 'c-9', walkStartedAt: started, walkSeen: 500, previousWalkStartedAt: before },
    });
    client.requestDetailed.mockResolvedValueOnce(page('jobs', [{ id: 'job-501' }], false, null));

    await worker.run(ORG, NOW);

    expect(client.requestDetailed.mock.calls[0][2]).toEqual({ first: 25, after: 'c-9' });
    expect(savedCursors()[0]).toMatchObject({ walkSeen: 501 });
    // Deleted only when unseen since the walk before this one began: missed by two walks in a row.
    expect(markUnseenDeleted).toHaveBeenCalledWith(expect.anything(), ORG, 'JOB', before, 501);
  });

  it('remembers when the previous walk began when a new walk starts', async () => {
    const previous = new Date(NOW.getTime() - 8 * 24 * HOUR);
    const { client, worker, savedCursors } = setup({
      JOB: { ...caughtUp, walkStartedAt: previous, walkCompletedAt: new Date(previous.getTime() + HOUR) },
    });
    client.requestDetailed.mockResolvedValueOnce(page('jobs', [{ id: 'job-1' }], false, null));

    await worker.run(ORG, NOW);

    expect(savedCursors()[0]).toMatchObject({ walkStartedAt: NOW, previousWalkStartedAt: previous });
    expect(markUnseenDeleted).toHaveBeenCalledWith(expect.anything(), ORG, 'JOB', previous, 1);
  });

  it('records WALK_SHORT where an hourly pass cannot clear it, and keeps every row', async () => {
    const before = new Date(NOW.getTime() - 8 * 24 * HOUR);
    const { client, worker, prisma } = setup({ JOB: { walkCursor: 'c-1', walkStartedAt: NOW, previousWalkStartedAt: before } });
    client.requestDetailed.mockResolvedValueOnce(page('jobs', [{ id: 'job-1' }], false, null));
    jest.mocked(markUnseenDeleted).mockResolvedValueOnce({ deleted: 0, short: true });

    const result = await worker.run(ORG, NOW);

    expect(result.kinds[0]).toMatchObject({ problem: 'WALK_SHORT', deleted: 0 });
    expect(prisma.jobberMirrorCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ lastError: 'WALK_SHORT', walkShortAt: NOW }) }),
    );
  });

  it('clears the WALK_SHORT mark when a later walk ends whole', async () => {
    const before = new Date(NOW.getTime() - 8 * 24 * HOUR);
    const { client, worker, savedCursors } = setup({ JOB: { walkCursor: 'c-1', walkStartedAt: NOW, previousWalkStartedAt: before } });
    client.requestDetailed.mockResolvedValueOnce(page('jobs', [{ id: 'job-1' }], false, null));

    await worker.run(ORG, NOW);

    expect(savedCursors()[0]).toMatchObject({ walkShortAt: null });
  });

  it('reads a job with more notes than a page carries again by itself', async () => {
    const { client, worker } = setup({ JOB: {} });
    const long = { id: 'job-1', notes: { totalCount: 7, nodes: [1, 2, 3, 4, 5] } };
    const whole = { id: 'job-1', notes: { totalCount: 7, nodes: [1, 2, 3, 4, 5, 6, 7] } };
    client.requestDetailed
      .mockResolvedValueOnce(page('jobs', [long], false, null))
      .mockResolvedValueOnce({ data: { job: whole }, cost: page('jobs', [], false, null).cost });

    const result = await worker.run(ORG, NOW);

    expect(client.requestDetailed.mock.calls[1][2]).toEqual({ id: 'job-1' });
    expect(jest.mocked(saveMirrorPage).mock.calls[0][3]).toEqual([whole]);
    // A read by itself counts against the run's pages like any other.
    expect(result).toMatchObject({ pages: 2 });
    expect(result.kinds[0]).toMatchObject({ readAlone: 1 });
  });

  it('stops the run on THROTTLED during a read by itself, saving nothing from that page', async () => {
    const { client, worker } = setup({ JOB: {} });
    const long = { id: 'job-1', notes: { totalCount: 7, nodes: [1, 2, 3, 4, 5] } };
    client.requestDetailed
      .mockResolvedValueOnce(page('jobs', [long], true, 'c-1'))
      .mockRejectedValue(new JobberError('Throttled', 'JOBBER_THROTTLED', 429, true));

    const result = await worker.run(ORG, NOW);

    expect(result.kinds).toEqual([expect.objectContaining({ kind: 'JOB', problem: 'THROTTLED' })]);
    expect(saveMirrorPage).not.toHaveBeenCalled();
  });
});

describe('what changed', () => {
  it('asks for jobs changed since the last pass, a second early', async () => {
    const since = new Date(NOW.getTime() - 2 * HOUR);
    const { client, worker, savedCursors } = setup({
      JOB: { ...caughtUp, changesCompletedAt: new Date(NOW.getTime() - 2 * HOUR), changesSince: since },
    });
    client.requestDetailed.mockResolvedValueOnce(page('jobs', [{ id: 'job-1' }], false, null));

    await worker.run(ORG, NOW);

    expect(client.requestDetailed.mock.calls[0][1]).toContain('updatedAt: { after: $since }');
    expect(client.requestDetailed.mock.calls[0][2]).toEqual({ first: 25, after: null, since: new Date(since.getTime() - 1_000).toISOString() });
    expect(savedCursors()[0]).toMatchObject({ changesCursor: null, changesCompletedAt: NOW, changesSince: new Date(NOW.getTime() - 5 * 60_000) });
  });

  it('re-reads visits in a window of start dates, since visits have no update time', async () => {
    const { client, worker } = setup({ VISIT: { ...caughtUp, changesCompletedAt: new Date(NOW.getTime() - 2 * HOUR) } });
    client.requestDetailed.mockResolvedValueOnce(page('visits', [], false, null));

    await worker.run(ORG, NOW);

    expect(client.requestDetailed.mock.calls[0][2]).toEqual({
      first: 25,
      after: null,
      from: new Date(NOW.getTime() - 30 * 24 * HOUR).toISOString(),
      to: new Date(NOW.getTime() + 120 * 24 * HOUR).toISOString(),
    });
  });

  it('reads nothing for a kind that caught up within the hour', async () => {
    const { client, worker } = setup();
    const result = await worker.run(ORG, NOW);
    expect(client.requestDetailed).not.toHaveBeenCalled();
    expect(result.kinds).toEqual([]);
  });

  it('walks properties again daily, since Jobber gives them no update time', async () => {
    const { client, worker } = setup({ PROPERTY: { ...caughtUp, walkCompletedAt: new Date(NOW.getTime() - 25 * HOUR) } });
    client.requestDetailed.mockResolvedValueOnce(page('properties', [], false, null));
    const result = await worker.run(ORG, NOW);
    expect(result.kinds[0]).toMatchObject({ kind: 'PROPERTY', mode: 'walk' });
  });
});

describe('when something goes wrong', () => {
  it('records a failing kind and carries on with the next', async () => {
    const { client, worker, prisma } = setup({ CLIENT: {}, JOB: {} });
    client.requestDetailed
      .mockRejectedValueOnce(new JobberError("Field 'isCompany' doesn't exist", 'JOBBER_GRAPHQL_ERROR'))
      .mockResolvedValueOnce(page('jobs', [{ id: 'job-1' }], false, null));

    const result = await worker.run(ORG, NOW);

    expect(result.kinds.map((k) => [k.kind, k.problem])).toEqual([
      ['CLIENT', 'JOBBER_GRAPHQL_ERROR'],
      ['JOB', null],
    ]);
    expect(prisma.jobberMirrorCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId_kind: { organizationId: ORG, kind: 'CLIENT' } },
        update: expect.objectContaining({ lastError: 'JOBBER_GRAPHQL_ERROR', lastErrorAt: NOW }),
      }),
    );
  });

  it('stops the whole run on THROTTLED, keeping every cursor, so the next tick resumes the same kind', async () => {
    const { client, worker, sleep } = setup({ CLIENT: {}, JOB: {} });
    const throttled = new JobberError('Throttled', 'JOBBER_THROTTLED', 429, true);
    client.requestDetailed.mockRejectedValue(throttled);

    const result = await worker.run(ORG, NOW);

    expect(result.kinds).toEqual([expect.objectContaining({ kind: 'CLIENT', problem: 'THROTTLED' })]);
    expect(saveMirrorPage).not.toHaveBeenCalled();
    // Two short waits, then it gives the tick back.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('waits for the bucket to refill before the next page', async () => {
    const { client, worker, sleep } = setup({ JOB: {} });
    client.requestDetailed
      .mockResolvedValueOnce(page('jobs', [{ id: 'job-1' }], true, 'c-1', 500))
      .mockResolvedValueOnce(page('jobs', [], false, null));

    await worker.run(ORG, NOW);

    // (1,000 requested + 1,000 reserve - 500 available) / 500 a second = 3 seconds.
    expect(sleep).toHaveBeenCalledWith(3_000);
  });

  it('reads nothing when Jobber is not connected', async () => {
    const { client, worker } = setup({ JOB: {} }, false);
    expect(await worker.run(ORG, NOW)).toEqual({ skipped: 'NOT_CONNECTED', pages: 0, kinds: [] });
    expect(client.requestDetailed).not.toHaveBeenCalled();
  });

  it('never reads more than forty pages in a run', async () => {
    const { client, worker } = setup(Object.fromEntries(MIRROR_KINDS.map((k) => [k.kind, {}])));
    let n = 0;
    client.requestDetailed.mockImplementation(async (_org: string, query: string) => {
      const connection = MIRROR_KINDS.find((k) => query.includes(`${k.connection}(first:`))!.connection;
      n += 1;
      return page(connection, [{ id: `r-${n}` }], true, `c-${n}`);
    });

    const result = await worker.run(ORG, NOW);

    expect(result.pages).toBe(40);
    expect(client.requestDetailed).toHaveBeenCalledTimes(40);
  });
});
