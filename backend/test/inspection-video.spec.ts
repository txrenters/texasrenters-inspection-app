import { createHmac } from 'node:crypto';

import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { CloudflareStreamWebhookGuard } from '../src/media/cloudflare-stream-webhook.guard';
import { InspectionVideoService } from '../src/media/inspection-video.service';

const technician: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000004',
  authUserId: 'auth-tech',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Field Tech',
  roles: [UserRole.INSPECTION_TECHNICIAN],
  permissions: [],
  mustChangePassword: false,
};

const AREA_ID = '10000000-0000-4000-8000-00000000000a';

const validInput = {
  inspectionAreaId: AREA_ID,
  filename: 'kitchen.mp4',
  mimeType: 'video/mp4',
  fileSize: 12_000_000,
  durationSeconds: 90,
  idempotencyKey: 'queue-1',
};

const areaRecord = {
  id: AREA_ID,
  inspectionId: 'insp-1',
  inspection: { id: 'insp-1', status: 'IN_PROGRESS', propertyId: 'prop-1' },
};

function build(overrides: {
  area?: unknown;
  existing?: unknown;
  stream?: Partial<{ createDirectUpload: jest.Mock; getVideo: jest.Mock }>;
  /** The pipeline the webhook starts; absent in tests that do not assert on it. */
  mediaProcessing?: { queue: jest.Mock };
} = {}) {
  const prisma = {
    inspectionArea: {
      findFirst: jest.fn().mockResolvedValue('area' in overrides ? overrides.area : areaRecord),
      // The area's completion state moves with the upload: RECORDED when the
      // session is created, COMPLETED when Cloudflare confirms the bytes.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    inspectionMedia: {
      findUnique: jest.fn().mockResolvedValue(overrides.existing ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'media-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const stream = {
    createDirectUpload: jest.fn().mockResolvedValue({
      streamUid: 'uid-1',
      uploadUrl: 'https://upload.cloudflarestream.com/tus/abc',
      expiresAt: new Date(Date.now() + 3_000_000).toISOString(),
    }),
    getVideo: jest.fn(),
    ...overrides.stream,
  };
  return {
    prisma,
    stream,
    service: new InspectionVideoService(
      prisma as never,
      stream as never,
      overrides.mediaProcessing as never,
    ),
  };
}

describe('upload session authorization', () => {
  it('refuses an area the technician is not assigned to', async () => {
    // The lookup itself carries the assignment predicate, so an unassigned area
    // simply does not resolve — a caller cannot probe for which ids exist.
    const { service, prisma } = build({ area: null });
    await expect(service.createUploadSession(technician, validInput)).rejects.toMatchObject({
      code: 'ASSIGNED_ROOM_NOT_FOUND',
    });
    expect(prisma.inspectionArea.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          inspection: expect.objectContaining({
            organizationId: technician.organizationId,
            assignments: { some: { technicianId: technician.id, isCurrent: true } },
          }),
        }),
      }),
    );
  });

  it('refuses to attach evidence to an inspection that is not in progress', async () => {
    const { service } = build({
      area: { ...areaRecord, inspection: { ...areaRecord.inspection, status: 'COMPLETED' } },
    });
    await expect(service.createUploadSession(technician, validInput)).rejects.toMatchObject({
      code: 'INSPECTION_NOT_IN_PROGRESS',
    });
  });

  it('never contacts Cloudflare for a request it will reject', async () => {
    // Validation before the provider call: a rejected request must not create a
    // stray video in the account.
    const { service, stream } = build({ area: null });
    await service.createUploadSession(technician, validInput).catch(() => undefined);
    expect(stream.createDirectUpload).not.toHaveBeenCalled();
  });
});

describe('upload session validation', () => {
  const cases: [string, Partial<typeof validInput>, string][] = [
    ['a format Stream cannot take', { mimeType: 'video/avi' }, 'UNSUPPORTED_VIDEO_TYPE'],
    ['a size beyond the column and the policy', { fileSize: 3_000_000_000 }, 'VIDEO_TOO_LARGE'],
    ['a zero-byte file', { fileSize: 0 }, 'VIDEO_TOO_LARGE'],
    ['a recording longer than a walkthrough', { durationSeconds: 4000 }, 'VIDEO_DURATION_INVALID'],
  ];

  it.each(cases)('rejects %s', async (_label, patch, code) => {
    const { service } = build();
    await expect(
      service.createUploadSession(technician, { ...validInput, ...patch }),
    ).rejects.toMatchObject({ code });
  });
});

