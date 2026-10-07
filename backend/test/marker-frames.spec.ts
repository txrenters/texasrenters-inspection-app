import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { CreateUploadSessionDto } from '../src/media/inspection-video.dto';
import { captureSummaryOf } from '../src/media/inspection-video.service';
import { markerPhotoKey, MAX_EXTRACTED_FRAMES, readMarkers } from '../src/technician/marker-frames';
import { MediaProcessingService } from '../src/technician/media-processing.service';

/**
 * The moments an Android technician marks while filming (2026-10-06).
 *
 * The phone used to cut those frames out of the finished video itself, once
 * per marker, before the review screen could open -- on a battery the move-out
 * was already spending. It now sends the moments with the upload, and the
 * server files each one from Cloudflare's frame service.
 */

describe('the marked moments in a capture summary', () => {
  it('keeps the kind of photograph the technician was taking', () => {
    const summary = {
      frameMarkersMs: [1_000, 4_000],
      frameMarkers: [
        { atMs: 1_000, captureType: 'FINDING_DETAIL' },
        { atMs: 4_000, captureType: 'AREA_OVERVIEW' },
      ],
    };
    expect(readMarkers(summary, 10)).toEqual([
      { atMs: 1_000, captureType: 'FINDING_DETAIL' },
      { atMs: 4_000, captureType: 'AREA_OVERVIEW' },
    ]);
  });

  it('reads an older summary the way the multipart upload filed it: overview first, then context', () => {
    expect(readMarkers({ frameMarkersMs: [3_000, 1_000] }, 10)).toEqual([
      { atMs: 1_000, captureType: 'AREA_OVERVIEW' },
      { atMs: 3_000, captureType: 'FINDING_CONTEXT' },
    ]);
  });

  it('ignores a moment past the end, a kind it does not know, and anything that is not a summary', () => {
    const summary = {
      frameMarkersMs: [2_000, 99_000],
      frameMarkers: [{ atMs: 2_000, captureType: 'NOT_A_KIND' }],
    };
    expect(readMarkers(summary, 10)).toEqual([{ atMs: 2_000, captureType: 'AREA_OVERVIEW' }]);
    expect(readMarkers(null, 10)).toEqual([]);
    expect(readMarkers('frames', 10)).toEqual([]);
  });
});

