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
};

const area = { id: 'area-1', inspectionId: 'insp-1', propertyAreaId: 'pa-1' };

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
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(photoRecord({ captureType: data.captureType, findingId: data.findingId ?? null })),
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

const jpeg = { path: '/tmp/nope.jpg', mimetype: 'image/jpeg', size: 12345, originalname: 'p.jpg' };

describe('technician photo evidence', () => {
  it('stores a photo with its capture type and never touches the video pipeline', async () => {
    const { service, prisma, mediaStorage } = build();
    const result = await service.uploadPhoto(technician, 'area-1', {
      idempotencyKey: 'photo-key-abc123',
      captureType: 'FINDING_DETAIL' as never,
    }, jpeg);

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

  it('is idempotent: a re-sent key returns the stored photo without a new upload', async () => {
    const { service, prisma, mediaStorage } = build({
      inspectionPhoto: {
        findUnique: jest.fn().mockResolvedValue({ id: 'photo-1', inspectionAreaId: 'area-1' }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(photoRecord()),
        create: jest.fn(),
      },
    });
    const result = await service.uploadPhoto(technician, 'area-1', {
      idempotencyKey: 'photo-key-abc123',
      captureType: 'AREA_OVERVIEW' as never,
    }, jpeg);
    expect(result).toMatchObject({ id: 'photo-1' });
    expect(prisma.inspectionPhoto.create).not.toHaveBeenCalled();
    expect(mediaStorage.putFromFile).not.toHaveBeenCalled();
  });

  it('rejects a non-image upload', async () => {
    const { service } = build();
    await expect(
      service.uploadPhoto(technician, 'area-1', {
        idempotencyKey: 'photo-key-abc123',
        captureType: 'AREA_OVERVIEW' as never,
      }, { ...jpeg, mimetype: 'application/pdf' }),
    ).rejects.toMatchObject({ status: 415, code: 'PHOTO_TYPE_UNSUPPORTED' });
  });

  it('rejects a finding link that does not belong to the area', async () => {
    const { service } = build({
      inspectionArea: { findFirst: jest.fn().mockResolvedValue(area) },
      inspectionFinding: { findFirst: jest.fn().mockResolvedValue(null) },
      inspectionPhoto: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
    });
    await expect(
      service.uploadPhoto(technician, 'area-1', {
        idempotencyKey: 'photo-key-abc123',
        captureType: 'FINDING_DETAIL' as never,
        findingId: '10000000-0000-4000-8000-0000000000ff',
      }, jpeg),
    ).rejects.toMatchObject({ status: 422, code: 'FINDING_NOT_IN_AREA' });
  });
});
