import 'reflect-metadata';

import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { InspectionVideoService } from '../src/media/inspection-video.service';

const ORG = '10000000-0000-4000-8000-000000000001';
const MEDIA = '20000000-0000-4000-8000-000000000001';
const AREA = '20000000-0000-4000-8000-000000000002';
const PROPERTY_AREA = '20000000-0000-4000-8000-000000000003';
const ITEM = '20000000-0000-4000-8000-000000000004';
const FINDING = '20000000-0000-4000-8000-000000000005';

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
    inspectionArea: { propertyAreaId: PROPERTY_AREA, inspection: { finalizedAt: null } },
  } as Record<string, unknown> | null,
  item = { id: ITEM } as { id: string } | null,
  finding = { id: FINDING } as { id: string } | null,
  existingPhoto = null as { id: string; findingId?: string | null } | null,
} = {}) {
  const prisma = {
    inspectionMedia: { findFirst: jest.fn().mockResolvedValue(media) },
    areaChecklistItem: { findFirst: jest.fn().mockResolvedValue(item) },
    inspectionFinding: { findFirst: jest.fn().mockResolvedValue(finding) },
    inspectionPhoto: {
      findUnique: jest.fn().mockResolvedValue(existingPhoto),
      create: jest.fn().mockResolvedValue({ id: 'photo-1' }),
      update: jest.fn().mockResolvedValue({}),
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
        inspectionArea: { propertyAreaId: PROPERTY_AREA, inspection: { finalizedAt: null } },
      },
    });

    await expect(service.captureSnapshot(reviewer(), MEDIA, { atMs: 1000 })).rejects.toMatchObject({
      status: 409,
      code: 'RECORDING_NOT_READY',
    });
  });

  /**
   * A reviewer picking the frame that shows a finding: the still is filed
   * under it, and like every finding photograph it prints only once the
   * finding is approved.
   */
  it('files the still under the finding it shows', async () => {
    globalThis.fetch = okFetch() as never;
    const { prisma, service } = build();

    await service.captureSnapshot(reviewer(), MEDIA, { atMs: 61_000, findingId: FINDING });

    const [[lookup]] = prisma.inspectionFinding.findFirst.mock.calls;
    // This inspection and this room: never somebody else's finding.
    expect(lookup.where).toEqual({
      id: FINDING,
      inspectionId: 'insp-1',
      propertyAreaId: PROPERTY_AREA,
    });
    const [[create]] = prisma.inspectionPhoto.create.mock.calls;
    expect(create.data).toMatchObject({ findingId: FINDING, captureType: 'VIDEO_FRAME_SNAPSHOT' });
  });

  it('refuses a finding from another room or inspection', async () => {
    const { prisma, service } = build({ finding: null });

    await expect(
      service.captureSnapshot(reviewer(), MEDIA, { atMs: 1000, findingId: FINDING }),
    ).rejects.toMatchObject({ status: 404, code: 'FINDING_NOT_FOUND' });
    expect(prisma.inspectionPhoto.create).not.toHaveBeenCalled();
  });

  it('files an earlier unfiled capture of the same frame instead of making a second', async () => {
    const { prisma, service } = build({ existingPhoto: { id: 'photo-existing', findingId: null } });

    await expect(
      service.captureSnapshot(reviewer(), MEDIA, { atMs: 1000, findingId: FINDING }),
    ).resolves.toMatchObject({ id: 'photo-existing', reused: true });
    expect(prisma.inspectionPhoto.update).toHaveBeenCalledWith({
      where: { id: 'photo-existing' },
      data: { findingId: FINDING },
    });
    expect(prisma.inspectionPhoto.create).not.toHaveBeenCalled();
  });

  it('leaves a frame already filed under another finding where it is', async () => {
    const { prisma, service } = build({
      existingPhoto: { id: 'photo-existing', findingId: 'some-other-finding' },
    });

    await service.captureSnapshot(reviewer(), MEDIA, { atMs: 1000, findingId: FINDING });
    expect(prisma.inspectionPhoto.update).not.toHaveBeenCalled();
  });

  it('adds nothing to an inspection that has been finalized', async () => {
    // Evidence freezes at finalization: a still added afterwards would change
    // a report that may already be shared.
    const { prisma, service } = build({
      media: {
        id: MEDIA,
        streamUid: 'uid-1',
        readyAt: new Date(),
        durationSeconds: 120,
        inspectionId: 'insp-1',
        inspectionAreaId: AREA,
        inspectionArea: {
          propertyAreaId: PROPERTY_AREA,
          inspection: { finalizedAt: new Date('2026-10-02T15:00:00.000Z') },
        },
      },
    });

    await expect(service.captureSnapshot(reviewer(), MEDIA, { atMs: 1000 })).rejects.toMatchObject({
      status: 409,
      code: 'INSPECTION_FINALIZED',
    });
    expect(prisma.inspectionPhoto.create).not.toHaveBeenCalled();
  });

  it('does not leave orphaned bytes when the row cannot be written', async () => {
    globalThis.fetch = okFetch() as never;
    const { prisma, storage, service } = build();
    prisma.inspectionPhoto.create.mockRejectedValue(new Error('constraint'));

    await expect(service.captureSnapshot(reviewer(), MEDIA, { atMs: 1000 })).rejects.toThrow();
    expect(storage.delete).toHaveBeenCalled();
  });
});

