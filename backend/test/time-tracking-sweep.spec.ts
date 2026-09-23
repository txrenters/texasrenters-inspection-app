// Mock the cron library so scheduling registers no real timers in tests.
jest.mock('cron', () => ({
  CronJob: jest.fn().mockImplementation((expression: string, onTick: () => void) => ({
    expression,
    onTick,
    start: jest.fn(),
    stop: jest.fn(),
  })),
}));

import { CronJob } from 'cron';

import type { PrismaService } from '../src/common/prisma.service';
import type { TimeTrackingService } from '../src/time-tracking/time-tracking.service';
import { TimeTrackingScheduler } from '../src/time-tracking/time-tracking.scheduler';

/**
 * Reading a submitted job's hours again, a while after it was submitted.
 *
 * The sweep exists because the handset flushes its trail late — out of signal
 * at a rural property, then everything at once on the drive home. What is
 * pinned here is that it keeps going: one job whose hours cannot be read must
 * never stop the sweep, because the jobs behind it in the list are other
 * people's pay.
 */

const CronJobMock = CronJob as unknown as jest.Mock;

const DUE = [
  { id: 'insp-1', organizationId: 'org-1' },
  { id: 'insp-2', organizationId: 'org-2' },
];

function build(
  rows: unknown[] = DUE,
  recompute: jest.Mock = jest.fn().mockResolvedValue({ onsiteSeconds: 3_600 }),
) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const prisma = { inspection: { findMany } } as unknown as PrismaService;
  const time = { recomputeAutomatically: recompute } as unknown as TimeTrackingService;
  return { scheduler: new TimeTrackingScheduler(prisma, time), findMany, recompute };
}


beforeEach(() => {
  CronJobMock.mockClear();
  delete process.env.TIME_TRACKING_SWEEP_ENABLED;
  delete process.env.TIME_TRACKING_SWEEP_CRON;
});

describe('scheduling the sweep', () => {
  it('runs every quarter of an hour by default', () => {
    build().scheduler.onModuleInit();

    expect(CronJobMock.mock.calls[0]![0]).toBe('*/15 * * * *');
    expect(CronJobMock.mock.results[0]!.value.start).toHaveBeenCalled();
  });

  /**
   * The timer is wired to the sweep, which the tests below then drive
   * directly. Worth its own assertion: everything else here would pass just as
   * happily if `onModuleInit` had registered a callback that did nothing.
   */
  it('registers the sweep itself as the timer callback', async () => {
    const { scheduler, findMany } = build();
    scheduler.onModuleInit();

    CronJobMock.mock.calls[0]![1]();
    await Promise.resolve();

    expect(findMany).toHaveBeenCalled();
  });

  it('can be turned off without a code change', () => {
    process.env.TIME_TRACKING_SWEEP_ENABLED = 'false';

    build().scheduler.onModuleInit();

    expect(CronJobMock).not.toHaveBeenCalled();
  });
});

describe('sweeping', () => {
  it('reads each recently submitted job under its own organization', async () => {
    const { scheduler, recompute } = build();

    await scheduler.sweep();

    expect(recompute).toHaveBeenCalledWith('org-1', 'insp-1');
    expect(recompute).toHaveBeenCalledWith('org-2', 'insp-2');
  });

  it('only looks at jobs submitted recently', async () => {
    const { scheduler, findMany } = build();

    await scheduler.sweep();

    // A window, not the whole table: every job ever submitted recomputed every
    // quarter of an hour would be a different feature and a much heavier one.
    const since = findMany.mock.calls[0]![0].where.submittedAt.gte as Date;
    const hoursBack = (Date.now() - since.getTime()) / 3_600_000;
    expect(hoursBack).toBeGreaterThan(5);
    expect(hoursBack).toBeLessThan(7);
  });

  /**
   * The property this whole class exists for.
   *
   * A job with no coordinates cannot be measured, and that is an ordinary fact
   * about a job rather than an emergency. If it stopped the sweep, one bad
   * property would silently cost every technician behind it in the list their
   * recorded hours.
   */
  it('keeps going when one job cannot be measured', async () => {
    const recompute = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ onsiteSeconds: 3_600 });
    const { scheduler } = build(DUE, recompute);

    await scheduler.sweep();

    expect(recompute).toHaveBeenCalledTimes(2);
    expect(recompute).toHaveBeenLastCalledWith('org-2', 'insp-2');
  });

  it('does nothing when nothing has been submitted', async () => {
    const { scheduler, recompute } = build([]);

    await scheduler.sweep();

    expect(recompute).not.toHaveBeenCalled();
  });

  /** A slow sweep must not stack on the next tick and read everything twice. */
  it('will not run on top of itself', async () => {
    // The first job hangs until the test lets it go, and `reached` is how the
    // test knows the sweep is actually inside it. Releasing on a timer instead
    // is the same test with a race in it.
    let release = () => {};
    let reached = () => {};
    const inTheFirstJob = new Promise<void>((resolve) => (reached = resolve));
    const recompute = jest.fn().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(null);
          reached();
        }),
    );
    const { scheduler } = build(DUE, recompute);

    const first = scheduler.sweep();
    await inTheFirstJob;
    await scheduler.sweep(); // while the first is still held on the job above
    release();
    await first;

    // Two jobs from the first sweep, and nothing from the second.
    expect(recompute).toHaveBeenCalledTimes(2);
  });

  /**
   * Never throw out of a cron callback: an unhandled rejection takes the
   * process down, and a missed sweep is not worth an outage.
   */
  it('survives the database being unreachable', async () => {
    const findMany = jest.fn().mockRejectedValue(new Error('database unreachable'));
    const prisma = { inspection: { findMany } } as unknown as PrismaService;
    const time = { recomputeAutomatically: jest.fn() } as unknown as TimeTrackingService;
    const scheduler = new TimeTrackingScheduler(prisma, time);

    await expect(scheduler.sweep()).resolves.toBeUndefined();
  });
});
