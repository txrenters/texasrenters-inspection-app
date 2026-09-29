import { InspectionAreaCompletionStatus, InspectionStatus } from '@prisma/client';
import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { ApplicationError } from '../src/common/errors';
import { TechnicianService } from '../src/technician/technician.service';

/**
 * Change Evidence on a submitted area (the office, 2026-09-30): the area goes
 * back to work "as if the first time we are doing the inspection", and its old
 * photographs are removed once new ones replace them.
 */

const technician: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000004',
  authUserId: 'auth-technician',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Moses',
  roles: [UserRole.INSPECTION_TECHNICIAN],
  permissions: [],
  mustChangePassword: false,
  principalType: 'USER',
};

const ROOM_ID = '20000000-0000-4000-8000-000000000001';
const INSPECTION_ID = '20000000-0000-4000-8000-000000000002';
const OLD_PHOTO = '30000000-0000-4000-8000-000000000001';

function build({
  completionStatus = InspectionAreaCompletionStatus.COMPLETED as InspectionAreaCompletionStatus,
  inspectionStatus = InspectionStatus.IN_PROGRESS as InspectionStatus,
  finalizedAt = null as Date | null,
  photos = [{ id: OLD_PHOTO, storageKey: 'photos/old.jpg' }],
} = {}) {
  const tx = {
    inspectionPhoto: { deleteMany: jest.fn().mockResolvedValue({ count: photos.length }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    inspectionArea: {
      findFirst: jest.fn().mockResolvedValue({ id: ROOM_ID, inspectionId: INSPECTION_ID, completionStatus }),
      update: jest.fn(({ data }: { data: object }) =>
        Promise.resolve({ id: ROOM_ID, inspectionId: INSPECTION_ID, ...data }),
      ),
    },
    inspection: {
      findUnique: jest.fn().mockResolvedValue({ status: inspectionStatus, finalizedAt }),
    },
    inspectionPhoto: { findMany: jest.fn().mockResolvedValue(photos) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  const storage = { delete: jest.fn().mockResolvedValue(undefined) };
  const service = new TechnicianService(prisma as never, {} as never, storage as never, {} as never) as unknown as {
    reopenRoom: (user: AuthenticatedUser, id: string) => Promise<Record<string, unknown>>;
    replaceRoomEvidence: (
      user: AuthenticatedUser,
      id: string,
      input: { photoKeys?: string[]; photoIds?: string[] },
    ) => Promise<{ deleted: number }>;
    mapRoom: (record: unknown) => unknown;
  };
  // `mapRoom` shapes a full Prisma row these tests have no interest in building.
  service.mapRoom = (record) => record;
  return { service, prisma, tx, storage };
}

describe('Change Evidence reopens a submitted area', () => {
  it('puts it back to work as though it had not been submitted, and audits it', async () => {
    const { service, prisma } = build();

    const room = await service.reopenRoom(technician, ROOM_ID);

    expect(prisma.inspectionArea.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { completionStatus: InspectionAreaCompletionStatus.PENDING, completedAt: null },
      }),
    );
    expect(room.completionStatus).toBe(InspectionAreaCompletionStatus.PENDING);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'TECHNICIAN_AREA_REOPENED' }) }),
    );
  });

  it('answers an area that is not completed as it is, so a replay is harmless', async () => {
    const { service, prisma } = build({ completionStatus: InspectionAreaCompletionStatus.PENDING });

    await service.reopenRoom(technician, ROOM_ID);

    expect(prisma.inspectionArea.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('refuses once the job is submitted: its areas are the office’s then', async () => {
    const { service } = build({ inspectionStatus: InspectionStatus.TECHNICIAN_SUBMITTED });

    await expect(service.reopenRoom(technician, ROOM_ID)).rejects.toBeInstanceOf(ApplicationError);
  });

  it('refuses on a finalized inspection, whatever its status says', async () => {
    const { service } = build({ finalizedAt: new Date('2026-09-29T00:00:00.000Z') });

    await expect(service.reopenRoom(technician, ROOM_ID)).rejects.toBeInstanceOf(ApplicationError);
  });
});

describe('the new evidence replacing the old', () => {
  it('removes the old photographs of this area that the technician took, and audits it', async () => {
    const { service, prisma, tx, storage } = build();

    const result = await service.replaceRoomEvidence(technician, ROOM_ID, {
      photoKeys: ['snapshot-old'],
      photoIds: [OLD_PHOTO],
    });

    expect(result).toEqual({ deleted: 1 });
    expect(prisma.inspectionPhoto.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ inspectionAreaId: ROOM_ID, capturedById: technician.id }),
      }),
    );
    expect(tx.inspectionPhoto.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [OLD_PHOTO] } } });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'TECHNICIAN_AREA_EVIDENCE_REPLACED' }),
      }),
    );
    expect(storage.delete).toHaveBeenCalledWith('photos/old.jpg');
  });

  it('does nothing for photographs already gone, so a replay is harmless', async () => {
    const { service, tx } = build({ photos: [] });

    expect(await service.replaceRoomEvidence(technician, ROOM_ID, { photoIds: [OLD_PHOTO] })).toEqual({ deleted: 0 });
    expect(tx.inspectionPhoto.deleteMany).not.toHaveBeenCalled();
  });

  it('never touches a finalized inspection’s evidence', async () => {
    const { service, tx } = build({ finalizedAt: new Date('2026-09-29T00:00:00.000Z') });

    await expect(service.replaceRoomEvidence(technician, ROOM_ID, { photoIds: [OLD_PHOTO] })).rejects.toBeInstanceOf(
      ApplicationError,
    );
    expect(tx.inspectionPhoto.deleteMany).not.toHaveBeenCalled();
  });
});
