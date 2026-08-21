import 'reflect-metadata';

import { StreamReconcileScheduler } from '../src/media/stream-reconcile.scheduler';

/**
 * The safety net for a Stream webhook that never arrives.
 *
 * `reconcileStuckVideos` existed, was documented for precisely this failure,
 * and nothing called it — so a lost delivery left a recording unplayable, with
 * no transcript, no findings and an area that never reached COMPLETED. These
 * tests exist so it stays wired.
 */
describe('recovering recordings whose webhook never arrived', () => {
  function scheduler(reconcile: jest.Mock) {
    return new StreamReconcileScheduler({ reconcileStuckVideos: reconcile } as never);
  }

  afterEach(() => {
    delete process.env.STREAM_RECONCILE_CRON;
  });

  it('starts a job on init and stops it on destroy', () => {
    const instance = scheduler(jest.fn().mockResolvedValue({ checked: 0, reconciled: 0 }));

    instance.onModuleInit();
    expect((instance as unknown as { job?: { running?: boolean } }).job).toBeDefined();

    expect(() => instance.onModuleDestroy()).not.toThrow();
  });

  it('sweeps when the job fires', async () => {
    const reconcile = jest.fn().mockResolvedValue({ checked: 3, reconciled: 2 });
    const instance = scheduler(reconcile);

    await (instance as unknown as { sweep(): Promise<void> }).sweep();

    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('does not stack a second sweep on top of a slow one', async () => {
    // The interval is five minutes and a sweep is bounded, but a Cloudflare
    // call that hangs must not accumulate overlapping runs.
    let release!: (value: { checked: number; reconciled: number }) => void;
    const slow = new Promise<{ checked: number; reconciled: number }>((resolve) => {
      release = resolve;
    });
    const reconcile = jest.fn().mockReturnValueOnce(slow).mockResolvedValue({
      checked: 0,
      reconciled: 0,
    });
    const instance = scheduler(reconcile);
    const sweep = () => (instance as unknown as { sweep(): Promise<void> }).sweep();

    const first = sweep();
    await sweep();
    expect(reconcile).toHaveBeenCalledTimes(1);

    release({ checked: 1, reconciled: 0 });
    await first;

    // The guard releases with the run, so the next tick works normally.
    await sweep();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('swallows a failure rather than taking the process down', async () => {
    // An unhandled rejection out of a cron callback exits the process. A failed
    // sweep is not worth an outage.
    const instance = scheduler(jest.fn().mockRejectedValue(new Error('cloudflare unreachable')));

    await expect(
      (instance as unknown as { sweep(): Promise<void> }).sweep(),
    ).resolves.toBeUndefined();
  });
});
