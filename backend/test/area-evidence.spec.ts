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
  // Added with `principalType`; these fixtures are people, not integrations.
  principalType: 'USER',
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
  return new AreaEvidenceService(
    prisma as never,
    {
      signedUrl: jest.fn().mockResolvedValue('https://cdn.example/poster.jpg'),
      ...storage,
    } as never,
  );
}

function summaryPrisma(overrides: Record<string, unknown> = {}) {
  return {
    inspection: { findFirst: jest.fn().mockResolvedValue({ id: INSPECTION }) },
    inspectionArea: { findMany: jest.fn().mockResolvedValue([area('a1', 'p1')]) },
    inspectionMedia: { findMany: jest.fn().mockResolvedValue([]) },
    inspectionPhoto: { groupBy: jest.fn().mockResolvedValue([]) },
    inspectionFinding: { groupBy: jest.fn().mockResolvedValue([]) },
    // Checklist items and answers are read in the same pass as everything
    // else, so the double has to answer for them too.
    areaChecklistItem: { findMany: jest.fn().mockResolvedValue([]) },
    inspectionAreaChecklistResponse: { findMany: jest.fn().mockResolvedValue([]) },
    // Who marked an area reviewed, read once for the whole list.
    userProfile: {
      findMany: jest.fn().mockResolvedValue([{ id: user.id, displayName: 'Reviewer' }]),
    },
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
    expect(prisma.areaChecklistItem.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.inspectionAreaChecklistResponse.findMany).toHaveBeenCalledTimes(1);
  });

  it('orders areas the same way on every load', async () => {
    const prisma = summaryPrisma();

    await service(prisma).summary(user, INSPECTION);

    // Walk order is not unique; name then id settle a tie, so the list and the
    // viewer walking it never swap two areas between loads.
    expect(prisma.inspectionArea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { propertyArea: { inspectionOrder: 'asc' } },
          { propertyArea: { name: 'asc' } },
          { id: 'asc' },
        ],
      }),
    );
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
    inspectionType?: string;
    reviewedAt?: Date;
  }) {
    const prisma = summaryPrisma({
      inspection: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: INSPECTION, inspectionType: options.inspectionType }),
      },
      inspectionArea: {
        findMany: jest.fn().mockResolvedValue([
          area('a1', 'p1', {
            completionStatus: options.completionStatus ?? 'COMPLETED',
            reviewedAt: options.reviewedAt ?? null,
            reviewedById: options.reviewedAt ? user.id : null,
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

  const photographed = [
    {
      inspectionAreaId: 'a1',
      captureType: 'AREA_OVERVIEW',
      _count: { _all: 1 },
      _max: { capturedAt: new Date() },
    },
  ];

  it.each(['OCCUPIED', 'BACK_TO_MARKET', 'HVAC'])(
    'does not ask a %s visit for a walkthrough it never owed',
    async (inspectionType) => {
      // Walked in photographs: the handset finishes these areas without filming,
      // so a required area with only a photograph is ready, not incomplete.
      expect(await statusFor({ photos: photographed, inspectionType })).toBe('EVIDENCE_READY');
    },
  );

  it('still asks a move-out for its walkthrough', async () => {
    expect(await statusFor({ photos: photographed, inspectionType: 'MOVE_OUT' })).toBe(
      'EVIDENCE_INCOMPLETE',
    );
  });

  describe("with a reviewer's mark", () => {
    const received = new Date('2026-10-01T17:51:30Z');
    const before = new Date('2026-10-01T17:00:00Z');
    const after = new Date('2026-10-02T09:00:00Z');
    const photo = [
      {
        inspectionAreaId: 'a1',
        captureType: 'AREA_OVERVIEW',
        _count: { _all: 1 },
        _max: { capturedAt: received, createdAt: received },
      },
    ];

    it('counts an area with nothing to decide as reviewed', async () => {
      // The occupied room that read "0 of 20 reviewed" for good: no findings,
      // so nothing ever moved it past ready.
      expect(
        await statusFor({ photos: photo, inspectionType: 'OCCUPIED', reviewedAt: after }),
      ).toBe('REVIEWED');
    });

    it('stops counting once evidence arrives after the mark', async () => {
      expect(
        await statusFor({ photos: photo, inspectionType: 'OCCUPIED', reviewedAt: before }),
      ).toBe('EVIDENCE_READY');
    });

    it('never stands in for a finding still awaiting a decision', async () => {
      expect(
        await statusFor({
          photos: photo,
          inspectionType: 'OCCUPIED',
          reviewedAt: after,
          findings: [{ propertyAreaId: 'p1', reviewStatus: 'PENDING_REVIEW', _count: { _all: 1 } }],
        }),
      ).toBe('FINDINGS_NEED_REVIEW');
    });

    it('settles a skip the reviewer accepted', async () => {
      expect(await statusFor({ completionStatus: 'SKIPPED', reviewedAt: after })).toBe('REVIEWED');
    });

    it('settles a walkthrough the reviewer judged unnecessary', async () => {
      expect(
        await statusFor({ photos: photo, inspectionType: 'MOVE_OUT', reviewedAt: after }),
      ).toBe('REVIEWED');
    });
  });
});

describe('marking an area reviewed', () => {
  const AREA = {
    id: 'a1',
    completionStatus: 'COMPLETED',
    reviewedAt: null as Date | null,
    reviewedById: null as string | null,
    propertyArea: { id: 'p1', name: 'Living Room' },
  };

  function reviewPrisma(
    options: {
      finalizedAt?: Date | null;
      area?: Partial<typeof AREA> | null;
      photos?: number;
      lastPhotoAt?: Date | null;
      pending?: number;
    } = {},
  ) {
    const tx = {
      inspectionArea: { update: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    return {
      tx,
      inspection: {
        findFirst: jest.fn().mockResolvedValue({
          id: INSPECTION,
          inspectionType: 'OCCUPIED',
          finalizedAt: options.finalizedAt ?? null,
        }),
      },
      inspectionArea: {
        findFirst: jest
          .fn()
          .mockResolvedValue(options.area === null ? null : { ...AREA, ...options.area }),
      },
      inspectionMedia: {
        aggregate: jest.fn().mockResolvedValue({ _count: { _all: 0 }, _max: { createdAt: null } }),
      },
      inspectionPhoto: {
        aggregate: jest.fn().mockResolvedValue({
          _count: { _all: options.photos ?? 1 },
          _max: { createdAt: options.lastPhotoAt ?? new Date('2026-10-01T17:51:30Z') },
        }),
      },
      inspectionFinding: { count: jest.fn().mockResolvedValue(options.pending ?? 0) },
      userProfile: {
        findMany: jest.fn().mockResolvedValue([{ id: user.id, displayName: 'Reviewer' }]),
      },
      $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
  }

  it('records who reviewed the area, and audits it on the inspection', async () => {
    const prisma = reviewPrisma();

    const result = await service(prisma).setAreaReviewed(user, INSPECTION, 'a1', true);

    expect(result.review).toMatchObject({ byName: 'Reviewer', current: true });
    expect(prisma.tx.inspectionArea.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { reviewedAt: expect.any(Date), reviewedById: user.id },
    });
    expect(prisma.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'AREA_REVIEWED',
        entityType: 'Inspection',
        entityId: INSPECTION,
        metadata: { inspectionAreaId: 'a1', areaName: 'Living Room' },
      }),
    });
  });

  it('refuses while a finding in the area awaits a decision', async () => {
    const prisma = reviewPrisma({ pending: 2 });

    await expect(service(prisma).setAreaReviewed(user, INSPECTION, 'a1', true)).rejects.toMatchObject(
      { status: 409, code: 'AREA_FINDINGS_PENDING' },
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses an area nobody recorded anything in and nobody skipped', async () => {
    const prisma = reviewPrisma({ photos: 0, lastPhotoAt: null });

    await expect(service(prisma).setAreaReviewed(user, INSPECTION, 'a1', true)).rejects.toMatchObject(
      { status: 409, code: 'AREA_NOT_INSPECTED' },
    );
  });

  it('accepts a skipped area with nothing in it', async () => {
    const prisma = reviewPrisma({
      photos: 0,
      lastPhotoAt: null,
      area: { completionStatus: 'SKIPPED' },
    });

    await service(prisma).setAreaReviewed(user, INSPECTION, 'a1', true);

    expect(prisma.tx.inspectionArea.update).toHaveBeenCalled();
  });

  it('refuses once the inspection is finalized', async () => {
    const prisma = reviewPrisma({ finalizedAt: new Date() });

    await expect(service(prisma).setAreaReviewed(user, INSPECTION, 'a1', true)).rejects.toMatchObject(
      { status: 409, code: 'INSPECTION_FINALIZED' },
    );
  });

  it('refuses an area from another inspection', async () => {
    const prisma = reviewPrisma({ area: null });

    await expect(service(prisma).setAreaReviewed(user, INSPECTION, 'a1', true)).rejects.toMatchObject(
      { status: 404, code: 'INSPECTION_AREA_NOT_FOUND' },
    );
  });

  it('writes nothing when the same mark is sent again', async () => {
    const prisma = reviewPrisma({
      area: { reviewedAt: new Date('2026-10-02T09:00:00Z'), reviewedById: user.id },
    });

    const result = await service(prisma).setAreaReviewed(user, INSPECTION, 'a1', true);

    expect(result.review).toMatchObject({ current: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('marks again once newer evidence has overtaken the mark', async () => {
    const prisma = reviewPrisma({
      area: { reviewedAt: new Date('2026-10-01T09:00:00Z'), reviewedById: user.id },
    });

    await service(prisma).setAreaReviewed(user, INSPECTION, 'a1', true);

    expect(prisma.tx.inspectionArea.update).toHaveBeenCalled();
  });

  it('takes a mark back, and audits that too', async () => {
    const prisma = reviewPrisma({
      area: { reviewedAt: new Date('2026-10-02T09:00:00Z'), reviewedById: user.id },
    });

    const result = await service(prisma).setAreaReviewed(user, INSPECTION, 'a1', false);

    expect(result.review).toBeNull();
    expect(prisma.tx.inspectionArea.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { reviewedAt: null, reviewedById: null },
    });
    expect(prisma.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'AREA_REVIEW_WITHDRAWN' }),
    });
  });
});

describe('area checklist counts', () => {
  const unanswered = {
    isClean: null,
    isUndamaged: null,
    isWorking: null,
    numericValue: null,
    textValue: null,
  };

  async function countsFor(options: {
    inspectionType: string;
    areas: ReturnType<typeof area>[];
    items: unknown[];
    responses: unknown[];
  }) {
    const prisma = summaryPrisma({
      inspection: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: INSPECTION, inspectionType: options.inspectionType }),
      },
      inspectionArea: { findMany: jest.fn().mockResolvedValue(options.areas) },
      areaChecklistItem: { findMany: jest.fn().mockResolvedValue(options.items) },
      inspectionAreaChecklistResponse: { findMany: jest.fn().mockResolvedValue(options.responses) },
    });
    const result = await service(prisma).summary(user, INSPECTION);
    return {
      prisma,
      counts: Object.fromEntries(
        result.areas.map((row) => [row.id, `${row.checklistAssessedCount}/${row.checklistItemCount}`]),
      ),
    };
  }

  it('counts an occupied room by its answered questions, as the Condition tab does', async () => {
    const { prisma, counts } = await countsFor({
      inspectionType: 'OCCUPIED',
      areas: [area('a1', 'p1'), area('a2', 'p2')],
      items: [
        { id: 'q1', propertyAreaId: null, section: null, responseType: 'CHOICE' },
        { id: 'q2', propertyAreaId: null, section: null, responseType: 'CHOICE' },
      ],
      responses: [
        { ...unanswered, inspectionAreaId: 'a1', checklistItemId: 'q1', textValue: 'Clean' },
        { ...unanswered, inspectionAreaId: 'a1', checklistItemId: 'q2', textValue: 'Good' },
      ],
    });

    // Not "0/7": the occupied questions belong to the organization, and an
    // answer is a word rather than one of the three axes.
    expect(counts).toEqual({ a1: '2/2', a2: '0/2' });
    expect(prisma.areaChecklistItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: user.organizationId,
          propertyAreaId: null,
          kind: 'OCCUPIED',
        }),
      }),
    );
  });

  it('counts a move-out room against its own items, by any one axis', async () => {
    const { prisma, counts } = await countsFor({
      inspectionType: 'MOVE_OUT',
      areas: [area('a1', 'p1'), area('a2', 'p2')],
      items: [
        { id: 'i1', propertyAreaId: 'p1', section: null, responseType: 'STATUS' },
        { id: 'i2', propertyAreaId: 'p1', section: null, responseType: 'STATUS' },
        { id: 'i3', propertyAreaId: 'p2', section: null, responseType: 'STATUS' },
      ],
      responses: [
        { ...unanswered, inspectionAreaId: 'a1', checklistItemId: 'i1', isClean: true },
        // A comment alone is context, not an assessment.
        { ...unanswered, inspectionAreaId: 'a1', checklistItemId: 'i2' },
        // An item no longer asked -- archived since -- is not on the tab either.
        { ...unanswered, inspectionAreaId: 'a1', checklistItemId: 'archived', isClean: true },
        { ...unanswered, inspectionAreaId: 'a2', checklistItemId: 'i3', isWorking: false },
      ],
    });

    expect(counts).toEqual({ a1: '1/2', a2: '1/1' });
    expect(prisma.areaChecklistItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ propertyAreaId: { in: ['p1', 'p2'] }, kind: 'ROOM' }),
      }),
    );
  });

  it('counts an HVAC area against its own section of the list', async () => {
    const named = (id: string, name: string) => {
      const row = area(id, `p-${id}`);
      return { ...row, propertyArea: { ...row.propertyArea, name } };
    };
    const { counts } = await countsFor({
      inspectionType: 'HVAC',
      areas: [named('attic', 'Attic'), named('stat', 'Thermostat')],
      items: [
        { id: 'h1', propertyAreaId: null, section: 'Attic', responseType: 'STATUS' },
        { id: 'h2', propertyAreaId: null, section: 'Thermostat', responseType: 'STATUS' },
        { id: 'h3', propertyAreaId: null, section: 'Thermostat', responseType: 'READING' },
      ],
      responses: [
        { ...unanswered, inspectionAreaId: 'stat', checklistItemId: 'h3', numericValue: 18.5 },
      ],
    });

    // A reading is assessed once it is given, like a ticked axis.
    expect(counts).toEqual({ attic: '0/1', stat: '1/2' });
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
            captureTimeSource: 'DEVICE_CLOCK',
            createdAt: new Date('2026-07-28T10:05:21Z'),
            sha256: null,
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
            captureTimeSource: 'DEVICE_CLOCK',
            createdAt: new Date('2026-07-28T10:06:30Z'),
            sha256: null,
            findingId: 'finding-1',
            capturedBy: { displayName: 'Ernie' },
          },
        ]),
      },
      // The bundle now carries the area's checklist, driven from the item list
      // so an unassessed item still appears.
      areaChecklistItem: { findMany: jest.fn().mockResolvedValue([]) },
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

  it('shows a photograph filed against a finding the list does not hold', async () => {
    const prisma = bundlePrisma();
    const [overviewPhoto, closeUp] = await prisma.inspectionPhoto.findMany();
    prisma.inspectionPhoto.findMany.mockResolvedValue([
      overviewPhoto,
      closeUp,
      // Filed against the condition summary, which is kept apart from findings.
      { ...overviewPhoto, id: 'photo-3', sequenceNumber: 2, findingId: 'summary-1' },
    ]);

    const bundle = await service(prisma).areaEvidence(user, INSPECTION, 'a1');

    // It used to be counted and shown nowhere.
    const shown = bundle.photoGroups.flatMap((group) => group.photos.map((photo) => photo.id));
    expect(shown).toEqual(expect.arrayContaining(['photo-1', 'photo-2', 'photo-3']));
    expect(bundle.photoGroups.find((group) => group.key === 'OVERVIEW')?.photos.map((photo) => photo.id)).toEqual(
      ['photo-1', 'photo-3'],
    );
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

  it.each([
    ['OCCUPIED', 'EVIDENCE_READY'],
    ['MOVE_OUT', 'EVIDENCE_INCOMPLETE'],
  ])('reads a photographed %s area as %s, as the summary does', async (inspectionType, status) => {
    const prisma = bundlePrisma({
      inspection: { findFirst: jest.fn().mockResolvedValue({ id: INSPECTION, inspectionType }) },
      inspectionMedia: { findMany: jest.fn().mockResolvedValue([]) },
      inspectionFinding: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    });

    const bundle = await service(prisma).areaEvidence(user, INSPECTION, 'a1');

    expect(bundle.area.reviewStatus).toBe(status);
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