/**
 * The AI's suggested frame for a finding: a person files it as the finding's
 * photograph, or sets it aside. The same permission and the same freeze as a
 * capture by hand, because that is what accepting one is.
 */
describe("deciding the AI's suggested photograph", () => {
  const SUGGESTION = '30000000-0000-4000-8000-000000000001';

  function suggestionHarness(suggestion: Record<string, unknown> | null = {}) {
    const built = build();
    const row =
      suggestion === null
        ? null
        : {
            id: SUGGESTION,
            status: 'SUGGESTED',
            photoId: null,
            atMs: 21_500,
            findingId: FINDING,
            inspectionId: 'insp-1',
            inspectionMediaId: MEDIA,
            inspection: { finalizedAt: null },
            ...suggestion,
          };
    const findingFrameSuggestion = {
      findFirst: jest.fn().mockResolvedValue(row),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: SUGGESTION,
        status: data.status,
        photoId: data.photoId ?? null,
      })),
    };
    const auditLog = { create: jest.fn().mockResolvedValue({}) };
    Object.assign(built.prisma, { findingFrameSuggestion, auditLog });
    return { ...built, findingFrameSuggestion, auditLog };
  }

  it('files the frame under its finding and says who did', async () => {
    globalThis.fetch = okFetch() as never;
    const { service, prisma, findingFrameSuggestion, auditLog } = suggestionHarness();

    await expect(service.acceptFrameSuggestion(reviewer(), SUGGESTION)).resolves.toEqual({
      id: SUGGESTION,
      status: 'ACCEPTED',
      photoId: 'photo-1',
    });

    // The capture a reviewer would make by hand, at the AI's moment.
    const [[create]] = prisma.inspectionPhoto.create.mock.calls;
    expect(create.data).toMatchObject({
      findingId: FINDING,
      captureType: 'VIDEO_FRAME_SNAPSHOT',
      metadata: { videoTimestampMs: 21_500 },
    });
    expect(findingFrameSuggestion.update.mock.calls[0][0].data).toMatchObject({
      status: 'ACCEPTED',
      photoId: 'photo-1',
      decidedById: reviewer().id,
    });
    expect(auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'FRAME_SUGGESTION_ACCEPTED',
        entityType: 'InspectionFinding',
        entityId: FINDING,
        metadata: expect.objectContaining({ inspectionId: 'insp-1', photoId: 'photo-1' }),
      }),
    });
  });

  it('sets a frame aside, which files nothing', async () => {
    const { service, prisma, findingFrameSuggestion, auditLog } = suggestionHarness();

    await expect(service.dismissFrameSuggestion(reviewer(), SUGGESTION)).resolves.toMatchObject({
      status: 'DISMISSED',
    });
    expect(prisma.inspectionPhoto.create).not.toHaveBeenCalled();
    expect(findingFrameSuggestion.update.mock.calls[0][0].data.status).toBe('DISMISSED');
    expect(auditLog.create.mock.calls[0][0].data.action).toBe('FRAME_SUGGESTION_DISMISSED');
  });

  it('will not set aside a frame already filed', async () => {
    const { service } = suggestionHarness({ status: 'ACCEPTED', photoId: 'photo-9' });
    await expect(service.dismissFrameSuggestion(reviewer(), SUGGESTION)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("is the office's to decide, not a technician's", async () => {
    const { service, findingFrameSuggestion } = suggestionHarness();
    await expect(service.acceptFrameSuggestion(reviewer([]), SUGGESTION)).rejects.toMatchObject({
      status: 403,
    });
    expect(findingFrameSuggestion.findFirst).not.toHaveBeenCalled();
  });

  it('changes nothing once the inspection is finalized', async () => {
    const { service, findingFrameSuggestion } = suggestionHarness({
      inspection: { finalizedAt: new Date('2026-10-02T15:00:00.000Z') },
    });
    await expect(service.acceptFrameSuggestion(reviewer(), SUGGESTION)).rejects.toMatchObject({
      code: 'INSPECTION_FINALIZED',
    });
    await expect(service.dismissFrameSuggestion(reviewer(), SUGGESTION)).rejects.toMatchObject({
      code: 'INSPECTION_FINALIZED',
    });
    expect(findingFrameSuggestion.update).not.toHaveBeenCalled();
  });

  it('answers not found outside the organization', async () => {
    const { service, findingFrameSuggestion } = suggestionHarness(null);
    await expect(service.acceptFrameSuggestion(reviewer(), SUGGESTION)).rejects.toMatchObject({
      status: 404,
    });
    expect(findingFrameSuggestion.findFirst.mock.calls[0][0].where).toEqual({
      id: SUGGESTION,
      organizationId: ORG,
    });
  });
});
