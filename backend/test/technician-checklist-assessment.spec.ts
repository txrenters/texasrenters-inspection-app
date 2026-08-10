import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { ChecklistAssessmentDto } from '../src/technician/technician.dto';
import { TechnicianService } from '../src/technician/technician.service';

const technician: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000004',
  authUserId: 'auth-technician',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Field Technician',
  roles: [UserRole.INSPECTION_TECHNICIAN],
  permissions: [],
  mustChangePassword: false,
};

const ROOM_ID = '20000000-0000-4000-8000-000000000001';
const INSPECTION_ID = '20000000-0000-4000-8000-000000000002';
const PROPERTY_AREA_ID = '20000000-0000-4000-8000-000000000003';
const ITEM_ID = '20000000-0000-4000-8000-000000000004';

function build({
  room = { id: ROOM_ID, inspectionId: INSPECTION_ID, propertyAreaId: PROPERTY_AREA_ID },
  item = { id: ITEM_ID } as { id: string } | null,
  inspection = { status: 'IN_PROGRESS', finalizedAt: null } as Record<string, unknown> | null,
} = {}) {
  const prisma = {
    inspectionArea: { findFirst: jest.fn().mockResolvedValue(room) },
    inspection: { findUnique: jest.fn().mockResolvedValue(inspection) },
    areaChecklistItem: { findFirst: jest.fn().mockResolvedValue(item) },
    inspectionAreaChecklistResponse: {
      upsert: jest.fn().mockImplementation(({ create, update }) => {
        const values = update ?? create;
        return Promise.resolve({
          checklistItemId: ITEM_ID,
          isClean: values.isClean ?? null,
          isUndamaged: values.isUndamaged ?? null,
          isWorking: values.isWorking ?? null,
          comment: values.comment ?? null,
          recordedAt: new Date('2026-08-11T09:00:00.000Z'),
        });
      }),
    },
  };
  const service = new TechnicianService(
    prisma as never,
    {} as never,
    {} as never,
    { queue: jest.fn(), advanceInspection: jest.fn().mockResolvedValue(undefined) } as never,
  );
  return { prisma, service };
}

describe('technician checklist assessment', () => {
  it('records the three axes and a comment', async () => {
    const { prisma, service } = build();

    const result = await service.recordRoomChecklistItem(technician, ROOM_ID, ITEM_ID, {
      isClean: false,
      isUndamaged: false,
      isWorking: true,
      comment: '  scratches on door need to be painted  ',
    });

    expect(result).toMatchObject({ isClean: false, isUndamaged: false, isWorking: true });
    const [[args]] = prisma.inspectionAreaChecklistResponse.upsert.mock.calls;
    expect(args.create).toMatchObject({
      organizationId: technician.organizationId,
      inspectionAreaId: ROOM_ID,
      checklistItemId: ITEM_ID,
      recordedById: technician.id,
      // Trimmed, so a stray space does not become a comment the report prints.
      comment: 'scratches on door need to be painted',
    });
  });

  /**
   * The distinction the printed report depends on. Its rows are routinely
   * blank, and a blank means nobody assessed that axis — storing `false` would
   * publish a defect the technician never observed.
   */
  it('keeps an unanswered axis null rather than defaulting it to false', async () => {
    const { prisma, service } = build();

    await service.recordRoomChecklistItem(technician, ROOM_ID, ITEM_ID, { isClean: true });

    const [[args]] = prisma.inspectionAreaChecklistResponse.upsert.mock.calls;
    expect(args.create).toMatchObject({ isClean: true, isUndamaged: null, isWorking: null });
  });

  it('treats an empty comment as no comment', async () => {
    const { prisma, service } = build();

    await service.recordRoomChecklistItem(technician, ROOM_ID, ITEM_ID, {
      isClean: true,
      comment: '   ',
    });

    const [[args]] = prisma.inspectionAreaChecklistResponse.upsert.mock.calls;
    expect(args.create.comment).toBeNull();
  });

  it('upserts, so re-scoring corrects the record instead of stacking opinions', async () => {
    const { prisma, service } = build();

    await service.recordRoomChecklistItem(technician, ROOM_ID, ITEM_ID, { isWorking: false });

    const [[args]] = prisma.inspectionAreaChecklistResponse.upsert.mock.calls;
    expect(args.where).toEqual({
      inspectionAreaId_checklistItemId: { inspectionAreaId: ROOM_ID, checklistItemId: ITEM_ID },
    });
    expect(args.update).toMatchObject({ isWorking: false, recordedById: technician.id });
  });

  it('refuses an item belonging to another area', async () => {
    // Without this a technician could score an item from another property and
    // the report would print an assessment against a room nobody inspected.
    const { prisma, service } = build({ item: null });

    await expect(
      service.recordRoomChecklistItem(technician, ROOM_ID, ITEM_ID, { isClean: true }),
    ).rejects.toMatchObject({ status: 404, code: 'CHECKLIST_ITEM_NOT_FOUND' });
    expect(prisma.inspectionAreaChecklistResponse.upsert).not.toHaveBeenCalled();

    const [[lookup]] = prisma.areaChecklistItem.findFirst.mock.calls;
    expect(lookup.where).toMatchObject({
      id: ITEM_ID,
      propertyAreaId: PROPERTY_AREA_ID,
      archivedAt: null,
    });
  });

  it('refuses after the inspection is finalized, even once reopened', async () => {
    // `finalizedAt`, not status alone — the same rule that governs photo
    // deletion. A reopen must not reopen the assessments behind a report that
    // has already been closed and possibly shared.
    const { prisma, service } = build({
      inspection: { status: 'IN_PROGRESS', finalizedAt: new Date('2026-08-10T00:00:00.000Z') },
    });

    await expect(
      service.recordRoomChecklistItem(technician, ROOM_ID, ITEM_ID, { isClean: true }),
    ).rejects.toMatchObject({ status: 409, code: 'INSPECTION_FINALIZED' });
    expect(prisma.inspectionAreaChecklistResponse.upsert).not.toHaveBeenCalled();
  });

  it('scopes to the caller through the assigned-room guard', async () => {
    const { prisma, service } = build({ room: null as never });

    await expect(
      service.recordRoomChecklistItem(technician, ROOM_ID, ITEM_ID, { isClean: true }),
    ).rejects.toMatchObject({ status: 404, code: 'ASSIGNED_ROOM_NOT_FOUND' });

    const [[guard]] = prisma.inspectionArea.findFirst.mock.calls;
    expect(guard.where.inspection).toMatchObject({
      organizationId: technician.organizationId,
      assignments: { some: { technicianId: technician.id, isCurrent: true } },
    });
  });

  describe('payload contract', () => {
    it('accepts a partial assessment', async () => {
      const dto = plainToInstance(ChecklistAssessmentDto, { isClean: true });
      expect(await validate(dto)).toHaveLength(0);
    });

    it('accepts null as an explicit "unassessed"', async () => {
      const dto = plainToInstance(ChecklistAssessmentDto, { isClean: null, isWorking: null });
      expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects a non-boolean axis rather than coercing it', async () => {
      // "false" as a string is truthy, and a form round trip is exactly where
      // that arrives. Coercion here would record a defect nobody reported.
      const dto = plainToInstance(ChecklistAssessmentDto, { isClean: 'false' });
      const errors = await validate(dto);
      expect(errors.map((error) => error.property)).toContain('isClean');
    });
  });
});