describe('upload session creation', () => {
  it('stores the Stream uid and returns only what the device needs', async () => {
    const { service, prisma } = build();
    const session = await service.createUploadSession(technician, validInput);

    expect(session).toMatchObject({
      videoId: 'media-1',
      streamUid: 'uid-1',
      uploadProtocol: 'tus',
    });
    // The response must never carry a Cloudflare credential.
    expect(JSON.stringify(session)).not.toMatch(/token|secret|Authorization/i);

    const created = prisma.inspectionMedia.create.mock.calls[0][0].data;
    expect(created.provider).toBe('cloudflare_stream');
    expect(created.streamUid).toBe('uid-1');
    // No bucket object exists for a Stream video.
    expect(created.storageKey).toBeNull();
    expect(created.uploadStatus).toBe('SESSION_CREATED');
    expect(created.processingStatus).toBe('PENDING');
  });

  it('advertises chunk sizes Cloudflare will actually accept', async () => {
    // Cloudflare requires every tus chunk but the last to be a multiple of
    // 256 KiB; a client following these cannot produce a rejected chunk.
    const { service } = build();
    const { chunkPolicy } = await service.createUploadSession(technician, validInput);
    expect(chunkPolicy.minimumBytes % 262_144).toBe(0);
    expect(chunkPolicy.preferredBytes % 262_144).toBe(0);
  });

  it('returns the existing video when the same key is sent twice', async () => {
    // A double tap, a lost response, or an app relaunch mid-queue must not
    // create a second Cloudflare video for one recording.
    const { service, stream } = build({
      existing: {
        id: 'media-1',
        streamUid: 'uid-1',
        uploadStatus: 'UPLOADING',
        inspectionAreaId: AREA_ID,
      },
    });
    const session = await service.createUploadSession(technician, validInput);
    expect(session.streamUid).toBe('uid-1');
    expect(stream.createDirectUpload).not.toHaveBeenCalled();
  });

  it('refuses a key already used by a different area', async () => {
    const { service } = build({
      existing: {
        id: 'media-1',
        streamUid: 'uid-1',
        uploadStatus: 'UPLOADING',
        inspectionAreaId: 'a-different-area',
      },
    });
    await expect(service.createUploadSession(technician, validInput)).rejects.toMatchObject({
      code: 'UPLOAD_KEY_REUSED',
    });
  });
});

