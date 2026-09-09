import 'reflect-metadata';

import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { TechnicianService } from '../src/technician/technician.service';

/**
 * A technician can take a room off an inspection that does not have it.
 *
 * The symmetric half of `createArea`, which approves a technician-added area on
 * sight because somebody standing in a room is better evidence of the layout
 * than a plan read in an office. The same holds for a room that is not there:
 * the standard template offers Bedroom 3 to every property, and on a
 * two-bedroom house that is a room the technician would otherwise skip on every
 * visit for ever.
 *
 * The guards are the whole of this feature. Removal that could destroy evidence
 * is worse than no removal at all.
 */

const technician: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000004',
  authUserId: 'auth-tech',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Field Technician',
  roles: [UserRole.INSPECTION_TECHNICIAN],
  permissions: [],
  mustChangePassword: false,
  principalType: 'USER',
};

const ROOM_ID = '20000000-0000-4000-8000-000000000001';
const AREA_ID = '20000000-0000-4000-8000-000000000003';

function build({
  inspection = { status: 'IN_PROGRESS', finalizedAt: null, inspectionType: 'OCCUPIED' },
  recordings = 0,
  photographs = 0,
  findings = 0,
  answers = 0,
  remaining = 0,
} = {}) {
  const tx = {
    inspectionAreaStatusHistory: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    mediaUploadSession: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    inspectionArea: {
      delete: jest.fn().mockResolvedValue({ id: ROOM_ID }),
      count: jest.fn().mockResolvedValue(remaining),
    },
    propertyArea: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    inspectionArea: {
      findFirst: jest.fn().mockResolvedValue({
        id: ROOM_ID,
        inspectionId: 'inspection-1',
        propertyAreaId: AREA_ID,
        propertyArea: { name: 'Bedroom 3' },
        media: [],
      }),
    },
    inspection: { findUnique: jest.fn().mockResolvedValue(inspection) },
    inspectionMedia: { count: jest.fn().mockResolvedValue(recordings) },
    inspectionPhoto: { count: jest.fn().mockResolvedValue(photographs) },
    inspectionFinding: { count: jest.fn().mockResolvedValue(findings) },
    inspectionAreaChecklistResponse: { count: jest.fn().mockResolvedValue(answers) },
    $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
  };
  const service = new TechnicianService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
  ) as unknown as {
    removeArea: (user: AuthenticatedUser, roomId: string) => Promise<{ name: string }>;
  };
  return { service, tx, prisma };
}

describe('removing an area a property does not have', () => {
  it('deletes it and says which room went', async () => {
    const { service, tx } = build();
    await expect(service.removeArea(technician, ROOM_ID)).resolves.toMatchObject({
      removed: true,
      name: 'Bedroom 3',
    });
    expect(tx.inspectionArea.delete).toHaveBeenCalledWith({ where: { id: ROOM_ID } });
  });

  it('clears the children that restrict before deleting the area', async () => {
    // Status history and upload sessions restrict rather than cascade, so the
    // delete fails inside the transaction without this — taking the whole
    // removal with it. The report import clears them in the same order.
    const { service, tx } = build();
    await service.removeArea(technician, ROOM_ID);
    expect(tx.inspectionAreaStatusHistory.deleteMany).toHaveBeenCalled();
    expect(tx.mediaUploadSession.deleteMany).toHaveBeenCalled();
    expect(tx.inspectionAreaStatusHistory.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.inspectionArea.delete.mock.invocationCallOrder[0],
    );
  });

  it('writes an audit row naming the room', async () => {
    const { service, tx } = build();
    await service.removeArea(technician, ROOM_ID);
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'TECHNICIAN_AREA_REMOVED',
      actorUserId: technician.id,
      metadata: expect.objectContaining({ name: 'Bedroom 3' }),
    });
  });

  it('flags a move-out removal as changing the comparison', async () => {
    // A move-out is compared to its move-in area by area, and an area missing
    // from one end drops out silently. Allowed — the technician can see the
    // room — but the record has to say so.
    const { service, tx } = build({
      inspection: { status: 'IN_PROGRESS', finalizedAt: null, inspectionType: 'MOVE_OUT' },
    });
    await service.removeArea(technician, ROOM_ID);
    expect(tx.auditLog.create.mock.calls[0][0].data.metadata.comparisonAffected).toBe(true);
    expect(tx.inspectionArea.delete).toHaveBeenCalled();
  });
});

describe('what removal refuses to touch', () => {
  it.each([
    ['a recording', { recordings: 1 }],
    ['a photograph', { photographs: 1 }],
    ['a finding', { findings: 1 }],
    ['a scored checklist item', { answers: 1 }],
  ])('refuses an area holding %s', async (_label, counts) => {
    /**
     * The guard this feature lives or dies by. Removing an area with evidence
     * destroys somebody's work — often the technician's own — and skipping
     * already exists for "this room cannot be inspected". The two must not be
     * reachable from the same mistake.
     */
    const { service, tx } = build(counts);
    await expect(service.removeArea(technician, ROOM_ID)).rejects.toMatchObject({
      status: 409,
      code: 'AREA_HAS_EVIDENCE',
    });
    expect(tx.inspectionArea.delete).not.toHaveBeenCalled();
  });

  it('counts findings by property area, not by inspection area', async () => {
    // `InspectionFinding` has no link to the inspection *area*; it points at
    // the property area and the inspection separately. Counting the wrong one
    // reports zero for a room full of findings and deletes it.
    const { service, prisma } = build();
    await service.removeArea(technician, ROOM_ID);
    expect(prisma.inspectionFinding.count).toHaveBeenCalledWith({
      where: { inspectionId: 'inspection-1', propertyAreaId: AREA_ID },
    });
  });

  it.each([
    ['a finalized inspection', { status: 'IN_PROGRESS', finalizedAt: new Date() }],
    ['a completed one', { status: 'COMPLETED', finalizedAt: null }],
    ['a cancelled one', { status: 'CANCELLED', finalizedAt: null }],
  ])('refuses %s', async (_label, state) => {
    const { service, tx } = build({
      inspection: { ...state, inspectionType: 'OCCUPIED' } as never,
    });
    await expect(service.removeArea(technician, ROOM_ID)).rejects.toMatchObject({
      status: 409,
      code: 'INSPECTION_FINALIZED',
    });
    expect(tx.inspectionArea.delete).not.toHaveBeenCalled();
  });
});

describe('what happens to the property layout', () => {
  it('archives a standard-template guess once nothing points at it', async () => {
    // Otherwise the same invented room returns on the next visit and the
    // technician removes it again, for ever.
    const { service, tx } = build({ remaining: 0 });
    await service.removeArea(technician, ROOM_ID);
    const call = tx.propertyArea.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: AREA_ID, source: 'STANDARD_TEMPLATE' });
    expect(call.data.archivedAt).toBeInstanceOf(Date);
  });

  it('leaves the layout alone while another inspection still holds it', async () => {
    // `AREA_IN_USE` exists to stop a layout being pulled out from under a visit
    // somebody else is walking.
    const { service, tx } = build({ remaining: 2 });
    await service.removeArea(technician, ROOM_ID);
    expect(tx.propertyArea.updateMany).not.toHaveBeenCalled();
  });

  it('never archives a surveyed layout, only the template', async () => {
    // Scoped by `source` in the where clause: an imported or extracted layout
    // is somebody's record, and the office keeps the last word on the plan.
    const { service, tx } = build({ remaining: 0 });
    await service.removeArea(technician, ROOM_ID);
    expect(tx.propertyArea.updateMany.mock.calls[0][0].where.source).toBe('STANDARD_TEMPLATE');
  });
});
