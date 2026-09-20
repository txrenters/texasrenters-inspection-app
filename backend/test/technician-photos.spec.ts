import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Prisma } from '@prisma/client';
import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { TechnicianService } from '../src/technician/technician.service';

const technician: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000004',
  authUserId: 'auth-tech',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Taylor Technician',
  roles: [UserRole.INSPECTION_TECHNICIAN],
  permissions: [],
  mustChangePassword: false,
  // Added with `principalType`; these fixtures are people, not integrations.
  principalType: 'USER',
};

const area = {
  id: 'area-1',
  inspectionId: 'insp-1',
  propertyAreaId: 'pa-1',
  inspection: { inspectionType: 'MOVE_IN', createdAt: new Date('2026-07-01T00:00:00.000Z') },
};

function photoRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'photo-1',
    inspectionAreaId: 'area-1',
    findingId: null,
    captureType: 'AREA_OVERVIEW',
    sequenceNumber: 0,
    label: null,
    notes: null,
    mimeType: 'image/jpeg',
    width: null,
    height: null,
    capturedAt: new Date('2026-07-25T00:00:00.000Z'),
    capturedBy: { displayName: 'Taylor Technician' },
    ...overrides,
  };
}

function build(overrides: Record<string, unknown> = {}) {
  const mediaStorage = {
    putFromFile: jest.fn().mockResolvedValue(undefined),
    get: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const prisma = {
    inspectionArea: { findFirst: jest.fn().mockResolvedValue(area) },
    inspectionFinding: { findFirst: jest.fn().mockResolvedValue({ id: 'f-1' }) },
    inspectionPhoto: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(
            photoRecord({ captureType: data.captureType, findingId: data.findingId ?? null }),
          ),
        ),
      findUniqueOrThrow: jest.fn().mockResolvedValue(photoRecord()),
    },
    ...overrides,
  };
  const service = new TechnicianService(
    prisma as never,
    {} as never,
    mediaStorage as never,
    {} as never,
  );
  return { service, prisma, mediaStorage };
}

/**
 * A real file each time: the upload fingerprints the bytes it received before
 * storing them, and removes its temporary file when it is done.
 */
const jpeg = () => {
  const path = join(mkdtempSync(join(tmpdir(), 'technician-photo-')), 'p.jpg');
  writeFileSync(path, Buffer.from('not really a jpeg; just bytes to hash'));
  return { path, mimetype: 'image/jpeg', size: 12345, originalname: 'p.jpg' };
};

