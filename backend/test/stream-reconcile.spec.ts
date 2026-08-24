import 'reflect-metadata';

import { InspectionVideoService } from '../src/media/inspection-video.service';
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

/**
 * Playback when our record says "not ready" and Cloudflare disagrees.
 *
 * `readyAt` is written in one place — the webhook — so a delivery that never
 * arrives leaves it null while the rest of the record moves on. The observed
 * result was a recording whose badge read Ready, whose findings were present,
 * and whose player still said Cloudflare was preparing it, above a "Check
 * again" button that re-read the same null and could never succeed.
 */
describe('playback asks Cloudflare before reporting "still processing"', () => {
  const UID = 'uid-1';

  function build(video: unknown, afterApply: { readyAt: Date | null }) {
    const media = {
      id: 'media-1',
      provider: 'cloudflare_stream',
      streamUid: UID,
      storageKey: null,
      processingStatus: 'READY_FOR_REVIEW',
      readyAt: null,
      uploadStatus: 'UPLOADED',
      durationSeconds: 120,
      thumbnailUrl: null,
      failureMessage: null,
      inspectionId: 'insp-1',
      inspectionAreaId: 'area-1',
      organizationId: 'org-1',
    };
    const prisma = {
      inspectionMedia: {
        findFirst: jest.fn().mockResolvedValue(media),
        findUnique: jest.fn().mockResolvedValue({ ...media, ...afterApply }),
        update: jest.fn().mockResolvedValue({}),
      },
      inspectionArea: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const stream = {
      customerCode: 'cust',
      getVideo: jest.fn().mockResolvedValue(video),
      signPlaybackToken: jest.fn().mockReturnValue({ token: 'tok', expiresAt: new Date() }),
    };
    return { prisma, stream };
  }

  const reviewer = {
    id: 'u1',
    organizationId: 'org-1',
    permissions: ['inspections:read'],
  } as never;

  it('serves the recording when Cloudflare says the encode finished', async () => {
    const { prisma, stream } = build(
      {
        streamUid: UID,
        state: 'ready',
        durationSeconds: 120,
        widthPx: 1920,
        heightPx: 1080,
        thumbnailUrl: null,
        errorReasonText: null,
      },
      { readyAt: new Date() },
    );
    const service = new InspectionVideoService(prisma as never, stream as never);

    const result = await service.getPlayback(reviewer, 'media-1');

    expect(result.status).toBe('ready');
    expect(stream.getVideo).toHaveBeenCalledWith(UID);
  });

  it('still reports processing when Cloudflare is genuinely not finished', async () => {
    const { prisma, stream } = build(
      {
        streamUid: UID,
        state: 'inprogress',
        durationSeconds: null,
        widthPx: null,
        heightPx: null,
        thumbnailUrl: null,
        errorReasonText: null,
      },
      { readyAt: null },
    );
    const service = new InspectionVideoService(prisma as never, stream as never);

    await expect(service.getPlayback(reviewer, 'media-1')).resolves.toMatchObject({
      status: 'processing',
    });
  });

  it('reports processing rather than throwing when Cloudflare cannot be reached', async () => {
    // A provider outage must not turn a viewable area into an error page.
    const { prisma, stream } = build(null, { readyAt: null });
    stream.getVideo = jest.fn().mockRejectedValue(new Error('network'));
    const service = new InspectionVideoService(prisma as never, stream as never);

    await expect(service.getPlayback(reviewer, 'media-1')).resolves.toMatchObject({
      status: 'processing',
    });
  });
});
