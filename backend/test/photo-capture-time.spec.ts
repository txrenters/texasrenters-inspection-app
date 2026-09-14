import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { captureTimeForFrame, captureTimeForUpload } from '../src/common/photo-capture-time';
import { TechnicianService } from '../src/technician/technician.service';

/**
 * When a photograph was taken, for a court.
 *
 * The app never sent it: every photograph's `capturedAt` was the moment the
 * upload reached the server -- twenty seconds after the shutter typically,
 * hours after it for a phone that was offline. The phone's clock is now stored
 * as claimed, believed only when it could be true, and the file is fingerprinted
 * as it arrived.
 */

const received = new Date('2026-09-14T18:30:00.000Z');
const inspectionCreated = new Date('2026-09-01T00:00:00.000Z');

describe('a capture time a phone claims', () => {
  it('is believed when it is before the upload arrived', () => {
    expect(
      captureTimeForUpload({ claimed: '2026-09-14T18:29:39.000Z', receivedAt: received, earliest: inspectionCreated }),
    ).toEqual({
      deviceCapturedAt: new Date('2026-09-14T18:29:39.000Z'),
      capturedAt: new Date('2026-09-14T18:29:39.000Z'),
      captureTimeSource: 'DEVICE_CLOCK',
    });
  });

  it('allows a phone clock a little ahead, as location fixes do', () => {
    expect(
      captureTimeForUpload({ claimed: '2026-09-14T18:31:30.000Z', receivedAt: received, earliest: inspectionCreated })
        .captureTimeSource,
    ).toBe('DEVICE_CLOCK');
  });

  it('is kept but not believed when it is after the upload arrived', () => {
    // A photograph cannot be taken after it was received: the clock is wrong.
    expect(
      captureTimeForUpload({ claimed: '2026-09-14T19:30:00.000Z', receivedAt: received, earliest: inspectionCreated }),
    ).toEqual({
      deviceCapturedAt: new Date('2026-09-14T19:30:00.000Z'),
      capturedAt: received,
      captureTimeSource: 'SERVER_RECEIPT',
    });
  });

  it('is not believed from before the inspection existed', () => {
    // A phone whose clock reset to 2000 would otherwise date evidence decades early.
    expect(
      captureTimeForUpload({ claimed: '2000-01-01T00:00:00.000Z', receivedAt: received, earliest: inspectionCreated })
        .captureTimeSource,
    ).toBe('SERVER_RECEIPT');
  });

  it('is the receipt, labelled as such, when the app sent nothing', () => {
    expect(captureTimeForUpload({ receivedAt: received, earliest: inspectionCreated })).toEqual({
      deviceCapturedAt: null,
      capturedAt: received,
      captureTimeSource: 'SERVER_RECEIPT',
    });
  });

  it('comes from the recording for a still cut out of one', () => {
    expect(
      captureTimeForUpload({
        claimed: '2026-09-14T18:20:00.000Z',
        receivedAt: received,
        earliest: inspectionCreated,
        fromRecording: true,
      }).captureTimeSource,
    ).toBe('VIDEO_OFFSET');
  });
});

describe('the moment a frame of a recording shows', () => {
  it('is the take’s start plus the marker, the take being saved when it stopped', () => {
    const recording = { recordedAt: new Date('2026-09-14T18:10:00.000Z'), durationSeconds: 120 };
    expect(captureTimeForFrame(recording, 30_000)).toEqual({
      capturedAt: new Date('2026-09-14T18:08:30.000Z'),
      captureTimeSource: 'VIDEO_OFFSET',
    });
  });

  it('is only a receipt when the recording carries no time', () => {
    expect(captureTimeForFrame({ recordedAt: null, durationSeconds: 120 }, 30_000, received)).toEqual({
      capturedAt: received,
      captureTimeSource: 'SERVER_RECEIPT',
    });
  });
});

describe('uploading a photograph', () => {
  const technician: AuthenticatedUser = {
    id: '10000000-0000-4000-8000-000000000004',
    authUserId: 'auth-tech',
    organizationId: '10000000-0000-4000-8000-000000000001',
    displayName: 'Taylor Technician',
    roles: [UserRole.INSPECTION_TECHNICIAN],
    permissions: [],
    mustChangePassword: false,
    principalType: 'USER',
  };

  function build() {
    const create = jest.fn(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: 'photo-1',
        inspectionAreaId: 'area-1',
        findingId: null,
        captureType: data.captureType,
        sequenceNumber: 0,
        label: null,
        notes: null,
        mimeType: 'image/jpeg',
        width: null,
        height: null,
        capturedAt: data.capturedAt,
        captureTimeSource: data.captureTimeSource,
        capturedBy: { displayName: 'Taylor Technician' },
      }),
    );
    const prisma = {
      inspectionArea: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'area-1',
          inspectionId: 'insp-1',
          propertyAreaId: 'pa-1',
          inspection: { inspectionType: 'OCCUPIED', createdAt: new Date('2026-09-01T00:00:00.000Z') },
        }),
      },
      inspectionPhoto: { findUnique: jest.fn().mockResolvedValue(null), create },
    };
    const storage = { putFromFile: jest.fn().mockResolvedValue(undefined), delete: jest.fn() };
    const service = new TechnicianService(prisma as never, {} as never, storage as never, {} as never);
    return { service, create };
  }

  it('stores what the phone said, and the fingerprint of the file it sent', async () => {
    const bytes = Buffer.from('the bytes of a photograph, exactly as uploaded');
    const path = join(mkdtempSync(join(tmpdir(), 'capture-time-')), 'photo.jpg');
    writeFileSync(path, bytes);
    const { service, create } = build();

    const result = await service.uploadPhoto(
      technician,
      'area-1',
      {
        idempotencyKey: 'snapshot-1757874579000-abc',
        captureType: 'AREA_OVERVIEW' as never,
        capturedAt: new Date(Date.now() - 20_000).toISOString(),
        captureTimeZone: 'America/Chicago',
        captureUtcOffsetMinutes: -300,
      },
      { path, mimetype: 'image/jpeg', size: bytes.length, originalname: 'photo.jpg' },
    );

    const data = create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      captureTimeSource: 'DEVICE_CLOCK',
      captureTimeZone: 'America/Chicago',
      captureUtcOffsetMinutes: -300,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(data.capturedAt).toEqual(data.deviceCapturedAt);
    expect(result).toMatchObject({ captureTimeSource: 'DEVICE_CLOCK' });
  });
});