describe('technician photo evidence', () => {
  it('stores a photo with its capture type and never touches the video pipeline', async () => {
    const { service, prisma, mediaStorage } = build();
    const result = await service.uploadPhoto(
      technician,
      'area-1',
      {
        idempotencyKey: 'photo-key-abc123',
        captureType: 'FINDING_DETAIL' as never,
      },
      jpeg(),
    );

    expect(mediaStorage.putFromFile).toHaveBeenCalledTimes(1);
    expect(prisma.inspectionPhoto.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          inspectionAreaId: 'area-1',
          captureType: 'FINDING_DETAIL',
          capturedById: technician.id,
          idempotencyKey: 'photo-key-abc123',
          provider: 'local',
        }),
      }),
    );
    expect(result).toMatchObject({
      roomId: 'area-1',
      captureType: 'FINDING_DETAIL',
      contentPath: '/api/v1/technician/photos/photo-1/content',
    });
  });

  it('stores validated capture-session provenance without raw sensor data', async () => {
    const { service, prisma } = build();
    await service.uploadPhoto(
      technician,
      'area-1',
      {
        idempotencyKey: 'photo-key-guided-1',
        captureType: 'FINDING_CONTEXT' as never,
        recordingSessionId: 'capture-session-1',
        videoTimestampMs: 12_000,
        captureSource: 'VIDEO_FRAME_EXTRACTION',
        sequenceNumber: 2,
      },
      jpeg(),
    );

    expect(prisma.inspectionPhoto.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: {
            recordingSessionId: 'capture-session-1',
            videoTimestampMs: 12_000,
            captureSource: 'VIDEO_FRAME_EXTRACTION',
          },
        }),
      }),
    );
  });

  it('is idempotent: a re-sent key returns the stored photo without a new upload', async () => {
    const { service, prisma, mediaStorage } = build({
      inspectionPhoto: {
        findUnique: jest.fn().mockResolvedValue({ id: 'photo-1', inspectionAreaId: 'area-1' }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(photoRecord()),
        create: jest.fn(),
      },
    });
    const result = await service.uploadPhoto(
      technician,
      'area-1',
      {
        idempotencyKey: 'photo-key-abc123',
        captureType: 'AREA_OVERVIEW' as never,
      },
      jpeg(),
    );
    expect(result).toMatchObject({ id: 'photo-1' });
    expect(prisma.inspectionPhoto.create).not.toHaveBeenCalled();
    expect(mediaStorage.putFromFile).not.toHaveBeenCalled();
  });

  /**
   * 2026-09-16: a first upload took 69 seconds on a weak signal, the phone sent
   * it again, and both passed the key check. The retry lost the insert and got
   * a 500 although the photo was saved.
   */
  it('returns the saved photo when a retry races the upload it repeats, and drops its own copy', async () => {
    const lostTheRace = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`idempotencyKey`)', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['idempotencyKey'] },
    });
    const { service, prisma, mediaStorage } = build({
      inspectionPhoto: {
        // Nothing stored yet when this attempt checked; the first one finished before it wrote.
        findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'photo-1', inspectionAreaId: 'area-1' }),
        create: jest.fn().mockRejectedValue(lostTheRace),
        findUniqueOrThrow: jest.fn().mockResolvedValue(photoRecord()),
      },
    });

    const result = await service.uploadPhoto(
      technician,
      'area-1',
      { idempotencyKey: 'photo-key-abc123', captureType: 'AREA_OVERVIEW' as never },
      jpeg(),
    );

    expect(result).toMatchObject({ id: 'photo-1' });
    expect(prisma.inspectionPhoto.findUniqueOrThrow).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'photo-1' } }));
    expect(mediaStorage.delete).toHaveBeenCalledWith(mediaStorage.putFromFile.mock.calls[0][0]);
  });

  it('still fails an upload on any other unique constraint', async () => {
    const otherConstraint = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`id`)', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['id'] },
    });
    const { service, mediaStorage } = build({
      inspectionPhoto: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue(otherConstraint),
        findUniqueOrThrow: jest.fn(),
      },
    });

    await expect(
      service.uploadPhoto(technician, 'area-1', { idempotencyKey: 'photo-key-abc123', captureType: 'AREA_OVERVIEW' as never }, jpeg()),
    ).rejects.toBe(otherConstraint);
    expect(mediaStorage.delete).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-image upload', async () => {
    const { service } = build();
    await expect(
      service.uploadPhoto(
        technician,
        'area-1',
        {
          idempotencyKey: 'photo-key-abc123',
          captureType: 'AREA_OVERVIEW' as never,
        },
        { ...jpeg(), mimetype: 'application/pdf' },
      ),
    ).rejects.toMatchObject({ status: 415, code: 'PHOTO_TYPE_UNSUPPORTED' });
  });

  describe('a job photograph that arrives after the checklist was answered', () => {
    const reportedAt = new Date('2026-09-18T15:00:00.000Z');
    const filtersArea = { ...area, propertyArea: { name: 'AC filters' } };
    const waitingReport = {
      services: { filterChange: { done: true, reason: null, reschedule: false } },
      filters: [
        {
          size: '20x25x1',
          location: 'hallway',
          slot: 1,
          changed: true,
          reason: null,
          photoKey: 'photo-key-filter-1',
          photoId: null,
          booked: true,
        },
      ],
    };

    function buildJob(options: { area?: unknown; counts?: number[] } = {}) {
      const counts = [...(options.counts ?? [1])];
      const inspection = {
        findUnique: jest.fn().mockResolvedValue({ servicesReport: waitingReport, servicesReportedAt: reportedAt }),
        updateMany: jest.fn().mockImplementation(() => Promise.resolve({ count: counts.shift() ?? 1 })),
      };
      return { inspection, ...build({
        inspectionArea: { findFirst: jest.fn().mockResolvedValue(options.area ?? filtersArea) },
        inspection,
        inspectionPhoto: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue(photoRecord({ id: 'photo-9', inspectionAreaId: 'area-1' })),
          findUniqueOrThrow: jest.fn(),
          // What `resolveFilterPhotos` reads: the photograph is now stored under its key.
          findMany: jest.fn().mockResolvedValue([{ id: 'photo-9', idempotencyKey: 'photo-key-filter-1' }]),
        },
      }) };
    }

    const upload = (service: TechnicianService, key = 'photo-key-filter-1') =>
      service.uploadPhoto(technician, 'area-1', { idempotencyKey: key, captureType: 'SERIAL_OR_LABEL' as never }, jpeg());

    it('fills in the register that was waiting on its key, without moving the time it was reported', async () => {
      const { service, inspection } = buildJob();
      await upload(service);

      expect(inspection.updateMany).toHaveBeenCalledTimes(1);
      const [{ where, data }] = inspection.updateMany.mock.calls[0];
      // Only if nothing was saved since it was read.
      expect(where).toEqual({ id: 'insp-1', servicesReportedAt: reportedAt });
      expect(data).toEqual({
        servicesReport: expect.objectContaining({ filters: [expect.objectContaining({ photoId: 'photo-9' })] }),
      });
    });

    it('leaves a report alone when nothing in it is waiting on that photograph', async () => {
      const { service, inspection } = buildJob();
      await upload(service, 'photo-key-something-else');
      expect(inspection.updateMany).not.toHaveBeenCalled();
    });

    it('never overwrites a save that landed in between: it reads again and resolves that', async () => {
      const { service, inspection } = buildJob({ counts: [0, 1] });
      await upload(service);
      expect(inspection.findUnique).toHaveBeenCalledTimes(2);
      expect(inspection.updateMany).toHaveBeenCalledTimes(2);
    });

    it('still returns the stored photograph when the checklist cannot be updated', async () => {
      const { service, inspection } = buildJob();
      inspection.updateMany.mockRejectedValue(new Error('connection reset'));
      await expect(upload(service)).resolves.toMatchObject({ id: 'photo-9' });
    });

    it('does not read the job at all for a photograph of an ordinary room', async () => {
      const { service, inspection } = buildJob({ area: { ...area, propertyArea: { name: 'Kitchen' } } });
      await upload(service);
      expect(inspection.findUnique).not.toHaveBeenCalled();
    });
  });

  it('rejects a finding link that does not belong to the area', async () => {
    const { service } = build({
      inspectionArea: { findFirst: jest.fn().mockResolvedValue(area) },
      inspectionFinding: { findFirst: jest.fn().mockResolvedValue(null) },
      inspectionPhoto: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
    });
    await expect(
      service.uploadPhoto(
        technician,
        'area-1',
        {
          idempotencyKey: 'photo-key-abc123',
          captureType: 'FINDING_DETAIL' as never,
          findingId: '10000000-0000-4000-8000-0000000000ff',
        },
        jpeg(),
      ),
    ).rejects.toMatchObject({ status: 422, code: 'FINDING_NOT_IN_AREA' });
  });
});
