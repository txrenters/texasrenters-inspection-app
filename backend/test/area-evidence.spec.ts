import { UserRole } from '@texasrenters/shared';

import { AreaEvidenceService } from '../src/admin/area-evidence.service';
import type { AuthenticatedUser } from '../src/common/auth';

const user: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Reviewer',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: [],
  mustChangePassword: false,
};

const INSPECTION = 'inspection-1';

function area(id: string, propertyAreaId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    completionStatus: 'COMPLETED',
    skipReason: null,
    technicianNote: null,
    propertyArea: {
      id: propertyAreaId,
      name: `Area ${id}`,
      environment: 'INDOOR',
      isRequired: true,
      _count: { checklistItems: 0 },
      floor: { name: 'Ground Floor' },
    },
    ...overrides,
  };
}

function service(prisma: Record<string, unknown>, storage: Record<string, unknown> = {}) {
  return new AreaEvidenceService(prisma as never, {
    signedUrl: jest.fn().mockResolvedValue('https://cdn.example/poster.jpg'),
    ...storage,
  } as never);
}

function summaryPrisma(overrides: Record<string, unknown> = {}) {
  return {
    inspection: { findFirst: jest.fn().mockResolvedValue({ id: INSPECTION }) },
    inspectionArea: { findMany: jest.fn().mockResolvedValue([area('a1', 'p1')]) },
    inspectionMedia: { findMany: jest.fn().mockResolvedValue([]) },
    inspectionPhoto: { groupBy: jest.fn().mockResolvedValue([]) },
    inspectionFinding: { groupBy: jest.fn().mockResolvedValue([]) },
    // Checklist assessments are counted in the same grouped pass as everything
    // else, so the double has to answer for them too.
    inspectionAreaChecklistResponse: { groupBy: jest.fn().mockResolvedValue([]) },
    ...overrides,
  };
}

describe('area evidence summary', () => {
  it('returns counts and status without any media payload', async () => {
    const prisma = summaryPrisma({
      inspectionArea: {
        findMany: jest.fn().mockResolvedValue([area('a1', 'p1'), area('a2', 'p2')]),
      },
      inspectionMedia: {
        findMany: jest.fn().mockResolvedValue([
          {
            inspectionAreaId: 'a1',
            recordingType: 'PRIMARY_AREA',
            processingStatus: 'READY',
            createdAt: new Date('2026-07-28T10:00:00Z'),
          },
        ]),
      },
      inspectionPhoto: {
        groupBy: jest.fn().mockResolvedValue([
          {
            inspectionAreaId: 'a1',
            captureType: 'AREA_OVERVIEW',
            _count: { _all: 4 },
            _max: { capturedAt: new Date('2026-07-28T11:00:00Z') },
          },
        ]),
      },
    });

    const result = await service(prisma).summary(user, INSPECTION);

    expect(result.totals).toMatchObject({ areas: 2, recordings: 1, photos: 4 });
    expect(result.areas[0].counts).toMatchObject({ recordings: 1, photos: 4 });
    expect(result.areas[0].evidence.overviewPhotoAvailable).toBe(true);
    expect(result.areas[0].lastEvidenceAt).toBe('2026-07-28T11:00:00.000Z');
    // The point of the summary: it must carry nothing that costs bytes to load.
    const payload = JSON.stringify(result);
    expect(payload).not.toMatch(/contentPath|thumbnailUrl|storageKey/);
    // Photos are counted, never listed.
    expect(prisma.inspectionPhoto.groupBy).toHaveBeenCalled();
  });

  it('reads counts per area rather than once per area', async () => {
    const prisma = summaryPrisma({
      inspectionArea: {
        findMany: jest
          .fn()
          .mockResolvedValue(['a1', 'a2', 'a3', 'a4'].map((id, index) => area(id, `p${index}`))),
      },
    });

    await service(prisma).summary(user, INSPECTION);

    // Four areas must still cost one grouped read each, not one per area.
    expect(prisma.inspectionMedia.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.inspectionPhoto.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.inspectionFinding.groupBy).toHaveBeenCalledTimes(2);
  });

  it('refuses an inspection outside the organization', async () => {
    const prisma = summaryPrisma({ inspection: { findFirst: jest.fn().mockResolvedValue(null) } });

    await expect(service(prisma).summary(user, INSPECTION)).rejects.toMatchObject({
      status: 404,
      code: 'INSPECTION_NOT_FOUND',
    });
  });
});

