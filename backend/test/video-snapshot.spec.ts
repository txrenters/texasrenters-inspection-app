import 'reflect-metadata';

import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { InspectionVideoService } from '../src/media/inspection-video.service';

const ORG = '10000000-0000-4000-8000-000000000001';
const MEDIA = '20000000-0000-4000-8000-000000000001';
const AREA = '20000000-0000-4000-8000-000000000002';
const PROPERTY_AREA = '20000000-0000-4000-8000-000000000003';
const ITEM = '20000000-0000-4000-8000-000000000004';

function reviewer(
  permissions: AuthenticatedUser['permissions'] = ['inspections:manage'],
): AuthenticatedUser {
  return {
    id: '10000000-0000-4000-8000-000000000009',
    authUserId: 'auth-admin',
    organizationId: ORG,
    displayName: 'Reviewer',
    roles: [UserRole.PROPERTY_ADMIN],
    permissions,
    mustChangePassword: false,
    // Added with `principalType`; these fixtures are people, not integrations.
    principalType: 'USER',
  };
}

function build({
  media = {
    id: MEDIA,
    streamUid: 'uid-1',
    readyAt: new Date(),
    durationSeconds: 120,
    inspectionId: 'insp-1',
    inspectionAreaId: AREA,
    inspectionArea: { propertyAreaId: PROPERTY_AREA },
  } as Record<string, unknown> | null,
  item = { id: ITEM } as { id: string } | null,
  existingPhoto = null as { id: string } | null,
} = {}) {
  const prisma = {
    inspectionMedia: { findFirst: jest.fn().mockResolvedValue(media) },
    areaChecklistItem: { findFirst: jest.fn().mockResolvedValue(item) },
    inspectionPhoto: {
      findUnique: jest.fn().mockResolvedValue(existingPhoto),
      create: jest.fn().mockResolvedValue({ id: 'photo-1' }),
    },
  };
  const stream = {
    customerCode: 'cust',
    signPlaybackToken: jest.fn().mockReturnValue({ token: 'tok', expiresAt: new Date() }),
  };
  const storage = { putBytes: jest.fn().mockResolvedValue(undefined), delete: jest.fn() };
  const service = new InspectionVideoService(
    prisma as never,
    stream as never,
    undefined,
    storage as never,
  );
  return { prisma, stream, storage, service };
}

function okFetch() {
  return jest.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  });
}

describe('capturing a still from a recording', () => {
  afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  /**
   * The boundary that matters. A technician may watch their own recording —
   * getPlayback allows that deliberately — but deciding which frame becomes
   * evidence in a report handed to a tenant is the office's call. This
   * controller carries no permissions guard, so scoping by organization alone
   * would have let any authenticated technician file report evidence.
   */
  it('refuses a caller without inspections:manage', async () => {
    const { prisma, service } = build();

    await expect(
      service.captureSnapshot(reviewer([]), MEDIA, { atMs: 1000 }),
    ).rejects.toMatchObject({ status: 403 });
    expect(prisma.inspectionMedia.findFirst).not.toHaveBeenCalled();
  });

  it('captures the frame at the requested moment and files it as evidence', async () => {
    globalThis.fetch = okFetch() as never;
    const { prisma, storage, service } = build();

    const result = await service.captureSnapshot(reviewer(), MEDIA, {
      atMs: 63_500,
      checklistItemId: ITEM,
    });

    expect(result).toMatchObject({ id: 'photo-1', atMs: 63_500, reused: false });
    // `?time=` is what makes this cheap: Cloudflare renders the frame, so the
    // video never reaches this process.
    const [[url]] = (globalThis.fetch as jest.Mock).mock.calls;
    expect(url).toContain('/thumbnails/thumbnail.jpg?time=63.500s');
    expect(storage.putBytes).toHaveBeenCalled();
    const [[create]] = prisma.inspectionPhoto.create.mock.calls;
    expect(create.data).toMatchObject({
      captureType: 'VIDEO_FRAME_SNAPSHOT',
      checklistItemId: ITEM,
      metadata: { videoTimestampMs: 63_500, captureSource: 'VIDEO_FRAME_EXTRACTION' },
    });
  });

  it('returns the stored photo instead of filing a duplicate', async () => {
    // Clicking the same frame twice must not put the same still into the report
    // twice.
    const { prisma, service } = build({ existingPhoto: { id: 'photo-existing' } });

    await expect(service.captureSnapshot(reviewer(), MEDIA, { atMs: 1000 })).resolves.toMatchObject(
      { id: 'photo-existing', reused: true },
    );
    expect(prisma.inspectionPhoto.create).not.toHaveBeenCalled();
  });

  it('refuses a moment outside the recording', async () => {
    // A frame past the end yields nothing, and an unchecked offset would let a
    // caller drive arbitrary requests at Cloudflare on our account.
    const { service } = build();

    for (const atMs of [-1, 120_001]) {
      await expect(service.captureSnapshot(reviewer(), MEDIA, { atMs })).rejects.toMatchObject({
        status: 400,
        code: 'SNAPSHOT_OFFSET_OUT_OF_RANGE',
      });
    }
  });

  it('refuses a checklist item from another area', async () => {
    const { prisma, service } = build({ item: null });

    await expect(
      service.captureSnapshot(reviewer(), MEDIA, { atMs: 1000, checklistItemId: ITEM }),
    ).rejects.toMatchObject({ status: 404, code: 'CHECKLIST_ITEM_NOT_FOUND' });
    expect(prisma.inspectionPhoto.create).not.toHaveBeenCalled();

    const [[lookup]] = prisma.areaChecklistItem.findFirst.mock.calls;
    expect(lookup.where).toMatchObject({ id: ITEM, propertyAreaId: PROPERTY_AREA });
  });

  it('refuses a recording Cloudflare has not finished encoding', async () => {
    const { service } = build({
      media: {
        id: MEDIA,
        streamUid: 'uid-1',
        readyAt: null,
        durationSeconds: 60,
        inspectionId: 'insp-1',
        inspectionAreaId: AREA,
        inspectionArea: { propertyAreaId: PROPERTY_AREA },
      },
    });

    await expect(service.captureSnapshot(reviewer(), MEDIA, { atMs: 1000 })).rejects.toMatchObject({
      status: 409,
      code: 'RECORDING_NOT_READY',
    });
  });

  it('does not leave orphaned bytes when the row cannot be written', async () => {
    globalThis.fetch = okFetch() as never;
    const { prisma, storage, service } = build();
    prisma.inspectionPhoto.create.mockRejectedValue(new Error('constraint'));

    await expect(service.captureSnapshot(reviewer(), MEDIA, { atMs: 1000 })).rejects.toThrow();
    expect(storage.delete).toHaveBeenCalled();
  });
});
