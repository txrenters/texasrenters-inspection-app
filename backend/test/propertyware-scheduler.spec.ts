// Mock the cron library so scheduling registers no real timers in tests.
jest.mock('cron', () => ({
  CronJob: jest.fn().mockImplementation((expression: string, onTick: () => void) => {
    if (expression === 'INVALID') throw new Error('invalid cron expression');
    return {
      expression,
      onTick,
      start: jest.fn(),
      stop: jest.fn(),
      nextDate: () => ({ toISO: () => '2026-07-25T00:00:00.000Z' }),
    };
  }),
}));

import { CronJob } from 'cron';

import { PropertywareSyncScheduler } from '../src/workers/propertyware-sync/propertyware-sync.scheduler';

const CronJobMock = CronJob as unknown as jest.Mock;

function build(overrides: Record<string, unknown> = {}) {
  const coordinator = {
    enqueue: jest.fn().mockResolvedValue({ syncRunId: 'run-1', status: 'PENDING' }),
  };
  const config = {
    syncEnabled: true,
    schedulerOrganizationId: '10000000-0000-4000-8000-000000000001',
    incrementalSyncCron: '0 0 * * *',
    reconciliationCron: '0 2 * * *',
    ...overrides,
  };
  const scheduler = new PropertywareSyncScheduler(config as never, coordinator as never);
  return { scheduler, coordinator };
}

beforeEach(() => CronJobMock.mockClear());

describe('PropertywareSyncScheduler', () => {
  it('registers no jobs when automatic sync is disabled', () => {
    build({ syncEnabled: false }).scheduler.onModuleInit();
    expect(CronJobMock).not.toHaveBeenCalled();
  });

  it('registers no jobs when no organization is configured', () => {
    build({ schedulerOrganizationId: undefined }).scheduler.onModuleInit();
    expect(CronJobMock).not.toHaveBeenCalled();
  });

  it('schedules and starts both the incremental and reconciliation syncs', () => {
    const { scheduler } = build();
    scheduler.onModuleInit();
    expect(CronJobMock.mock.calls.map(([cron]) => cron)).toEqual(['0 0 * * *', '0 2 * * *']);
    for (const result of CronJobMock.mock.results) expect(result.value.start).toHaveBeenCalled();
    const described = scheduler.describe();
    expect(described.enabled).toBe(true);
    expect(described.jobs.map((job) => job.scheduled)).toEqual([true, true]);
    expect(described.jobs[0].nextRunAt).toBe('2026-07-25T00:00:00.000Z');
  });

  it('skips a job with an invalid cron expression but keeps the valid one', () => {
    const { scheduler } = build({ incrementalSyncCron: 'INVALID' });
    scheduler.onModuleInit();
    const described = scheduler.describe();
    expect(described.jobs.find((job) => job.mode === 'incremental')?.scheduled).toBe(false);
    expect(described.jobs.find((job) => job.mode === 'reconciliation')?.scheduled).toBe(true);
  });

  it('stops all jobs on shutdown', () => {
    const { scheduler } = build();
    scheduler.onModuleInit();
    const jobs = CronJobMock.mock.results.map((result) => result.value);
    scheduler.onModuleDestroy();
    for (const job of jobs) expect(job.stop).toHaveBeenCalled();
  });

  it('enqueues the correct sync for the configured org when a job fires', async () => {
    const { scheduler, coordinator } = build();
    scheduler.onModuleInit();
    // The incremental job is registered first; invoke its tick callback.
    const [, incrementalOnTick] = CronJobMock.mock.calls[0] as [string, () => void];

    incrementalOnTick();
    await new Promise((resolve) => setImmediate(resolve));

    expect(coordinator.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'incremental',
        organizationId: '10000000-0000-4000-8000-000000000001',
        requestedBy: 'scheduler:propertyware-incremental-sync',
        entities: expect.arrayContaining(['portfolios', 'buildings', 'units', 'leases']),
      }),
    );
  });
});
