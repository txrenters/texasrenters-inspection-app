import 'reflect-metadata';

import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { TechnicianService } from '../src/technician/technician.service';

/**
 * An answer given offline names the checklist item by its label.
 *
 * The handset falls back to a generated checklist for an area whose real one it
 * has never fetched — a technician who reaches a property with no signal and
 * opens a room for the first time — and that fallback uses the label as the id
 * on purpose, so a locally ticked item keeps its meaning if the real items
 * arrive mid-walkthrough.
 *
 * Answering one sent `PUT .../checklist/Room%20condition`. Nothing could match
 * it: `id` is a uuid column, so the lookup did not merely miss, it failed. And
 * the write is queued when the network is gone, so the answer was held on the
 * device and rejected on every replay until it ran out of attempts.
 */

const technician: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000004',
  authUserId: 'auth-technician',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Field Technician',
  roles: [UserRole.INSPECTION_TECHNICIAN],
  permissions: [],
  mustChangePassword: false,
  principalType: 'USER',
};

const ROOM_ID = '20000000-0000-4000-8000-000000000001';
const INSPECTION_ID = '20000000-0000-4000-8000-000000000002';
const PROPERTY_AREA_ID = '20000000-0000-4000-8000-000000000003';
const ITEM_ID = '20000000-0000-4000-8000-000000000004';

function build(inspectionType = 'OCCUPIED') {
  const prisma = {
    inspectionArea: {
      findFirst: jest.fn().mockResolvedValue({
        id: ROOM_ID,
        inspectionId: INSPECTION_ID,
        propertyAreaId: PROPERTY_AREA_ID,
        inspection: { inspectionType },
      }),
    },
    inspection: {
      findUnique: jest.fn().mockResolvedValue({ status: 'IN_PROGRESS', finalizedAt: null }),
    },
    areaChecklistItem: {
      findFirst: jest.fn().mockResolvedValue({
        id: ITEM_ID,
        responseType: 'CHOICE',
        choices: ['Clean', 'Acceptable', 'Damaged', 'Needs attention'],
      }),
    },
    inspectionAreaChecklistResponse: {
      upsert: jest.fn().mockImplementation(({ create, update }) =>
        Promise.resolve({
          checklistItemId: ITEM_ID,
          isClean: null,
          isUndamaged: null,
          isWorking: null,
          comment: null,
          numericValue: null,
          textValue: (update ?? create).textValue ?? null,
          recordedAt: new Date('2026-09-10T09:00:00.000Z'),
        }),
      ),
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

describe('answering a checklist item the handset only knows by label', () => {
  it('resolves an organization-wide occupied question by its label', async () => {
    const { prisma, service } = build();
    await service.recordRoomChecklistItem(technician, ROOM_ID, 'Room condition', {
      textValue: 'Clean',
    });
    const where = prisma.areaChecklistItem.findFirst.mock.calls[0][0].where;
    expect(where.label).toBe('Room condition');
    expect(where.kind).toBe('OCCUPIED');
    // Never as an id: `id` is a uuid column, so a label reaching it is a
    // database error rather than a lookup that returns nothing.
    expect(where.id).toBeUndefined();
    // Organization-wide, which is where the occupied pair actually lives.
    expect(where.propertyAreaId).toBeNull();
    expect(where.organizationId).toBe(technician.organizationId);
  });

  /**
   * The kind is part of the match, so a label shared between an occupied
   * question and a per-area room item cannot cross over.
   */
  it('scopes a room item by label to the area, not the organization', async () => {
    const { prisma, service } = build('MOVE_IN');
    await service.recordRoomChecklistItem(technician, ROOM_ID, 'Walls and ceilings', {
      isClean: true,
    });
    const where = prisma.areaChecklistItem.findFirst.mock.calls[0][0].where;
    expect(where.label).toBe('Walls and ceilings');
    expect(where.kind).toBe('ROOM');
    expect(where.propertyAreaId).toBe(PROPERTY_AREA_ID);
  });

  it('still matches by id when the handset has the real list', async () => {
    const { prisma, service } = build();
    await service.recordRoomChecklistItem(technician, ROOM_ID, ITEM_ID, { textValue: 'Clean' });
    const where = prisma.areaChecklistItem.findFirst.mock.calls[0][0].where;
    expect(where.id).toBe(ITEM_ID);
    expect(where.label).toBeUndefined();
    expect(where.kind).toBeUndefined();
  });

  /**
   * The answer has to land on the row the id would have reached, or the report
   * shows the same question answered twice — once by label, once by id.
   */
  it('writes the response against the resolved row, not the label', async () => {
    const { prisma, service } = build();
    await service.recordRoomChecklistItem(technician, ROOM_ID, 'Room condition', {
      textValue: 'Damaged',
    });
    const call = prisma.inspectionAreaChecklistResponse.upsert.mock.calls[0][0];
    expect(call.where.inspectionAreaId_checklistItemId.checklistItemId).toBe(ITEM_ID);
    expect(call.create.checklistItemId).toBe(ITEM_ID);
  });

  it('still validates the answer against the resolved item’s choices', async () => {
    const { service } = build();
    await expect(
      service.recordRoomChecklistItem(technician, ROOM_ID, 'Room condition', {
        textValue: 'Immaculate',
      }),
    ).rejects.toMatchObject({ code: 'CHECKLIST_CHOICE_INVALID' });
  });

  it('refuses a label that matches nothing', async () => {
    const { prisma, service } = build();
    prisma.areaChecklistItem.findFirst.mockResolvedValue(null);
    await expect(
      service.recordRoomChecklistItem(technician, ROOM_ID, 'Not a question', { isClean: true }),
    ).rejects.toMatchObject({ code: 'CHECKLIST_ITEM_NOT_FOUND' });
  });

  /**
   * A lockbox visit has no checklist at all, so there is no label to resolve —
   * and NONE is not a member of the stored enum, so it must never reach a query.
   */
  it('does not query for a label on a visit that has no checklist', async () => {
    const { prisma, service } = build('SUPRA_LOCKBOX_PLACEMENT');
    await expect(
      service.recordRoomChecklistItem(technician, ROOM_ID, 'Room condition', { isClean: true }),
    ).rejects.toMatchObject({ code: 'CHECKLIST_ITEM_NOT_FOUND' });
    expect(prisma.areaChecklistItem.findFirst).not.toHaveBeenCalled();
  });
});
