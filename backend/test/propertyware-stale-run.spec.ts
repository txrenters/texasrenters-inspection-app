import {
  PropertywareSyncCoordinator,
  STALE_SYNC_RUN_AFTER_MS,
} from '../src/workers/propertyware-sync/propertyware-sync.coordinator';

function coordinator(updateMany: jest.Mock) {
  const prisma = { propertywareSyncRun: { updateMany } };
  return new PropertywareSyncCoordinator({} as never, prisma as never);
}

const NOW = new Date('2026-08-02T12:00:00.000Z');

describe('abandoned Propertyware sync runs', () => {
  it('closes a run whose process died, so syncing is not blocked forever', async () => {
    // A run left RUNNING makes the worker cancel every subsequent one — it
    // returns CANCELLED with no entities, which from outside looks like a clean
    // exit. One interrupted sync silently blocked all future syncs.
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    expect(await coordinator(updateMany).reclaimStaleRuns(NOW)).toBe(1);

    const [request] = updateMany.mock.calls[0];
    expect(request.where.status).toBe('RUNNING');
    expect(request.data).toMatchObject({ status: 'FAILED', completedAt: NOW });
  });

  it('only reclaims runs older than the stale window', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    await coordinator(updateMany).reclaimStaleRuns(NOW);

    const [request] = updateMany.mock.calls[0];
    const cutoff = new Date(NOW.getTime() - STALE_SYNC_RUN_AFTER_MS);
    // A legitimately slow initial sync must never be reclaimed out from under
    // itself while it is still working.
    expect(request.where.OR[0].startedAt.lt).toEqual(cutoff);
  });

  it('also reclaims a run that died before it recorded a start time', async () => {
    // startedAt stays null when the process dies between creating the run and
    // beginning it. Matching only on startedAt would leave those rows blocking
    // syncing forever.
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    await coordinator(updateMany).reclaimStaleRuns(NOW);

    const [request] = updateMany.mock.calls[0];
    expect(request.where.OR[1]).toMatchObject({ startedAt: null });
    expect(request.where.OR[1].createdAt.lt).toEqual(
      new Date(NOW.getTime() - STALE_SYNC_RUN_AFTER_MS),
    );
  });

  it('never lets a failed scan take the application down', async () => {
    // Not reclaiming leaves syncing blocked, which is bad. Refusing to boot is
    // worse.
    const updateMany = jest.fn().mockRejectedValue(new Error('database unreachable'));
    await expect(coordinator(updateMany).reclaimStaleRuns(NOW)).resolves.toBe(0);
  });
});