describe('derived area review status', () => {
  async function statusFor(options: {
    media?: unknown[];
    photos?: unknown[];
    findings?: unknown[];
    completionStatus?: string;
    isRequired?: boolean;
  }) {
    const prisma = summaryPrisma({
      inspectionArea: {
        findMany: jest.fn().mockResolvedValue([
          area('a1', 'p1', {
            completionStatus: options.completionStatus ?? 'COMPLETED',
            propertyArea: {
              id: 'p1',
              name: 'Foyer',
              environment: 'INDOOR',
              isRequired: options.isRequired ?? true,
              floor: { name: 'Ground Floor' },
            },
          }),
        ]),
      },
      inspectionMedia: { findMany: jest.fn().mockResolvedValue(options.media ?? []) },
      inspectionPhoto: { groupBy: jest.fn().mockResolvedValue(options.photos ?? []) },
      inspectionAreaChecklistResponse: { groupBy: jest.fn().mockResolvedValue([]) },
      inspectionFinding: {
        groupBy: jest
          .fn()
          .mockResolvedValueOnce(options.findings ?? [])
          .mockResolvedValueOnce([]),
      },
    });
    const result = await service(prisma).summary(user, INSPECTION);
    return result.areas[0].reviewStatus;
  }

  const ready = {
    inspectionAreaId: 'a1',
    recordingType: 'PRIMARY_AREA',
    processingStatus: 'READY',
    createdAt: new Date(),
  };

  it('is NOT_STARTED with no evidence at all', async () => {
    expect(await statusFor({})).toBe('NOT_STARTED');
  });

  it('is EVIDENCE_READY when evidence exists and nothing needs a decision', async () => {
    expect(await statusFor({ media: [ready] })).toBe('EVIDENCE_READY');
  });

  it('is REVIEWED once decided findings exist', async () => {
    expect(
      await statusFor({
        media: [ready],
        findings: [{ propertyAreaId: 'p1', reviewStatus: 'APPROVED', _count: { _all: 2 } }],
      }),
    ).toBe('REVIEWED');
  });

  it('ranks a pending decision above being ready', async () => {
    expect(
      await statusFor({
        media: [ready],
        findings: [{ propertyAreaId: 'p1', reviewStatus: 'PENDING_REVIEW', _count: { _all: 3 } }],
      }),
    ).toBe('FINDINGS_NEED_REVIEW');
  });

  it('ranks broken evidence above everything else', async () => {
    expect(
      await statusFor({
        media: [{ ...ready, processingStatus: 'FAILED' }],
        findings: [{ propertyAreaId: 'p1', reviewStatus: 'PENDING_REVIEW', _count: { _all: 3 } }],
      }),
    ).toBe('FAILED');
  });

  it('flags a required area that has photos but no walkthrough', async () => {
    expect(
      await statusFor({
        photos: [
          {
            inspectionAreaId: 'a1',
            captureType: 'AREA_OVERVIEW',
            _count: { _all: 2 },
            _max: { capturedAt: new Date() },
          },
        ],
        isRequired: true,
      }),
    ).toBe('EVIDENCE_INCOMPLETE');
  });

  it('does not flag an optional area for the same gap', async () => {
    expect(
      await statusFor({
        photos: [
          {
            inspectionAreaId: 'a1',
            captureType: 'AREA_OVERVIEW',
            _count: { _all: 2 },
            _max: { capturedAt: new Date() },
          },
        ],
        isRequired: false,
      }),
    ).toBe('EVIDENCE_READY');
  });
});

