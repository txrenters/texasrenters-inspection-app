import type { GuidedCaptureSummary } from '../src/capture/guided-capture';
import type { LocalMedia, UploadItem } from '../src/domain/models';
import { buildRecordingDraft } from '../src/media/local-recordings';
import { MAX_FRAME_MARKERS, streamCaptureOf } from '../src/media/stream-capture';
import { ApiUploadRepository } from '../src/repositories/api/repositories';
import { useDemoStore } from '../src/stores/demo.store';

/**
 * The marked moments of a take, filed by the server (2026-10-06).
 *
 * An Android phone cannot photograph while it films, so the shutter marks the
 * moment. The phone used to decode the finished video once per marker before
 * the review screen opened; it now sends the moments with the upload, and the
 * server files each frame from Cloudflare.
 */

// Prefixed `mock` so jest permits the hoisted factory below to reference it.
const mockUpload = jest.fn();
jest.mock('../src/media/tus-upload', () => {
  const actual = jest.requireActual('../src/media/tus-upload');
  return { ...actual, uploadFileInChunks: (...args: unknown[]) => mockUpload(...args) };
});
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: async () => ({ exists: true, size: 4_000_000 }),
}));
jest.mock('../src/auth/session', () => ({
  getSession: async () => ({ accessToken: 'token' }),
  SessionExpiredError: class SessionExpiredError extends Error {},
}));
jest.mock('../src/config/environment', () => ({
  environment: { apiBaseUrl: 'https://api.test', apiBaseUrls: ['https://api.test'] },
}));

const summary: GuidedCaptureSummary = {
  sessionId: 'capture-1759770000000-abc1234',
  policyVersion: 'guided-area-v1',
  startedAt: '2026-10-06T15:00:00.000Z',
  completedAt: '2026-10-06T15:01:00.000Z',
  durationSeconds: 60,
  clockwiseRotationDegrees: 362,
  counterClockwiseRotationDegrees: 4,
  startHeadingDegrees: 12,
  endHeadingDegrees: 15,
  returnedToStart: true,
  sensorSupported: true,
  sensorConfidence: 'HIGH',
  coverageStatus: 'COMPLETE',
  manualConfirmation: false,
  evidenceComplete: true,
  snapshotCount: 2,
  findingMarkerCount: 0,
};

describe('a take with marked moments', () => {
  it('keeps each moment once, in order, with the kind the technician was taking', () => {
    const draft = buildRecordingDraft({
      inspectionId: 'insp-1',
      roomId: 'area-1',
      uri: 'file:///take.mp4',
      durationSeconds: 60,
      frameMarkers: [
        { atMs: 20_000, captureType: 'FINDING_CONTEXT' },
        { atMs: 5_000, captureType: 'AREA_OVERVIEW' },
        { atMs: 20_000, captureType: 'FINDING_CLOSE_UP' },
      ],
    });
    expect(draft.frameMarkers).toEqual([
      { atMs: 5_000, captureType: 'AREA_OVERVIEW' },
      { atMs: 20_000, captureType: 'FINDING_CONTEXT' },
    ]);
    expect(draft.frameMarkersMs).toEqual([5_000, 20_000]);
  });

  it('carries none when nothing was marked', () => {
    const draft = buildRecordingDraft({
      inspectionId: 'insp-1',
      roomId: 'area-1',
      uri: 'file:///take.mp4',
      durationSeconds: 60,
    });
    expect(draft.frameMarkers).toBeUndefined();
    expect(draft.frameMarkersMs).toBeUndefined();
  });
});

