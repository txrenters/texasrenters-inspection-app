import 'reflect-metadata';

import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
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

/** The shape `technicianRoomSelect` produces, trimmed to what mapRoom reads. */
function roomRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: ROOM_ID,
    inspectionId: INSPECTION_ID,
    propertyAreaId: PROPERTY_AREA_ID,
    completionStatus: 'COMPLETED',
    skipReason: null,
    technicianNote: null,
    summaryConfirmedAt: null,
    inspection: { inspectionType: 'OCCUPIED', baselineInspectionId: null },
    propertyArea: {
      name: 'Library',
      inspectionOrder: 1,
      isRequired: true,
      environment: 'INDOOR',
      category: 'INDOOR_ROOM',
      source: 'AI_FLOOR_PLAN',
      status: 'APPROVED',
      floor: { name: 'Ground' },
      baselineConditions: [],
    },
    media: [],
    ...overrides,
  };
}

function build({
  room = roomRecord(),
  summary = { id: '30000000-0000-4000-8000-000000000001' } as { id: string } | null,
}: {
  room?: ReturnType<typeof roomRecord> | null;
  summary?: { id: string } | null;
} = {}) {
  const prisma = {
    inspectionArea: {
      findFirst: jest.fn().mockResolvedValue(room),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(roomRecord({ summaryConfirmedAt: data.summaryConfirmedAt })),
      ),
    },
    inspectionFinding: {
      findFirst: jest.fn().mockResolvedValue(summary),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const service = new TechnicianService(
    prisma as never,
    {} as never,
    {} as never,
    { queue: jest.fn(), advanceInspection: jest.fn().mockResolvedValue(undefined) } as never,
  );
  return { prisma, service };
}

describe('technician AI summary confirmation', () => {
  it('records the confirmation and who made it', async () => {
    const { prisma, service } = build();

    const room = await service.confirmRoomSummary(technician, ROOM_ID);

    expect(prisma.inspectionArea.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ROOM_ID },
        data: expect.objectContaining({
          summaryConfirmedAt: expect.any(Date),
          summaryConfirmedById: technician.id,
        }),
      }),
    );
    expect(room.summaryConfirmedAt).toEqual(expect.any(String));
  });

  it('never touches a finding, so a technician cannot review one through this route', async () => {
    // The boundary this endpoint exists inside: approving, rejecting or editing
    // an AI finding is an administrator decision. A technician confirming that
    // a narrative matches the room must not move any finding's review status,
    // and the only structural guarantee of that is that this path never writes
    // to the finding table at all.
    const { prisma, service } = build();

    await service.confirmRoomSummary(technician, ROOM_ID);

    expect(prisma.inspectionFinding.update).not.toHaveBeenCalled();
    expect(prisma.inspectionFinding.updateMany).not.toHaveBeenCalled();
    const [[updateArgs]] = prisma.inspectionArea.update.mock.calls;
    expect(Object.keys(updateArgs.data)).toEqual(['summaryConfirmedAt', 'summaryConfirmedById']);
  });

  it('writes an audit row naming the actor and the summary confirmed', async () => {
    const { prisma, service } = build();

    await service.confirmRoomSummary(technician, ROOM_ID);

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: technician.organizationId,
        actorUserId: technician.id,
        action: 'TECHNICIAN_SUMMARY_CONFIRMED',
        entityType: 'InspectionArea',
        entityId: ROOM_ID,
      }),
    });
  });

  it('refuses when no summary exists yet', async () => {
    // Confirming nothing is not a statement about anything, and a confirmation
    // stored before the summary would later read as though a human had vouched
    // for text they never saw.
    const { prisma, service } = build({ summary: null });

    await expect(service.confirmRoomSummary(technician, ROOM_ID)).rejects.toMatchObject({
      status: 409,
      code: 'ROOM_SUMMARY_NOT_READY',
    });
    expect(prisma.inspectionArea.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('keeps the first timestamp when confirmed twice', async () => {
    // The record has to keep saying when the technician actually read it. A
    // queued offline write replays, so this is a real path, not a defensive
    // hypothetical.
    const alreadyConfirmed = new Date('2026-08-10T16:17:21.000Z');
    const { prisma, service } = build({
      room: roomRecord({ summaryConfirmedAt: alreadyConfirmed }),
    });

    const room = await service.confirmRoomSummary(technician, ROOM_ID);

    expect(prisma.inspectionArea.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(room.summaryConfirmedAt).toBe(alreadyConfirmed.toISOString());
  });

  it('scopes to the caller through the assigned-room guard', async () => {
    // findFirst returning nothing is how the guard reports both "no such area"
    // and "not yours" — the service must not fall through to a write.
    const { prisma, service } = build({ room: null });

    await expect(service.confirmRoomSummary(technician, ROOM_ID)).rejects.toMatchObject({
      status: 404,
      code: 'ASSIGNED_ROOM_NOT_FOUND',
    });
    expect(prisma.inspectionArea.update).not.toHaveBeenCalled();

    const [[guardArgs]] = prisma.inspectionArea.findFirst.mock.calls;
    expect(guardArgs.where.inspection).toMatchObject({
      organizationId: technician.organizationId,
      assignments: { some: { technicianId: technician.id, isCurrent: true } },
    });
  });

  it('looks the summary up within the caller-scoped area, not by room id alone', async () => {
    const { prisma, service } = build();

    await service.confirmRoomSummary(technician, ROOM_ID);

    const [[findingArgs]] = prisma.inspectionFinding.findFirst.mock.calls;
    expect(findingArgs.where).toMatchObject({
      inspectionId: INSPECTION_ID,
      propertyAreaId: PROPERTY_AREA_ID,
    });
  });
});
