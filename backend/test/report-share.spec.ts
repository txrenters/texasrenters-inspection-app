import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { ReportShareService } from '../src/admin/report-share.service';

/** The photographs a shared report prints: all but a rejected finding's. */
const VISIBLE = { OR: [{ findingId: null }, { finding: { reviewStatus: { not: 'REJECTED' } } }] };

const admin: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000002',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'System Admin',
  roles: [UserRole.SYSTEM_ADMIN],
  permissions: [],
  mustChangePassword: false,
  // Added with `principalType`; these fixtures are people, not integrations.
  principalType: 'USER',
};

describe('inspection report shares', () => {
  it('creates an org-scoped share with an unguessable token and audit trail', async () => {
    const tx = {
      inspectionReportShare: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'share-1',
          createdAt: new Date(),
          revokedAt: null,
          ...data,
        })),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      inspection: { findFirst: jest.fn().mockResolvedValue({ id: 'inspection-1' }) },
      $transaction: jest.fn(async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const service = new ReportShareService(prisma as never);

    const share = await service.createShare(admin, 'inspection-1', 'Owner@Example.com ');

    expect(prisma.inspection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inspection-1', organizationId: admin.organizationId },
      }),
    );
    expect(share.token.length).toBeGreaterThanOrEqual(40);
    expect(share.sharePath).toBe(`/report/${share.token}`);
    expect(share.recipientEmail).toBe('owner@example.com');
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'REPORT_SHARE_CREATED' }),
      }),
    );
  });

  it('rejects share creation for inspections outside the organization', async () => {
    const prisma = {
      inspection: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(),
    };
    const service = new ReportShareService(prisma as never);

    await expect(service.createShare(admin, 'foreign-inspection')).rejects.toMatchObject({
      status: 404,
      code: 'INSPECTION_NOT_FOUND',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses public reports for revoked and expired tokens', async () => {
    const revoked = {
      inspectionId: 'inspection-1',
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: new Date(),
    };
    const expired = {
      inspectionId: 'inspection-1',
      expiresAt: new Date(Date.now() - 1_000),
      revokedAt: null,
    };
    const prisma = {
      inspectionReportShare: {
        findUnique: jest.fn().mockResolvedValueOnce(revoked).mockResolvedValueOnce(expired),
      },
      inspection: { findUnique: jest.fn() },
    };
    const service = new ReportShareService(prisma as never);

    await expect(service.publicReport('revoked-token')).rejects.toMatchObject({
      code: 'REPORT_NOT_AVAILABLE',
    });
    await expect(service.publicReport('expired-token')).rejects.toMatchObject({
      code: 'REPORT_NOT_AVAILABLE',
    });
    expect(prisma.inspection.findUnique).not.toHaveBeenCalled();
  });

  it('builds the public report from approved findings only, without internal fields', async () => {
    const prisma = {
      inspectionReportShare: {
        findUnique: jest.fn().mockResolvedValue({
          inspectionId: 'inspection-1',
          expiresAt: new Date(Date.now() + 86_400_000),
          revokedAt: null,
          // Whoever issued the link; the report names the office before the field.
          createdBy: { displayName: 'Operations Team' },
        }),
      },
      inspection: {
        findUnique: jest.fn().mockResolvedValue({
          inspectionType: 'MOVE_OUT',
          assignments: [{ technician: { displayName: 'Lovely Mae' } }],
          status: 'COMPLETED',
          scheduledAt: new Date('2026-07-20T15:00:00Z'),
          completedAt: new Date('2026-07-22T15:00:00Z'),
          propertywareBuilding: {
            name: 'Oak Ridge',
            addressLine1: '1458 Oak Ridge Dr',
            city: 'Austin',
            state: 'TX',
            postalCode: '78701',
          },
          areas: [
            {
              id: 'area-1',
              propertyAreaId: 'property-area-1',
              completionStatus: 'COMPLETED',
              skipReason: null,
              completedAt: new Date(),
              propertyArea: {
                name: 'Kitchen',
                floor: { name: 'Ground Floor' },
                // The room's form: one row answered below, one never scored.
                checklistItems: [
                  { id: 'item-1', label: 'Doors and locks', keywords: ['door'], kind: 'ROOM', responseType: 'STATUS', unit: null },
                  { id: 'item-2', label: 'Walls and ceilings', keywords: ['wall'], kind: 'ROOM', responseType: 'STATUS', unit: null },
                ],
              },
              // A partial assessment: Working was never scored, and the report
              // has to carry that through as null rather than false.
              checklistResponses: [
                {
                  isClean: false,
                  isUndamaged: true,
                  isWorking: null,
                  comment: 'scratches on door',
                  checklistItem: { id: 'item-1', label: 'Doors and locks', keywords: ['door'] },
                },
              ],
              photos: [
                {
                  id: 'photo-1',
                  label: 'Countertop',
                  notes: null,
                  capturedAt: new Date('2026-07-22T16:12:00Z'),
                  width: 1600,
                  height: 1200,
                },
              ],
              // The walkthrough, then an extra clip; a blank utterance is dropped.
              media: [
                {
                  recordingType: 'PRIMARY_AREA',
                  label: 'ignored for the walkthrough',
                  transcriptionJob: {
                    segments: [
                      { startSeconds: 1, endSeconds: 4, text: ' We are in the kitchen. ' },
                      { startSeconds: 5, endSeconds: 5, text: '' },
                      { startSeconds: 9, endSeconds: 7, text: 'Burn mark by the stove.' },
                    ],
                  },
                },
                {
                  recordingType: 'ADDITIONAL_ISSUE',
                  label: 'Under the sink',
                  transcriptionJob: { segments: [{ startSeconds: 0, endSeconds: 2, text: 'Leak.' }] },
                },
                // Transcribed, but said nothing: not printed as an empty heading.
                { recordingType: 'ADDITIONAL_ISSUE', label: 'Silent', transcriptionJob: { segments: [] } },
              ],
            },
          ],
          findings: [
            {
              id: 'finding-1',
              propertyAreaId: 'property-area-1',
              title: 'Countertop burn mark',
              description: 'New burn mark near the stove.',
              category: 'DAMAGE',
              severity: 'MODERATE',
              comparisonResult: 'WORSENED',
              baselineCondition: 'No damage documented at move-in.',
              propertyArea: { name: 'Kitchen' },
            },
          ],
        }),
      },
      // The comments' notes: every finding the office has not rejected.
      inspectionFinding: {
        findMany: jest.fn().mockResolvedValue([
          {
            propertyAreaId: 'property-area-1',
            title: 'Door: two scratches by the handle',
            category: 'Doors',
            propertyArea: { name: 'Kitchen' },
          },
        ]),
      },
    };
    const service = new ReportShareService(prisma as never);

    const report = await service.publicReport('valid-token');

    const findingsQuery = prisma.inspection.findUnique.mock.calls[0][0] as {
      select: { findings: { where: { reviewStatus: string } } };
    };
    // The findings section stays the office's confirmed findings...
    expect(findingsQuery.select.findings.where).toEqual({ reviewStatus: 'APPROVED' });
    // ...and the comments read every finding not rejected, by title only, so
    // they are there before anyone confirms them (the office, 2026-10-07).
    const notesQuery = prisma.inspectionFinding.findMany.mock.calls[0][0];
    expect(notesQuery.where).toEqual({
      inspectionId: 'inspection-1',
      reviewStatus: { not: 'REJECTED' },
      findingType: { not: 'NO_CHANGE' },
    });
    expect(notesQuery.select).not.toHaveProperty('description');
    expect(report.checklistNotes).toEqual([
      { roomId: 'area-1', roomName: 'Kitchen', category: 'Doors', title: 'Door: two scratches by the handle' },
    ]);
    expect(report.property.addressLine1).toBe('1458 Oak Ridge Dr');
    expect(report.rooms).toHaveLength(1);
    // Only a finished transcription counts, and nothing of the recording
    // travels: no ids, no playback, no technician -- and no transcript.
    const mediaQuery = findingsQuery.select as unknown as {
      areas: { select: { media: { where: unknown; select: Record<string, unknown> } } };
    };
    expect(mediaQuery.areas.select.media.where).toEqual({
      transcriptionJob: { status: 'COMPLETED' },
    });
    // Only to tell whether the room's summary is about these recordings.
    expect(Object.keys(mediaQuery.areas.select.media.select).sort()).toEqual([
      'id',
      'transcriptionJob',
    ]);
    // The transcript left the report (the maintenance team, 2026-10-07).
    expect(report.rooms[0]).not.toHaveProperty('narration');
    expect(JSON.stringify(report)).not.toContain('We are in the kitchen');
    // Not summarized: no actions at all, so the Comments come from the findings.
    expect(report.rooms[0].actions).toBeUndefined();
    expect(report.findings).toHaveLength(1);
    // Findings resolve to the per-inspection room so the view model can group them.
    expect(report.findings[0].roomId).toBe('area-1');
    expect(report.photos).toHaveLength(1);
    expect(report.photos[0].contentPath).toBe('/api/v1/reports/valid-token/photos/photo-1');
    // The rule the printed report depends on: an unassessed axis stays null.
    // Coercing it to false would publish a defect the technician never
    // observed, on a document a tenant may be shown.
    // The field only: the office's name -- whoever issued the link or signed
    // the report off -- came off this line at the maintenance team's request
    // (2026-10-07).
    expect(report.inspection.inspector).toBe('Lovely Mae');
    // Every row of the room's form, in its order: the unscored one prints with
    // blank cells rather than vanishing, so a room nobody scored still shows
    // what was asked.
    expect(report.rooms[0].checklist).toEqual([
      {
        id: 'item-1',
        label: 'Doors and locks',
        keywords: ['door'],
        isClean: false,
        isUndamaged: true,
        isWorking: null,
        comment: 'scratches on door',
      },
      {
        id: 'item-2',
        label: 'Walls and ceilings',
        keywords: ['wall'],
        isClean: null,
        isUndamaged: null,
        isWorking: null,
        comment: null,
      },
    ]);
    expect(JSON.stringify(report)).not.toMatch(/internalNotes|technician|organizationId/);
  });

  it('prints what a room needs while its summary is about its recordings, and never the transcript', async () => {
    const recording = (id: string) => ({
      id,
      recordingType: 'PRIMARY_AREA',
      label: null,
      transcriptionJob: {
        segments: [{ startSeconds: 0, endSeconds: 4, text: 'Um, door needs, uh, touch-up paint.' }],
      },
    });
    const summary = {
      version: 2,
      mediaIds: ['media-1'],
      recordings: [{ mediaId: 'media-1', label: null, lines: [{ start: 0, text: 'Door needs touch-up paint.' }] }],
      actions: [
        {
          group: 'REPAIRS',
          items: [{ text: 'Touch-up paint on the door', details: [], itemId: 'item-1', itemLabel: 'Doors and locks' }],
        },
      ],
    };
    const area = (media: unknown[]) => ({
      id: 'area-1',
      propertyAreaId: 'property-area-1',
      completionStatus: 'COMPLETED',
      skipReason: null,
      completedAt: new Date(),
      recordingSummary: summary,
      propertyArea: { name: 'Kitchen', source: 'FLOOR_PLAN', floor: null, checklistItems: [] },
      checklistResponses: [],
      photos: [],
      media,
    });
    const reportWith = async (media: unknown[]) => {
      const prisma = {
        inspectionReportShare: {
          findUnique: jest.fn().mockResolvedValue({
            inspectionId: 'inspection-1',
            expiresAt: new Date(Date.now() + 86_400_000),
            revokedAt: null,
            createdBy: { displayName: 'Operations Team' },
          }),
        },
        inspection: {
          findUnique: jest.fn().mockResolvedValue({
            inspectionType: 'MOVE_OUT',
            assignments: [],
            status: 'COMPLETED',
            scheduledAt: new Date(),
            completedAt: new Date(),
            propertywareBuilding: null,
            propertywareUnit: null,
            areas: [area(media)],
            findings: [],
          }),
        },
        inspectionFinding: { findMany: jest.fn().mockResolvedValue([]) },
      };
      return new ReportShareService(prisma as never).publicReport('valid-token');
    };

    const current = await reportWith([recording('media-1')]);
    // With the item each is about, which the report prints it beside.
    expect(current.rooms[0].actions).toEqual([
      { heading: 'Repairs / Maintenance', items: [{ text: 'Touch-up paint on the door', details: [], itemId: 'item-1' }] },
    ]);
    // The recordings' ids decide, and are never printed; nor is the
    // transcript, or the summary's timestamped points.
    expect(JSON.stringify(current)).not.toContain('media-1');
    expect(JSON.stringify(current)).not.toContain('Door needs touch-up paint.');

    // A recording added after the summary: no actions until it is summarized
    // again, and the Comments come from the findings meanwhile.
    const stale = await reportWith([recording('media-1'), recording('media-2')]);
    expect(stale.rooms[0].actions).toBeUndefined();
  });

  it('withholds only the photos of a finding nobody approved', async () => {
    const prisma = {
      inspectionReportShare: {
        findUnique: jest.fn().mockResolvedValue({
          inspectionId: 'inspection-1',
          expiresAt: new Date(Date.now() + 86_400_000),
          revokedAt: null,
          // Whoever issued the link; the report names the office before the field.
          createdBy: { displayName: 'Operations Team' },
        }),
      },
      inspection: {
        findUnique: jest.fn().mockResolvedValue({
          inspectionType: 'MOVE_OUT',
          // Unassigned: the report must not claim an inspector it lacks.
          assignments: [],
          status: 'COMPLETED',
          scheduledAt: new Date(),
          completedAt: new Date(),
          propertywareBuilding: null,
          propertywareUnit: null,
          areas: [],
          findings: [],
        }),
      },
      inspectionFinding: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new ReportShareService(prisma as never);

    await service.publicReport('valid-token');

    const query = prisma.inspection.findUnique.mock.calls[0][0] as {
      select: { areas: { select: { photos: { where: unknown } } } };
    };
    /**
     * Every photograph but a rejected finding's. What must not leak is the
     * AI's unconfirmed claim -- a finding's words -- and only APPROVED findings
     * are printed. The still the AI filed for a finding waiting on the office
     * is the technician's own recording, with no caption: holding it back left
     * 10830 Harston Dr's move-out report without one of its 120 photographs
     * (2026-10-07).
     *
     * Deliberately no `captureType` clause. Restricting to AREA_OVERVIEW read
     * as a tighter rule and was really a bug: guided capture files its shots as
     * FINDING_CONTEXT, so a two-room inspection with twelve photographs
     * published two of them and the report looked empty.
     */
    expect(query.select.areas.select.photos.where).toEqual(VISIBLE);
  });

  it('scopes shared photo reads to the share inspection and re-applies the visibility rule', async () => {
    const prisma = {
      inspectionReportShare: {
        findUnique: jest.fn().mockResolvedValue({
          inspectionId: 'inspection-1',
          expiresAt: new Date(Date.now() + 86_400_000),
          revokedAt: null,
          // Whoever issued the link; the report names the office before the field.
          createdBy: { displayName: 'Operations Team' },
        }),
      },
      inspectionPhoto: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'photo-1', storageKey: 'key-1', mimeType: 'image/jpeg' }),
      },
    };
    const storage = { get: jest.fn().mockResolvedValue(Buffer.from('jpeg-bytes')) };
    const service = new ReportShareService(prisma as never, undefined, storage as never);

    const photo = await service.publicPhoto('valid-token', 'photo-1');

    expect(photo.mimeType).toBe('image/jpeg');
    expect(prisma.inspectionPhoto.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'photo-1',
          // The share's own inspection, and no other: an inspection link's
          // scope is that one inspection.
          inspectionId: { in: ['inspection-1'] },
          AND: VISIBLE,
        },
      }),
    );
  });

  it('refuses a photo that belongs to another inspection', async () => {
    const prisma = {
      inspectionReportShare: {
        findUnique: jest.fn().mockResolvedValue({
          inspectionId: 'inspection-1',
          expiresAt: new Date(Date.now() + 86_400_000),
          revokedAt: null,
          // Whoever issued the link; the report names the office before the field.
          createdBy: { displayName: 'Operations Team' },
        }),
      },
      // The scoped query matches nothing for a foreign photo id.
      inspectionPhoto: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const storage = { get: jest.fn() };
    const service = new ReportShareService(prisma as never, undefined, storage as never);

    await expect(service.publicPhoto('valid-token', 'foreign-photo')).rejects.toMatchObject({
      status: 404,
      code: 'REPORT_PHOTO_NOT_FOUND',
    });
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('revoking twice is idempotent', async () => {
    const share = {
      id: 'share-1',
      inspectionId: 'inspection-1',
      token: 'token',
      recipientEmail: null,
      expiresAt: new Date(),
      revokedAt: new Date(),
      createdAt: new Date(),
    };
    const prisma = {
      inspectionReportShare: { findFirst: jest.fn().mockResolvedValue(share) },
      $transaction: jest.fn(),
    };
    const service = new ReportShareService(prisma as never);

    await expect(service.revokeShare(admin, 'share-1')).resolves.toMatchObject({
      id: 'share-1',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
