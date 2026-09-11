import { JobberSyncWorker } from '../src/workers/jobber-sync/jobber-sync.worker';
import { JobberError } from '../src/integrations/jobber/jobber.errors';

/**
 * Reaching a quarter the rolling window cannot see.
 *
 * The scheduled sync looks seven days back and sixty forward, which is right
 * for keeping up and cannot reach the past at all. The console showed only
 * September's occupied inspections for that reason — July and August were never
 * outside the window, they were never inside one, and no number of runs would
 * change that.
 *
 * The second thing here is the cap. `MAX_PAGES × PAGE_SIZE` is 5,000 visits and
 * the loop simply falls out when it is reached, so a truncated run used to be
 * indistinguishable from a complete one. That is tolerable for a rolling
 * seven-day window and not tolerable for a backfill over a quarter, where
 * nobody knows the visit count in advance.
 */

const ORG = '00000000-0000-4000-8000-000000000001';

/** The variables of one call: (organizationId, query, variables, correlationId). */
const window = (client: { requestDetailed: jest.Mock }, call: number) =>
  client.requestDetailed.mock.calls[call][2] as { startAfter: string; startBefore: string };

function build(pages: number) {
  const prisma = {
    jobberConnection: {
      findUnique: jest.fn().mockResolvedValue({ status: 'CONNECTED' }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const mapping = { buildingIndex: jest.fn().mockResolvedValue(new Map()) };

  let served = 0;
  const client = {
    // `requestDetailed`, which is what the paged sync uses -- it needs the
    // throttle cost back to pace itself, and `request` does not return it.
    requestDetailed: jest.fn(() => {
      served += 1;
      return Promise.resolve({
        data: {
          visits: {
            nodes: [],
            // Never runs out, so the only thing that stops the loop is the cap.
            pageInfo: { hasNextPage: served < pages, endCursor: `cursor-${served}` },
          },
        },
        cost: undefined,
      });
    }),
  };

  const worker = new JobberSyncWorker(prisma as never, client as never, mapping as never);
  return { worker, client };
}

describe('a throttled page', () => {
  beforeEach(() => {
    // The retry waits real seconds; the test should not.
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  /** Jobber rejecting a query, exactly as `JobberClient` reports it. */
  const throttled = () =>
    new JobberError('Jobber rejected the query.', 'JOBBER_GRAPHQL_ERROR', 429, true);

  it('waits and asks for the same page again', async () => {
    /**
     * The whole Q3 backfill died on one of these, after importing forty
     * inspections. `JobberClient` had already decided a THROTTLED response was
     * recoverable and set `retryable` on the error -- and nothing read it, so
     * the sync gave up on a failure it had itself labelled as temporary.
     *
     * The *same* cursor is retried rather than advancing: a rejected page
     * returned nothing, so moving on would skip the visits it would have
     * carried, silently, which is worse than stopping.
     */
    const { worker, client } = build(1);
    client.requestDetailed
      .mockRejectedValueOnce(throttled())
      .mockResolvedValueOnce({
        data: {
          visits: { nodes: [], pageInfo: { hasNextPage: false, endCursor: '' } },
        },
        cost: undefined,
      });

    const running = worker.run(ORG, {
      startAfter: '2026-07-01T00:00:00.000Z',
      startBefore: '2026-10-01T00:00:00.000Z',
    });
    await jest.advanceTimersByTimeAsync(10_000);
    await running;

    expect(client.requestDetailed).toHaveBeenCalledTimes(2);
    // Same cursor both times: the first attempt carried none, so neither does
    // the retry.
    expect(window(client, 1).startAfter).toBe(window(client, 0).startAfter);
  });

  it('gives up rather than hanging on a Jobber outage', async () => {
    // Patience is finite. A throttle clears in seconds; something that never
    // clears is an outage, and a backfill that hangs on it forever tells
    // nobody anything.
    const { worker, client } = build(1);
    client.requestDetailed.mockRejectedValue(throttled());

    const running = worker.run(ORG, {
      startAfter: '2026-07-01T00:00:00.000Z',
      startBefore: '2026-10-01T00:00:00.000Z',
    });
    const settled = expect(running).rejects.toMatchObject({ code: 'JOBBER_GRAPHQL_ERROR' });
    await jest.advanceTimersByTimeAsync(600_000);
    await settled;
  });

  it('does not retry a failure Jobber called permanent', async () => {
    // A schema mismatch or a revoked token is not going to improve by waiting,
    // and retrying it five times just delays the report by four minutes.
    const { worker, client } = build(1);
    client.requestDetailed.mockRejectedValue(
      new JobberError('Bad request.', 'JOBBER_GRAPHQL_ERROR', 502, false),
    );

    await expect(
      worker.run(ORG, {
        startAfter: '2026-07-01T00:00:00.000Z',
        startBefore: '2026-10-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'JOBBER_GRAPHQL_ERROR' });
    expect(client.requestDetailed).toHaveBeenCalledTimes(1);
  });
});

describe('syncing a named slice of the calendar', () => {
  it('asks Jobber for the window it was given, not the rolling one', async () => {
    const { worker, client } = build(1);

    await worker.run(ORG, {
      startAfter: '2026-07-01T00:00:00.000Z',
      startBefore: '2026-10-01T00:00:00.000Z',
    });

    const variables = window(client, 0);
    expect(variables).toMatchObject({
      startAfter: '2026-07-01T00:00:00.000Z',
      startBefore: '2026-10-01T00:00:00.000Z',
    });
  });

  it('falls back to the rolling window when given none', async () => {
    // The scheduled sync passes nothing and must keep the behaviour it had.
    const { worker, client } = build(1);

    await worker.run(ORG);

    const variables = window(client, 0);
    expect(variables.startAfter).toBeTruthy();
    expect(variables.startBefore).toBeTruthy();
    // Seven days back by default, so the start is in the recent past rather
    // than a quarter ago.
    const daysBack = (Date.now() - Date.parse(variables.startAfter)) / 86_400_000;
    expect(daysBack).toBeLessThan(30);
  });

  it('says so when it stopped at the page cap', async () => {
    /**
     * The number without this flag is a floor, not a total, and nothing said
     * so. A backfill that quietly covered half a quarter would look exactly
     * like one that covered all of it — and the half it missed is invisible in
     * the console, which is where somebody would go to check.
     */
    const { worker } = build(Number.POSITIVE_INFINITY);

    const result = await worker.run(ORG, {
      startAfter: '2026-07-01T00:00:00.000Z',
      startBefore: '2026-10-01T00:00:00.000Z',
    });

    expect(result.truncated).toBe(true);
  });

  it('does not cry wolf when Jobber ran out of pages', async () => {
    const { worker } = build(3);

    const result = await worker.run(ORG, {
      startAfter: '2026-07-01T00:00:00.000Z',
      startBefore: '2026-10-01T00:00:00.000Z',
    });

    expect(result.truncated).toBe(false);
  });
});