describe('stream webhook', () => {
  function mediaRow(processingStatus = 'PROCESSING', readyAt: Date | null = null) {
    return {
      id: 'media-1',
      processingStatus,
      // Cloudflare's encode stamp. Null means it has never reported the video
      // finished, which is what decides whether the pipeline still owes work.
      readyAt,
      organizationId: 'org-1',
      inspectionId: 'insp-1',
    };
  }

  it('marks a video ready and records what Cloudflare measured', async () => {
    const { service, prisma } = build();
    prisma.inspectionMedia.findUnique.mockResolvedValue(mediaRow());

    const result = await service.applyWebhook({
      uid: 'uid-1',
      status: { state: 'ready' },
      duration: 91.6,
      input: { width: 1920, height: 1080 },
      thumbnail: 'https://cloudflarestream.com/uid-1/thumbnails/thumbnail.jpg',
    });

    // PROCESSING, not READY. READY is the *pipeline's* terminal state, and
    // MediaProcessingService.process returns immediately when it sees it — so
    // claiming it here meant every Stream recording was declared finished a
    // moment before transcription and analysis were asked to run, and neither
    // ever did.
    expect(result).toMatchObject({ accepted: true, processingStatus: 'PROCESSING' });
    const data = prisma.inspectionMedia.update.mock.calls[0][0].data;
    expect(data.processingStatus).toBe('PROCESSING');
    expect(data.durationSeconds).toBe(92);
    expect(data.widthPx).toBe(1920);
    expect(data.readyAt).toBeInstanceOf(Date);
    // Cloudflare holding the bytes is proof the transfer finished, whatever the
    // device managed to report before it lost signal.
    expect(data.uploadStatus).toBe('UPLOADED');
  });

  it('does not move readyAt when the same event arrives again', async () => {
    // Cloudflare re-delivers. "When did this become available" has to stay
    // answerable, so the stamp is written once.
    const { service, prisma } = build();
    prisma.inspectionMedia.findUnique.mockResolvedValue(mediaRow('PROCESSING', new Date('2026-01-01')));

    await service.applyWebhook({ uid: 'uid-1', status: { state: 'ready' } });
    expect(prisma.inspectionMedia.update.mock.calls[0][0].data.readyAt).toBeUndefined();
  });

  it('starts transcription and analysis the first time Cloudflare reports ready', async () => {
    // The whole reason a Stream recording produced no transcript, no summary
    // and no findings: nothing queued the pipeline. The device uploads straight
    // to Cloudflare, so this webhook is the only moment the backend learns the
    // video exists and is playable.
    const mediaProcessing = { queue: jest.fn() };
    const { service, prisma } = build({ mediaProcessing });
    prisma.inspectionMedia.findUnique.mockResolvedValue(mediaRow());

    await service.applyWebhook({ uid: 'uid-1', status: { state: 'ready' } });

    expect(mediaProcessing.queue).toHaveBeenCalledWith('media-1', 'org-1');
  });

  it('does not re-queue processing when Cloudflare re-delivers the same event', async () => {
    // Cloudflare retries. Transcription costs money per run, so the queue is
    // keyed on the transition rather than on the event arriving.
    const mediaProcessing = { queue: jest.fn() };
    const { service, prisma } = build({ mediaProcessing });
    prisma.inspectionMedia.findUnique.mockResolvedValue(mediaRow('PROCESSING', new Date('2026-01-01')));

    await service.applyWebhook({ uid: 'uid-1', status: { state: 'ready' } });

    expect(mediaProcessing.queue).not.toHaveBeenCalled();
  });

  it('completes the area once Cloudflare confirms the bytes', async () => {
    /**
     * The bug this whole change exists for. Nothing wrote the area's completion
     * state for a Stream upload — the old multipart endpoint did it inline, and
     * Stream never reaches that endpoint — so an area with a finished
     * walkthrough sat at PENDING, rendered as "not started", and could never
     * satisfy the Review screen's submit gate.
     */
    const { service, prisma } = build();
    prisma.inspectionMedia.findUnique.mockResolvedValue(mediaRow());

    await service.applyWebhook({ uid: 'uid-1', status: { state: 'ready' } });

    const [call] = prisma.inspectionArea.updateMany.mock.calls.filter(
      ([argument]: [{ data: { completionStatus?: string } }]) =>
        argument.data.completionStatus === 'COMPLETED',
    );
    expect(call).toBeDefined();
    expect(call[0].data.completedAt).toBeInstanceOf(Date);
    // Never over a skip: that is a deliberate statement about the room, and a
    // late webhook must not overwrite it.
    expect(call[0].where.completionStatus.in).not.toContain('SKIPPED');
  });

  it('leaves the area alone while the upload has not started', async () => {
    // pendingupload means Cloudflare has the session but no bytes. Completing
    // on that would mark an area done before anything was sent.
    const { service, prisma } = build();
    prisma.inspectionMedia.findUnique.mockResolvedValue(mediaRow('PENDING'));

    await service.applyWebhook({ uid: 'uid-1', status: { state: 'pendingupload' } });

    expect(prisma.inspectionArea.updateMany).not.toHaveBeenCalled();
  });

  it('records an encoding failure with the provider reason', async () => {
    const { service, prisma } = build();
    prisma.inspectionMedia.findUnique.mockResolvedValue(mediaRow());

    await service.applyWebhook({
      uid: 'uid-1',
      status: { state: 'error', errorReasonText: 'Unsupported codec' },
    });
    const data = prisma.inspectionMedia.update.mock.calls[0][0].data;
    expect(data.processingStatus).toBe('FAILED');
    expect(data.failureMessage).toBe('Unsupported codec');
    expect(data.failedAt).toBeInstanceOf(Date);
  });

  it('ignores an unknown video without failing the request', async () => {
    // Cloudflare retries non-2xx. Failing here would earn an indefinite retry
    // loop for a video that no longer exists on our side.
    const { service, prisma } = build();
    prisma.inspectionMedia.findUnique.mockResolvedValue(null);
    await expect(service.applyWebhook({ uid: 'gone' })).resolves.toMatchObject({
      accepted: false,
      reason: 'UNKNOWN_VIDEO',
    });
    expect(prisma.inspectionMedia.update).not.toHaveBeenCalled();
  });

  it('refuses to guess at a Cloudflare state it does not know', async () => {
    // A new provider state must never be read as "ready" — that would publish
    // evidence that may not exist yet.
    const { service, prisma } = build();
    prisma.inspectionMedia.findUnique.mockResolvedValue(mediaRow());
    await expect(
      service.applyWebhook({ uid: 'uid-1', status: { state: 'something-new' } }),
    ).resolves.toMatchObject({ accepted: false, reason: 'UNMAPPED_STATE' });
    expect(prisma.inspectionMedia.update).not.toHaveBeenCalled();
  });

  it('ignores a payload with no video id', async () => {
    const { service } = build();
    await expect(service.applyWebhook({})).resolves.toMatchObject({ reason: 'MISSING_UID' });
  });
});