describe('what the upload session is told', () => {
  const markers = [{ atMs: 5_000, captureType: 'FINDING_DETAIL' as const }];

  it('carries the walkthrough summary and the marked moments', () => {
    expect(streamCaptureOf({ captureSummary: summary, frameMarkers: markers }, 'PRIMARY_AREA')).toEqual({
      captureSessionId: summary.sessionId,
      capturePolicyVersion: 'guided-area-v1',
      coverageStatus: 'COMPLETE',
      sensorConfidence: 'HIGH',
      clockwiseRotationDegrees: 362,
      counterClockwiseRotationDegrees: 4,
      startHeadingDegrees: 12,
      endHeadingDegrees: 15,
      returnedToStart: true,
      sensorSupported: true,
      manualConfirmation: false,
      evidenceComplete: true,
      snapshotCount: 2,
      findingMarkerCount: 0,
      frameMarkers: markers,
    });
  });

  it('sends only the moments for an additional clip, which has no walkthrough to summarize', () => {
    expect(streamCaptureOf({ captureSummary: summary, frameMarkers: markers }, 'ADDITIONAL_ISSUE')).toEqual({
      frameMarkers: markers,
    });
  });

  it('sends no moments for a take from an earlier release, which cut its own frames', () => {
    const earlier = { frameMarkersMs: [5_000] } as Pick<LocalMedia, 'captureSummary' | 'frameMarkers'>;
    expect(streamCaptureOf(earlier, 'PRIMARY_AREA')).toBeUndefined();
  });

  it('never sends what the server would refuse the whole request over', () => {
    const many = Array.from({ length: MAX_FRAME_MARKERS + 5 }, (_, index) => ({
      atMs: index * 1_000,
      captureType: 'FINDING_DETAIL' as const,
    }));
    const capture = streamCaptureOf(
      { captureSummary: { ...summary, startHeadingDegrees: Number.NaN }, frameMarkers: many },
      'PRIMARY_AREA',
    );
    expect(capture?.frameMarkers).toHaveLength(MAX_FRAME_MARKERS);
    expect(capture?.startHeadingDegrees).toBeUndefined();
  });
});

describe('asking for the upload session', () => {
  const TECHNICIAN = 'tech-1';
  const media: LocalMedia = {
    id: 'local-media-1',
    ownerUserId: TECHNICIAN,
    inspectionId: 'insp-1',
    roomId: 'area-1',
    recordingType: 'PRIMARY_AREA',
    uri: 'file:///take.mp4',
    durationSeconds: 60,
    estimatedSizeMb: 4,
    recordedAt: '2026-10-06T15:01:00.000Z',
    note: '',
    captureSummary: summary,
    frameMarkers: [{ atMs: 5_000, captureType: 'FINDING_DETAIL' }],
  };
  const queued = {
    id: 'local-upload-local-media-1',
    ownerUserId: TECHNICIAN,
    mediaId: media.id,
    inspectionId: 'insp-1',
    roomId: 'area-1',
    recordingType: 'PRIMARY_AREA',
    propertyAddress: '1 Test St',
    roomName: 'Kitchen',
    durationSeconds: 60,
    estimatedSizeMb: 4,
    status: 'PENDING',
    progress: 0,
    processingStatus: 'NOT_STARTED',
    processingProgress: 0,
    attemptCount: 0,
    createdAt: new Date().toISOString(),
  } as UploadItem;

  /** The backend: refuses the first `refusals` session requests with a 400. */
  function backend(refusals: number) {
    const asked: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      asked.push(JSON.parse(init.body) as Record<string, unknown>);
      const refused = asked.length <= refusals;
      const body = refused
        ? { message: 'property capture should not exist' }
        : {
            videoId: 'video-1',
            streamUid: 'uid-1',
            uploadUrl: 'https://upload.cloudflarestream.com/tus/abc',
            uploadProtocol: 'tus',
            expiresAt: new Date(Date.now() + 3_000_000).toISOString(),
            chunkPolicy: { minimumBytes: 5_242_880, preferredBytes: 52_428_800 },
          };
      return {
        ok: !refused,
        status: refused ? 400 : 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }) as never;
    return asked;
  }

  beforeEach(() => {
    mockUpload.mockReset().mockResolvedValue(undefined);
    useDemoStore.setState({ selectedUserId: TECHNICIAN, uploads: [queued], media: [media] });
  });

  it('tells the server when the take ended and how it was filmed', async () => {
    const asked = backend(0);

    await new ApiUploadRepository().tick();

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      idempotencyKey: media.id,
      recordedAt: media.recordedAt,
      capture: { coverageStatus: 'COMPLETE', frameMarkers: media.frameMarkers },
    });
  });

  it('asks once more without it when the server will not take it, so the video still goes up', async () => {
    const asked = backend(1);

    await new ApiUploadRepository().tick();

    expect(asked).toHaveLength(2);
    expect(asked[0]).toHaveProperty('capture');
    expect(asked[1]).not.toHaveProperty('capture');
    expect(asked[1]).toMatchObject({ idempotencyKey: media.id, recordedAt: media.recordedAt });
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });
});