describe('single area evidence bundle', () => {
  function bundlePrisma(overrides: Record<string, unknown> = {}) {
    return {
      inspection: { findFirst: jest.fn().mockResolvedValue({ id: INSPECTION }) },
      inspectionArea: { findFirst: jest.fn().mockResolvedValue(area('a1', 'p1')) },
      inspectionMedia: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'media-1',
            storageKey: 'org/insp/a1/videos/x.mp4',
            recordingType: 'PRIMARY_AREA',
            label: null,
            category: null,
            durationSeconds: 52,
            uploadStatus: 'UPLOADED',
            processingStatus: 'READY',
            createdAt: new Date('2026-07-28T10:00:00Z'),
            technician: { displayName: 'Ernie' },
          },
        ]),
      },
      inspectionPhoto: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'photo-1',
            captureType: 'AREA_OVERVIEW',
            label: null,
            notes: null,
            sequenceNumber: 0,
            width: 1600,
            height: 1200,
            capturedAt: new Date('2026-07-28T10:05:00Z'),
            findingId: null,
            capturedBy: { displayName: 'Ernie' },
          },
          {
            id: 'photo-2',
            captureType: 'FINDING_DETAIL',
            label: 'Close-up',
            notes: null,
            sequenceNumber: 1,
            width: 1600,
            height: 1200,
            capturedAt: new Date('2026-07-28T10:06:00Z'),
            findingId: 'finding-1',
            capturedBy: { displayName: 'Ernie' },
          },
        ]),
      },
      inspectionFinding: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'finding-1',
            title: 'Repaint Wall 1',
            description: 'Scuffing along the lower half.',
            category: 'WALLS',
            findingType: 'POSSIBLE_NEW_DAMAGE',
            severity: 'MEDIUM',
            comparisonResult: 'POSSIBLE_NEW_DAMAGE',
            baselineCondition: 'Clean at move-in.',
            confidence: 0.8,
            reviewStatus: 'PENDING_REVIEW',
            createdAt: new Date('2026-07-28T10:10:00Z'),
            inspectionMediaId: 'media-1',
            videoTimestampStart: 18,
            videoTimestampEnd: 26,
            _count: { photos: 1 },
            reviews: [],
          },
        ]),
        findFirst: jest.fn().mockResolvedValue({
          id: 'summary-1',
          description: 'Generally serviceable with paint damage.',
          createdAt: new Date('2026-07-28T10:12:00Z'),
          reviewStatus: 'PENDING_REVIEW',
        }),
      },
      ...overrides,
    };
  }

  it('keeps finding photos grouped under their finding', async () => {
    const bundle = await service(bundlePrisma()).areaEvidence(user, INSPECTION, 'a1');

    const overview = bundle.photoGroups.find((group) => group.key === 'OVERVIEW');
    const findingGroup = bundle.photoGroups.find((group) => group.key === 'FINDING');
    expect(overview?.photos.map((photo) => photo.id)).toEqual(['photo-1']);
    // Finding evidence must stay identifiable, not collapse into one gallery.
    expect(findingGroup?.findingId).toBe('finding-1');
    expect(findingGroup?.photos.map((photo) => photo.id)).toEqual(['photo-2']);
  });

  it('returns the condition summary separately from itemized findings', async () => {
    const bundle = await service(bundlePrisma()).areaEvidence(user, INSPECTION, 'a1');

    expect(bundle.conditionSummary?.description).toMatch(/serviceable/);
    // The summary is not one of the findings.
    expect(bundle.findings.map((finding) => finding.id)).toEqual(['finding-1']);
    expect(bundle.findings[0].recordingId).toBe('media-1');
    expect(bundle.findings[0].videoTimestampStart).toBe(18);
  });

  it('scopes every read to the requested area', async () => {
    const prisma = bundlePrisma();
    await service(prisma).areaEvidence(user, INSPECTION, 'a1');

    // Media and photos are read by inspection area, never by inspection alone.
    expect(prisma.inspectionMedia.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { inspectionAreaId: 'a1' } }),
    );
    expect(prisma.inspectionPhoto.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { inspectionAreaId: 'a1' } }),
    );
  });

  it('refuses an area id from another inspection', async () => {
    const prisma = bundlePrisma({
      inspectionArea: { findFirst: jest.fn().mockResolvedValue(null) },
    });

    await expect(
      service(prisma).areaEvidence(user, INSPECTION, 'foreign-area'),
    ).rejects.toMatchObject({ status: 404, code: 'INSPECTION_AREA_NOT_FOUND' });
  });

  it('signs poster frames but never playback URLs', async () => {
    const signedUrl = jest.fn().mockResolvedValue('https://cdn.example/poster.jpg');
    const bundle = await service(bundlePrisma(), { signedUrl }).areaEvidence(
      user,
      INSPECTION,
      'a1',
    );

    // One signature per recording, and it is the thumbnail — playback is minted
    // only when a reviewer presses play.
    expect(signedUrl).toHaveBeenCalledTimes(1);
    expect(signedUrl.mock.calls[0][0]).toMatch(/\.thumb\.jpg$/);
    expect(bundle.recordings[0].thumbnailUrl).toBe('https://cdn.example/poster.jpg');
  });
});
