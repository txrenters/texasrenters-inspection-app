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
 * Keeping the timesheet up to date while the technicians are still out.
 *
 * Nothing on the handset starts or stops a clock; the circle is applied to the
 * trail here, every few minutes. What is pinned is that it reads the right
 * days, and that it keeps going: one technician whose day cannot be read must
 * never stop the sweep, because the ones behind them in the list are other
 * people's pay.
 */

const CronJobMock = CronJob as unknown as jest.Mock;

const TRACKED = [
  { organizationId: 'org-1', technicianId: 'tech-1' },
  { organizationId: 'org-2', technicianId: 'tech-2' },
];

/** Three in the afternoon in Texas, 6 October 2026: yesterday has settled. */
const AFTERNOON = new Date('2026-10-06T20:00:00.000Z');
/** Eight in the morning the same day: yesterday may still be arriving. */
const MORNING = new Date('2026-10-06T13:00:00.000Z');

const read = (changed = false) => ({ changed });

function build(rows: unknown[] = TRACKED, recompute: jest.Mock = jest.fn().mockResolvedValue(read())) {
  const groupBy = jest.fn().mockResolvedValue(rows);
  const prisma = { technicianLocationPing: { groupBy } } as unknown as PrismaService;
  const time = { recomputeDayAutomatically: recompute } as unknown as TimeTrackingService;
  return { scheduler: new TimeTrackingScheduler(prisma, time), groupBy, recompute };
}

beforeEach(() => {
  CronJobMock.mockClear();
  delete process.env.TIME_TRACKING_SWEEP_ENABLED;
  delete process.env.TIME_TRACKING_SWEEP_CRON;
});

describe('scheduling the sweep', () => {
  /** Often enough that the hours move while the office is watching the map. */
  it('runs every five minutes by default', () => {
    build().scheduler.onModuleInit();

    expect(CronJobMock.mock.calls[0]![0]).toBe('*/5 * * * *');
    expect(CronJobMock.mock.results[0]!.value.start).toHaveBeenCalled();
  });

  /**
   * The timer is wired to the sweep, which the tests below then drive
   * directly. Worth its own assertion: everything else here would pass just as
   * happily if `onModuleInit` had registered a callback that did nothing.
   */
  it('registers the sweep itself as the timer callback', async () => {
    const { scheduler, groupBy } = build();
    scheduler.onModuleInit();

    CronJobMock.mock.calls[0]![1]();
    await Promise.resolve();

    expect(groupBy).toHaveBeenCalled();
  });

  it('can be turned off without a code change', () => {
    process.env.TIME_TRACKING_SWEEP_ENABLED = 'false';

    build().scheduler.onModuleInit();

    expect(CronJobMock).not.toHaveBeenCalled();
  });
});

describe('sweeping', () => {
  it('reads today for everybody with a trail today, each under their own organization', async () => {
    const { scheduler, recompute, groupBy } = build();

    await scheduler.sweep(AFTERNOON);

    expect(recompute.mock.calls).toEqual([
      ['org-1', 'tech-1', '2026-10-06'],
      ['org-2', 'tech-2', '2026-10-06'],
    ]);
    // Today in Texas, not today in UTC: midnight there is five in the morning here.
    expect(groupBy.mock.calls[0]![0].where.recordedAt.gte).toEqual(new Date('2026-10-06T05:00:00.000Z'));
  });

  /**
   * A phone that went flat in the afternoon sends the end of the day when it
   * is next opened, which is the following morning. Reading a day only once,
   * when it ended, would bake in the short answer.
   */
  it('reads yesterday as well until noon, for the trail that arrives late', async () => {
    const { scheduler, recompute, groupBy } = build([TRACKED[0]]);

    await scheduler.sweep(MORNING);

    expect(recompute.mock.calls).toEqual([
      ['org-1', 'tech-1', '2026-10-05'],
      ['org-1', 'tech-1', '2026-10-06'],
    ]);
    expect(groupBy.mock.calls[0]![0].where.recordedAt.gte).toEqual(new Date('2026-10-05T05:00:00.000Z'));
  });

  /**
   * The property this whole class exists for. If one failure stopped the
   * sweep, it would silently cost every technician behind it in the list
   * their recorded hours.
   */
  it('keeps going when one technician’s day cannot be read', async () => {
    const recompute = jest.fn().mockResolvedValueOnce(null).mockResolvedValue(read(true));
    const { scheduler } = build(TRACKED, recompute);

    await scheduler.sweep(AFTERNOON);

    expect(recompute).toHaveBeenCalledTimes(2);
    expect(recompute).toHaveBeenLastCalledWith('org-2', 'tech-2', '2026-10-06');
  });

  it('does nothing when nobody has a trail', async () => {
    const { scheduler, recompute } = build([]);

    await scheduler.sweep(AFTERNOON);

    expect(recompute).not.toHaveBeenCalled();
  });

  /** A slow sweep must not stack on the next tick and read everything twice. */
  it('will not run on top of itself', async () => {
    // The first reading hangs until the test lets it go, and `reached` is how
    // the test knows the sweep is actually inside it. Releasing on a timer
    // instead is the same test with a race in it.
    let release = () => {};
    let reached = () => {};
    const inTheFirst = new Promise<void>((resolve) => (reached = resolve));
    const recompute = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(null);
            reached();
          }),
      )
      .mockResolvedValue(read());
    const { scheduler } = build(TRACKED, recompute);

    const first = scheduler.sweep(AFTERNOON);
    await inTheFirst;
    await scheduler.sweep(AFTERNOON); // while the first is still held on the reading above
    release();
    await first;

    // Two readings from the first sweep, and nothing from the second.
    expect(recompute).toHaveBeenCalledTimes(2);
  });

  /**
   * Never throw out of a cron callback: an unhandled rejection takes the
   * process down, and a missed sweep is not worth an outage.
   */
  it('survives the database being unreachable', async () => {
    const groupBy = jest.fn().mockRejectedValue(new Error('database unreachable'));
    const prisma = { technicianLocationPing: { groupBy } } as unknown as PrismaService;
    const time = { recomputeDayAutomatically: jest.fn() } as unknown as TimeTrackingService;
    const scheduler = new TimeTrackingScheduler(prisma, time);

    await expect(scheduler.sweep(AFTERNOON)).resolves.toBeUndefined();
  });
});