describe('playback', () => {
  const admin: AuthenticatedUser = {
    ...technician,
    id: 'admin-1',
    roles: [UserRole.SYSTEM_ADMIN],
    permissions: ['inspections:read'],
  };

  function playbackHarness(media: unknown, signing = true) {
    const prisma = { inspectionMedia: { findFirst: jest.fn().mockResolvedValue(media) } };
    const stream = {
      customerCode: 'abc123',
      signingConfigured: signing,
      signPlaybackToken: jest.fn().mockReturnValue({
        token: 'signed.jwt.value',
        expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
      }),
    };
    return {
      prisma,
      stream,
      service: new InspectionVideoService(prisma as never, stream as never),
    };
  }

  const readyMedia = {
    id: 'media-1',
    provider: 'cloudflare_stream',
    streamUid: 'uid-1',
    storageKey: null,
    // Playability is decided by readyAt — Cloudflare's encode — not by
    // processingStatus, which tracks our own transcription and analysis and
    // finishes later. PROCESSING here on purpose: a reviewer must be able to
    // watch a recording while the AI is still working on it, and must still be
    // able to watch it if the AI fails.
    processingStatus: 'PROCESSING',
    readyAt: new Date('2026-08-10T00:00:00.000Z'),
    uploadStatus: 'UPLOADED',
    durationSeconds: 92,
    thumbnailUrl: null,
    failureMessage: null,
  };

  it('returns edge manifest URLs and never a proxied path', async () => {
    // Proxying segments through this backend is the round trip Stream replaces;
    // returning one here would reintroduce it while looking like an upgrade.
    const { service } = playbackHarness(readyMedia);
    const playback = await service.getPlayback(admin, 'media-1');

    expect(playback).toMatchObject({ status: 'ready', provider: 'cloudflare_stream' });
    expect(playback.hlsUrl).toBe(
      'https://customer-abc123.cloudflarestream.com/signed.jwt.value/manifest/video.m3u8',
    );
    expect(playback.dashUrl).toContain('/manifest/video.mpd');
    expect(playback.iframeUrl).toContain('/iframe');
    // The token stands in for the uid in the path — that is what makes the
    // manifest unreachable without one.
    expect(playback.hlsUrl).not.toContain('uid-1');
    expect(JSON.stringify(playback)).not.toContain('/api/v1/admin/media');
  });

  it('mints a fresh short-lived token per request and stores none', async () => {
    const { service, stream, prisma } = playbackHarness(readyMedia);
    await service.getPlayback(admin, 'media-1');
    await service.getPlayback(admin, 'media-1');

    expect(stream.signPlaybackToken).toHaveBeenCalledTimes(2);
    const [, ttl] = stream.signPlaybackToken.mock.calls[0];
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(4 * 60 * 60);
    // A persisted token would outlive its own expiry and become a standing
    // grant to evidence about someone's home.
    expect(prisma.inspectionMedia).not.toHaveProperty('update');
  });

  it('scopes an ordinary technician to their own assigned inspection', async () => {
    // Reached through `inspectionArea`. InspectionMedia has no `inspection`
    // relation — only a bare `inspectionId` column — so filtering on
    // `inspection` is an invalid query, not a narrower one, and Prisma rejects
    // the entire call.
    //
    // This test asserted that broken shape and passed, because the harness
    // mocks Prisma and nothing here validates a query against the real schema.
    // Every technician playback request returned 500 while this was green;
    // administrators were unaffected, since the branch does not apply to them.
    // The compile-time guard is the real fix — see the annotated
    // `Prisma.InspectionMediaWhereInput` in the service, which now rejects the
    // mistake at build time.
    const { service, prisma } = playbackHarness(readyMedia);
    await service.getPlayback(technician, 'media-1');
    expect(prisma.inspectionMedia.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: technician.organizationId,
          inspectionArea: {
            inspection: { assignments: { some: { technicianId: technician.id, isCurrent: true } } },
          },
        }),
      }),
    );
  });

  it('does not constrain an administrator to an assignment', async () => {
    // A reviewer was never the assigned technician; requiring an assignment
    // would lock the console out of every video it exists to review.
    const { service, prisma } = playbackHarness(readyMedia);
    await service.getPlayback(admin, 'media-1');
    expect(prisma.inspectionMedia.findFirst.mock.calls[0][0].where.inspectionArea).toBeUndefined();
  });

  it('reports a video that is not yet encoded as processing, not as an error', async () => {
    // A technician who just stopped recording should be told to wait. No
    // readyAt is what "Cloudflare has not finished encoding" looks like.
    const { service, stream } = playbackHarness({ ...readyMedia, readyAt: null });
    await expect(service.getPlayback(admin, 'media-1')).resolves.toMatchObject({
      status: 'processing',
    });
    expect(stream.signPlaybackToken).not.toHaveBeenCalled();
  });

  it('surfaces an encoding failure with its reason', async () => {
    const { service } = playbackHarness({
      ...readyMedia,
      processingStatus: 'FAILED',
      failureMessage: 'Unsupported codec',
    });
    await expect(service.getPlayback(admin, 'media-1')).resolves.toMatchObject({
      status: 'failed',
      failureMessage: 'Unsupported codec',
    });
  });

  it('keeps pre-migration recordings playable through their original path', async () => {
    // Compatibility is the whole reason streamUid is nullable: legacy evidence
    // must not become unviewable because the upload path changed.
    const { service } = playbackHarness({
      ...readyMedia,
      streamUid: null,
      provider: 'r2',
      storageKey: 'inspection-media/org-1/media-1.mp4',
    });
    await expect(service.getPlayback(admin, 'media-1')).resolves.toMatchObject({
      provider: 'legacy',
      status: 'ready',
      contentPath: '/api/v1/admin/media/media-1/content',
    });
  });

  it('answers not-found for a video outside the caller reach', async () => {
    const { service } = playbackHarness(null);
    await expect(service.getPlayback(technician, 'media-1')).rejects.toMatchObject({
      code: 'INSPECTION_MEDIA_NOT_FOUND',
    });
  });
});

