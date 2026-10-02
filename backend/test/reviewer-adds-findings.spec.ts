import 'reflect-metadata';

import { UserRole } from '@texasrenters/shared';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateFindingDto } from '../src/admin/admin.dto';
import { AdminService } from '../src/admin/admin.service';
import type { AuthenticatedUser } from '../src/common/auth';
import { PresenceService } from '../src/realtime/presence.service';

/**
 * A reviewer adds what the AI missed (2026-10-03): a finding at a moment of
 * one of the area's recordings, decided as it is written. People and ids
 * invented.
 */

const user: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-reviewer',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Reviewer',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: ['findings:review'],
  mustChangePassword: false,
  principalType: 'USER',
};

const INPUT = {
  recordingId: 'media-1',
  atSeconds: 95,
  title: 'Cracked outlet cover by the window',
  description: 'The cover plate is split across the middle.',
  severity: 'LOW' as const,
  findingType: 'POSSIBLE_NEW_DAMAGE' as const,
  category: 'Electrical',
  note: '  Visible at 1:35. ',
};

function build(opts: { area?: Record<string, unknown> | null; media?: Record<string, unknown> | null } = {}) {
  const tx = {
    inspectionArea: {
      findFirst: jest.fn().mockResolvedValue(
        opts.area === undefined
          ? {
              id: 'area-1',
              propertyAreaId: 'pa-living',
              propertyArea: { name: 'Living Room' },
              inspection: { finalizedAt: null },
            }
          : opts.area,
      ),
    },
    inspectionMedia: {
      findFirst: jest
        .fn()
        .mockResolvedValue(opts.media === undefined ? { id: 'media-1', durationSeconds: 120 } : opts.media),
    },
    inspectionFinding: {
      create: jest.fn().mockResolvedValue({
        id: 'finding-new',
        inspectionId: 'insp-1',
        reviewStatus: 'APPROVED',
        title: INPUT.title,
      }),
    },
    findingReview: { create: jest.fn().mockResolvedValue({ id: 'review-1' }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: jest.fn((work: (client: unknown) => unknown) => work(tx)) };
  return { service: new AdminService(prisma as never, new PresenceService()), tx };
}

describe('a reviewer adding what the AI missed', () => {
  it('files it on the area at the moment given, as the reviewer’s own, approved', async () => {
    const { service, tx } = build();

    const finding = await service.addFinding(user, 'insp-1', 'area-1', INPUT);

    expect(finding).toMatchObject({ id: 'finding-new', reviewStatus: 'APPROVED' });
    expect(tx.inspectionFinding.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inspectionId: 'insp-1',
        propertyAreaId: 'pa-living',
        inspectionMediaId: 'media-1',
        source: 'REVIEWER',
        title: 'Cracked outlet cover by the window',
        findingType: 'POSSIBLE_NEW_DAMAGE',
        comparisonResult: 'POSSIBLE_NEW_DAMAGE',
        videoTimestampStart: 95,
        videoTimestampEnd: 95,
        // Who pays is decided on the charge, by a person.
        possibleResponsibility: 'UNDETERMINED',
        reviewStatus: 'APPROVED',
      }),
      select: expect.any(Object),
    });
    expect(tx.findingReview.create).toHaveBeenCalledWith({
      data: {
        findingId: 'finding-new',
        reviewerId: user.id,
        status: 'APPROVED',
        reason: 'Visible at 1:35.',
      },
      select: { id: true },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'FINDING_ADDED',
        entityId: 'insp-1',
        metadata: expect.objectContaining({
          findingId: 'finding-new',
          areaName: 'Living Room',
          atSeconds: 95,
        }),
      }),
    });
  });

  it('keeps the moment inside the recording', async () => {
    const { service, tx } = build({ media: { id: 'media-1', durationSeconds: 60 } });

    await service.addFinding(user, 'insp-1', 'area-1', { ...INPUT, atSeconds: 95 });

    expect(tx.inspectionFinding.create.mock.calls[0][0].data).toMatchObject({
      videoTimestampStart: 60,
      videoTimestampEnd: 60,
    });
  });

  it('reads maintenance in the comparison’s terms', async () => {
    const { service, tx } = build();

    await service.addFinding(user, 'insp-1', 'area-1', { ...INPUT, findingType: 'MAINTENANCE' });

    expect(tx.inspectionFinding.create.mock.calls[0][0].data.comparisonResult).toBe('OWNER_MAINTENANCE');
  });

  it('only on a recording of this area, in the reviewer’s organization', async () => {
    const { service, tx } = build({ media: null });

    await expect(service.addFinding(user, 'insp-1', 'area-1', INPUT)).rejects.toMatchObject({
      code: 'INSPECTION_MEDIA_NOT_FOUND',
    });
    expect(tx.inspectionMedia.findFirst).toHaveBeenCalledWith({
      where: { id: 'media-1', inspectionAreaId: 'area-1', organizationId: user.organizationId },
      select: { id: true, durationSeconds: true },
    });
    expect(tx.inspectionFinding.create).not.toHaveBeenCalled();
  });

  it('never on another organization’s area', async () => {
    const missing = build({ area: null });
    await expect(missing.service.addFinding(user, 'insp-1', 'area-1', INPUT)).rejects.toMatchObject({
      code: 'INSPECTION_AREA_NOT_FOUND',
    });
    expect(missing.tx.inspectionArea.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'area-1', inspectionId: 'insp-1', inspection: { organizationId: user.organizationId } },
      }),
    );
  });

  // Reviewing goes on after the visit is closed (2026-10-03): the office adds
  // what the AI missed while preparing the reports, without reopening.
  it('is added after finalization too, and the audit says it was', async () => {
    const finalized = build({
      area: {
        id: 'area-1',
        propertyAreaId: 'pa-living',
        propertyArea: { name: 'Living Room' },
        inspection: { finalizedAt: new Date('2026-10-02T16:45:36Z') },
      },
    });

    await finalized.service.addFinding(user, 'insp-1', 'area-1', INPUT);

    expect(finalized.tx.inspectionFinding.create).toHaveBeenCalled();
    expect(finalized.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'FINDING_ADDED',
        metadata: expect.objectContaining({ afterFinalization: true }),
      }),
    });
  });

  it('takes only the severities and types an AI finding may have', async () => {
    const body = { ...INPUT, recordingId: '30000000-0000-4000-8000-000000000001' };
    const errors = await validate(
      plainToInstance(CreateFindingDto, { ...body, severity: 'CRITICAL', findingType: 'CHARGE' }),
    );
    expect(errors.map((error) => error.property).sort()).toEqual(['findingType', 'severity']);
    expect(await validate(plainToInstance(CreateFindingDto, { ...body, atSeconds: undefined }))).toHaveLength(0);
    expect(
      (await validate(plainToInstance(CreateFindingDto, { ...body, recordingId: 'not-an-id' }))).map(
        (error) => error.property,
      ),
    ).toEqual(['recordingId']);
  });
});
