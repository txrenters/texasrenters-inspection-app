import type { UploadItem } from '../src/domain/models';
import {
  describeRecordingLocation,
  describeUpload,
  formatBytes,
  formatTransferred,
  preferFresher,
} from '../src/utils/upload-status';

const item = (patch: Partial<UploadItem> = {}): UploadItem =>
  ({
    id: 'u-1',
    mediaId: 'm-1',
    inspectionId: 'insp-1',
    roomId: 'area-1',
    propertyAddress: '1 Test St',
    roomName: 'Kitchen',
    durationSeconds: 90,
    estimatedSizeMb: 12,
    status: 'PENDING',
    progress: 0,
    processingStatus: 'NOT_STARTED',
    processingProgress: 0,
    createdAt: '2026-08-06T00:00:00.000Z',
    ...patch,
  }) as UploadItem;

describe('never claiming complete too early', () => {
  it('says processing while Cloudflare is still encoding', () => {
    // The bug this exists to prevent: a technician reads "Uploaded", leaves the
    // property, and the video never becomes playable.
    const descriptor = describeUpload(
      item({ status: 'COMPLETED', progress: 100, processingStatus: 'VIDEO_PROCESSING' }),
      { online: true },
    );
    expect(descriptor.label).toBe('Upload complete — processing video');
    expect(descriptor.label).not.toMatch(/^Ready$/);
    expect(descriptor.tone).toBe('active');
  });

  it('says ready only once processing has moved on', () => {
    const descriptor = describeUpload(
      item({ status: 'COMPLETED', progress: 100, processingStatus: 'READY_FOR_REVIEW' }),
      { online: true },
    );
    expect(descriptor.label).toBe('Ready');
    expect(descriptor.tone).toBe('done');
  });
});

describe('states a technician acts on', () => {
  it('distinguishes offline from queued', () => {
    // Both are PENDING, but only one is worth waiting for a signal to fix.
    expect(describeUpload(item(), { online: false }).label).toBe('Waiting for connection');
    expect(describeUpload(item(), { online: true }).label).toBe('Queued');
  });

  it('shows a scheduled retry rather than looking stalled', () => {
    const now = 1_000_000;
    const descriptor = describeUpload(
      item({ attemptCount: 2, nextAttemptAt: new Date(now + 20_000).toISOString() }),
      { online: true, now },
    );
    expect(descriptor.label).toBe('Retry scheduled');
    // The attempt number matters: three silent failures look like one.
    expect(descriptor.detail).toContain('3');
  });

  it('returns to queued once the backoff has elapsed', () => {
    const now = 1_000_000;
    const descriptor = describeUpload(
      item({ nextAttemptAt: new Date(now - 1).toISOString() }),
      { online: true, now },
    );
    expect(descriptor.label).toBe('Queued');
  });

  it('carries the percentage in the label while uploading', () => {
    expect(describeUpload(item({ status: 'UPLOADING', progress: 46 }), { online: true }).label).toBe(
      'Uploading — 46%',
    );
  });

  it('never reports a bare failure', () => {
    // The reason decides whether to retry here or re-record.
    const withReason = describeUpload(
      item({ status: 'FAILED', lastError: 'The recording file is no longer on this device.' }),
      { online: true },
    );
    expect(withReason.detail).toContain('no longer on this device');
    const withoutReason = describeUpload(item({ status: 'FAILED' }), { online: true });
    expect(withoutReason.detail).toBeTruthy();
  });
});

describe('local file retention', () => {
  it('reports the recording as still held until it is off the device', () => {
    for (const status of ['PENDING', 'UPLOADING', 'PAUSED', 'FAILED'] as const)
      expect(describeUpload(item({ status }), { online: true }).localFileRetained).toBe(true);
  });

  it('releases it only once the transfer is confirmed', () => {
    expect(
      describeUpload(item({ status: 'COMPLETED', processingStatus: 'VIDEO_PROCESSING' }), {
        online: true,
      }).localFileRetained,
    ).toBe(false);
  });
});

describe('byte reporting', () => {
  it('formats sizes the way a person reads them', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(200_000)).toBe('195 KB');
    expect(formatBytes(12_000_000)).toBe('11.4 MB');
    expect(formatBytes(210_000_000)).toBe('200 MB');
    expect(formatBytes(undefined)).toBeNull();
  });

  it('shows progress against the real total', () => {
    expect(formatTransferred({ uploadedBytes: 6_000_000, fileSize: 12_000_000 })).toBe(
      '5.7 MB of 11.4 MB',
    );
  });

  it('says nothing rather than guessing when the size is unknown', () => {
    expect(formatTransferred({ uploadedBytes: 5, fileSize: undefined })).toBeNull();
  });
});

describe('stale refetches', () => {
  it('keeps live local progress over a server copy that lags behind', () => {
    // The server only learns the final state, so a refetch mid-upload would
    // otherwise snap the bar backwards and read as data loss.
    const local = item({ status: 'UPLOADING', progress: 62, uploadedBytes: 7_000_000 });
    const stale = item({ status: 'PENDING', progress: 0, uploadedBytes: 0 });
    expect(preferFresher(local, stale)).toBe(local);
  });

  it('accepts the server once it reports the upload finished', () => {
    // Completion is the one thing the device cannot know on its own.
    const local = item({ status: 'UPLOADING', progress: 99 });
    const complete = item({ status: 'COMPLETED', progress: 100 });
    expect(preferFresher(local, complete)).toBe(complete);
  });

  it('takes the incoming record when there is nothing local', () => {
    const incoming = item({ status: 'PENDING' });
    expect(preferFresher(undefined, incoming)).toBe(incoming);
  });
});

describe('where a recording actually is', () => {
  it('says stored on device only while it is', () => {
    // The label used to be hardcoded, so it kept claiming the file was on the
    // phone long after it had uploaded and the local copy was deleted — telling
    // a technician the opposite of the truth about their own evidence.
    expect(describeRecordingLocation('local-media-abc')).toBe('stored on device');
  });

  it('says uploaded once the server has it', () => {
    // A server id means the record came back from the API, which it only can
    // once the recording reached it.
    expect(describeRecordingLocation('9f3c1e88-4b21-4d0a-9a77-2b6d0c5e1f44')).toBe('uploaded');
  });
});