describe('the capture a Stream upload session carries', () => {
  const dto = (capture: unknown) =>
    plainToInstance(CreateUploadSessionDto, {
      inspectionAreaId: '10000000-0000-4000-8000-00000000000a',
      filename: 'kitchen.mp4',
      mimeType: 'video/mp4',
      fileSize: 12_000_000,
      durationSeconds: 90,
      idempotencyKey: 'queue-1',
      capture,
    });

  it('is accepted with its markers and their kinds', () => {
    const errors = validateSync(
      dto({
        coverageStatus: 'COMPLETE',
        sensorConfidence: 'HIGH',
        clockwiseRotationDegrees: 361,
        returnedToStart: true,
        frameMarkers: [{ atMs: 1_500, captureType: 'FINDING_DETAIL' }],
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors).toEqual([]);
  });

  it('is optional: a phone from before it was sent still gets a session', () => {
    expect(validateSync(dto(undefined), { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
  });

  it.each([
    ['a kind of photograph that does not exist', { frameMarkers: [{ atMs: 1, captureType: 'SELFIE' }] }],
    ['a negative moment', { frameMarkers: [{ atMs: -1, captureType: 'FINDING_DETAIL' }] }],
    [
      'more markers than one recording may file',
      {
        frameMarkers: Array.from({ length: MAX_EXTRACTED_FRAMES + 1 }, (_, atMs) => ({
          atMs,
          captureType: 'FINDING_DETAIL',
        })),
      },
    ],
    ['a field it does not name', { frameMarkers: [], uploadedBy: 'someone else' }],
  ])('refuses %s', (_label, capture) => {
    expect(validateSync(dto(capture), { whitelist: true, forbidNonWhitelisted: true })).not.toEqual([]);
  });

  it('is stored in the shape the multipart upload stores, with the kinds beside the moments', () => {
    const summary = captureSummaryOf({
      coverageStatus: 'COMPLETE',
      frameMarkers: [
        { atMs: 1_000, captureType: 'FINDING_DETAIL' },
        { atMs: 2_000, captureType: 'FINDING_CONTEXT' },
      ],
    } as never);
    expect(summary).toMatchObject({
      coverageStatus: 'COMPLETE',
      sensorConfidence: 'UNAVAILABLE',
      returnedToStart: false,
      frameMarkersMs: [1_000, 2_000],
    });
    // What the pipeline reads back is what the phone sent.
    expect(readMarkers(summary, 10)).toEqual([
      { atMs: 1_000, captureType: 'FINDING_DETAIL' },
      { atMs: 2_000, captureType: 'FINDING_CONTEXT' },
    ]);
  });
});

describe('filing the marked moments from Cloudflare', () => {
  const RECORDED_AT = new Date('2026-10-06T15:00:00.000Z');
  const media: {
    id: string;
    streamUid: string;
    durationSeconds: number;
    organizationId: string;
    inspectionId: string;
    inspectionAreaId: string;
    technicianId: string;
    recordedAt: Date;
    captureSummary: unknown;
  } = {
    id: 'media-1',
    streamUid: 'uid-1',
    durationSeconds: 60,
    organizationId: 'org-1',
    inspectionId: 'insp-1',
    inspectionAreaId: 'area-1',
    technicianId: 'tech-1',
    recordedAt: RECORDED_AT,
    captureSummary: {
      frameMarkersMs: [10_000, 20_000],
      frameMarkers: [
        { atMs: 10_000, captureType: 'FINDING_DETAIL' },
        { atMs: 20_000, captureType: 'FINDING_CONTEXT' },
      ],
    },
  };
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function build(existingKeys: string[] = []) {
    const prisma = {
      inspectionPhoto: {
        findUnique: jest.fn(async ({ where }: { where: { idempotencyKey: string } }) =>
          existingKeys.includes(where.idempotencyKey) ? { id: 'photo-0' } : null,
        ),
        create: jest.fn().mockResolvedValue({ id: 'photo-1' }),
      },
      mediaProcessingEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const storage = {
      putBytes: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      providerName: () => 'r2',
    };
    const stream = {
      customerCode: 'abc123',
      signPlaybackToken: jest.fn().mockReturnValue({ token: 'signed' }),
    };
    const service = new MediaProcessingService(
      prisma as never,
      storage as never,
      {} as never,
      undefined,
      stream as never,
    );
    const file = (
      service as unknown as { fileStreamMarkerFrames: (m: typeof media) => Promise<void> }
    ).fileStreamMarkerFrames.bind(service);
    return { prisma, storage, stream, file };
  }

  /** Cloudflare's frame service, answering every frame unless told which to refuse. */
  function frames(refuse: (url: string) => boolean = () => false) {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      return refuse(url)
        ? { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
        : { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer };
    }) as never;
    return asked;
  }

  it('files each moment as the photograph the technician took, at the time it was taken', async () => {
    const asked = frames();
    const { prisma, storage, file } = build();

    await file(media);

    expect(asked).toEqual([
      'https://customer-abc123.cloudflarestream.com/signed/thumbnails/thumbnail.jpg?time=10.000s&height=1080',
      'https://customer-abc123.cloudflarestream.com/signed/thumbnails/thumbnail.jpg?time=20.000s&height=1080',
    ]);
    expect(storage.putBytes).toHaveBeenCalledWith(
      'organizations/org-1/inspections/insp-1/photos/media-1-snapshot-10000.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
    const [first, second] = prisma.inspectionPhoto.create.mock.calls.map(([call]) => call.data);
    expect(first).toMatchObject({
      inspectionAreaId: 'area-1',
      capturedById: 'tech-1',
      captureType: 'FINDING_DETAIL',
      idempotencyKey: markerPhotoKey('media-1', 10_000),
      metadata: { captureSource: 'VIDEO_FRAME_EXTRACTION', videoTimestampMs: 10_000, sourceMediaId: 'media-1' },
      captureTimeSource: 'VIDEO_OFFSET',
    });
    // Recorded at the end of a 60 s take: the 10 s mark was 50 s before it.
    expect(first.capturedAt).toEqual(new Date(RECORDED_AT.getTime() - 50_000));
    expect(second).toMatchObject({ captureType: 'FINDING_CONTEXT', sequenceNumber: 2 });
    expect(prisma.mediaProcessingEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'FRAMES_EXTRACTED',
        payloadSummary: { count: 2, source: 'cloudflare' },
      }),
    });
  });

  it('files nothing twice: a re-run finds the moment the console or the AI already filed', async () => {
    const asked = frames();
    const { prisma, file } = build([markerPhotoKey('media-1', 10_000)]);

    await file(media);

    expect(asked).toHaveLength(1);
    expect(prisma.inspectionPhoto.create).toHaveBeenCalledTimes(1);
    expect(prisma.inspectionPhoto.create.mock.calls[0][0].data.idempotencyKey).toBe(
      markerPhotoKey('media-1', 20_000),
    );
  });

  it('loses only the frame Cloudflare will not render, never the others', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      frames((url) => url.includes('time=10.000s'));
      const { prisma, file } = build();

      const run = file(media);
      await jest.runAllTimersAsync();
      await run;

      expect(prisma.inspectionPhoto.create).toHaveBeenCalledTimes(1);
      expect(prisma.inspectionPhoto.create.mock.calls[0][0].data.videoTimestampMs).toBeUndefined();
      expect(prisma.inspectionPhoto.create.mock.calls[0][0].data.metadata.videoTimestampMs).toBe(20_000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('takes the stored bytes back when the photograph cannot be recorded', async () => {
    frames();
    const { prisma, storage, file } = build();
    prisma.inspectionPhoto.create.mockRejectedValueOnce(new Error('unique constraint'));

    await expect(file(media)).resolves.toBeUndefined();

    expect(storage.delete).toHaveBeenCalledWith(
      'organizations/org-1/inspections/insp-1/photos/media-1-snapshot-10000.jpg',
    );
    expect(prisma.inspectionPhoto.create).toHaveBeenCalledTimes(2);
  });

  it('asks Cloudflare for nothing when the recording marked nothing', async () => {
    const asked = frames();
    const { stream, file } = build();

    await file({ ...media, captureSummary: { coverageStatus: 'COMPLETE' } });

    expect(asked).toEqual([]);
    expect(stream.signPlaybackToken).not.toHaveBeenCalled();
  });
});
