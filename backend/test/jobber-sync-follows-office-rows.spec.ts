import { followJobber } from '../src/admin/actual-vs-budget-follow-jobber';
import { JobberSyncWorker } from '../src/workers/jobber-sync/jobber-sync.worker';

/**
 * The office's rows in Actual vs Budget follow their jobs after a run of the
 * Jobber sync (2026-11-23) -- only one that read the rolling window to the end:
 * the visits it did not read again are the ones Jobber no longer has, and a
 * backfill's slice of the past says nothing about where a job is now.
 */

jest.mock('../src/admin/actual-vs-budget-follow-jobber', () => ({
  followJobber: jest.fn().mockResolvedValue({ moved: 0, folded: 0, left: 0, failed: 0 }),
}));
const follow = followJobber as jest.MockedFunction<typeof followJobber>;

const ORG = '00000000-0000-4000-8000-000000000001';

function build() {
  const prisma = {
    jobberOutboundTask: { findMany: jest.fn().mockResolvedValue([]) },
    jobberConnection: {
      findUnique: jest.fn().mockResolvedValue({ status: 'CONNECTED' }),
      update: jest.fn().mockResolvedValue({}),
    },
    inspection: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const client = {
    requestDetailed: jest.fn().mockResolvedValue({
      data: { visits: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      cost: undefined,
    }),
  };
  const mapping = { buildingIndex: jest.fn().mockResolvedValue(new Map()) };
  return { worker: new JobberSyncWorker(prisma as never, client as never, mapping as never), prisma, client };
}

describe("after a run of the Jobber sync, the office's rows follow their jobs", () => {
  beforeEach(() => follow.mockClear());

  it('after the rolling window, read to the end: from when the run started, to its last day in Texas', async () => {
    const { worker, prisma, client } = build();
    await worker.run(ORG);

    expect(follow).toHaveBeenCalledTimes(1);
    const [, organizationId, window] = follow.mock.calls[0]!;
    expect(organizationId).toBe(ORG);
    // The run's own start, as it recorded it: a visit stored before then and not read since is gone from Jobber.
    const started = prisma.jobberConnection.update.mock.calls[0]![0].data.lastSyncStartedAt as Date;
    expect(window.since).toBe(started);
    const asked = client.requestDetailed.mock.calls[0]![2] as { startAfter: string; startBefore: string };
    const texasDay = (instant: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(instant));
    expect(window).toEqual({ since: started, to: texasDay(asked.startBefore) });
  });

  it('never after a backfill', async () => {
    const { worker } = build();
    await worker.run(ORG, { startAfter: '2026-07-01T00:00:00.000Z', startBefore: '2026-10-01T00:00:00.000Z' });
    expect(follow).not.toHaveBeenCalled();
  });

  it('a failure there does not fail the run: it still says it completed', async () => {
    const { worker, prisma } = build();
    follow.mockRejectedValueOnce(new Error('database went away'));
    await expect(worker.run(ORG)).resolves.toMatchObject({ truncated: false });
    expect(prisma.jobberConnection.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastSyncCompletedAt: expect.any(Date) }) }),
    );
  });
});