describe('webhook signature guard', () => {
  const SECRET = 'whsec-test';
  const guard = new CloudflareStreamWebhookGuard();
  const body = Buffer.from(JSON.stringify({ uid: 'uid-1' }));

  function contextFor(header: string | undefined, rawBody = body) {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ header: () => header, rawBody, body: {} }),
      }),
    } as never;
  }

  function sign(time: number, payload = body) {
    return createHmac('sha256', SECRET).update(`${time}.`).update(payload).digest('hex');
  }

  beforeEach(() => {
    process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET;
  });

  it('accepts a correctly signed notification', () => {
    const time = Math.floor(Date.now() / 1000);
    expect(guard.canActivate(contextFor(`time=${time},sig1=${sign(time)}`))).toBe(true);
  });

  it('rejects a signature computed over the body alone', () => {
    // The trap this guard exists for: the pre-existing WebhookSignatureGuard
    // signs only the body, so reusing it would have rejected every genuine
    // Cloudflare call while appearing to verify something.
    const time = Math.floor(Date.now() / 1000);
    const bodyOnly = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(() => guard.canActivate(contextFor(`time=${time},sig1=${bodyOnly}`))).toThrow(
      /invalid/i,
    );
  });

  it('rejects a replayed notification', () => {
    const stale = Math.floor(Date.now() / 1000) - 3600;
    expect(() => guard.canActivate(contextFor(`time=${stale},sig1=${sign(stale)}`))).toThrow(
      /expired/i,
    );
  });

  it('rejects a tampered body', () => {
    const time = Math.floor(Date.now() / 1000);
    const header = `time=${time},sig1=${sign(time)}`;
    const tampered = Buffer.from(JSON.stringify({ uid: 'someone-elses-video' }));
    expect(() => guard.canActivate(contextFor(header, tampered))).toThrow(/invalid/i);
  });

  it('rejects a missing or malformed header', () => {
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(/missing/i);
    expect(() => guard.canActivate(contextFor('nonsense'))).toThrow(/invalid/i);
  });

  it('refuses to run unverified when no secret is configured', () => {
    // No dev-mode pass-through. An unverified endpoint that marks evidence
    // ready is worse than one that is switched off.
    delete process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET;
    const time = Math.floor(Date.now() / 1000);
    expect(() => guard.canActivate(contextFor(`time=${time},sig1=x`))).toThrow(/not configured/i);
  });
});
