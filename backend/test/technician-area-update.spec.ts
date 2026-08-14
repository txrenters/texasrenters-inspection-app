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

const ROOM = '20000000-0000-4000-8000-000000000001';
const INSPECTION = '20000000-0000-4000-8000-000000000002';
const PROPERTY_AREA = '20000000-0000-4000-8000-000000000003';

function roomRecord() {
  return {
    id: ROOM,
    inspectionId: INSPECTION,
    propertyAreaId: PROPERTY_AREA,
    completionStatus: 'PENDING',
    skipReason: null,
    technicianNote: null,
    summaryConfirmedAt: null,
    inspection: { inspectionType: 'OCCUPIED', baselineInspectionId: null },
    propertyArea: {
      name: 'Hal',
      inspectionOrder: 1,
      isRequired: true,
      environment: 'INDOOR',
      category: 'INDOOR_ROOM',
      source: 'TECHNICIAN',
      status: 'APPROVED',
      floor: { name: 'Ground' },
      baselineConditions: [],
    },
    media: [],
  };
}

function build({
  ownArea = { id: PROPERTY_AREA } as { id: string } | null,
  inspection = { status: 'IN_PROGRESS', finalizedAt: null } as Record<string, unknown> | null,
} = {}) {
  const prisma = {
    inspectionArea: { findFirst: jest.fn().mockResolvedValue(roomRecord()) },
    inspection: { findUnique: jest.fn().mockResolvedValue(inspection) },
    propertyArea: {
      findFirst: jest.fn().mockResolvedValue(ownArea),
      update: jest.fn().mockResolvedValue({}),
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

describe('technician correcting an area they added', () => {
  it('renames it and records who did', async () => {
    const { prisma, service } = build();

    await service.updateArea(technician, ROOM, { name: '  Hall  ' });

    const [[args]] = prisma.propertyArea.update.mock.calls;
    expect(args).toMatchObject({ where: { id: PROPERTY_AREA }, data: { name: 'Hall' } });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'TECHNICIAN_AREA_UPDATED',
        actorUserId: technician.id,
        entityId: PROPERTY_AREA,
      }),
    });
  });

  /**
   * The boundary. An area that came from a floor plan is the office's catalog
   * record and is reused by every future inspection of that property, so
   * renaming one from the field would silently change work nobody in this
   * inspection is responsible for.
   */
  it("refuses an area the technician did not add", async () => {
    const { prisma, service } = build({ ownArea: null });

    await expect(service.updateArea(technician, ROOM, { name: 'Hall' })).rejects.toMatchObject({
      status: 403,
      code: 'AREA_NOT_EDITABLE',
    });
    expect(prisma.propertyArea.update).not.toHaveBeenCalled();

    // Scoped by both source and author, not one or the other: another
    // technician's area is no more theirs to rename than the office's.
    const [[lookup]] = prisma.propertyArea.findFirst.mock.calls;
    expect(lookup.where).toMatchObject({
      id: PROPERTY_AREA,
      source: 'TECHNICIAN',
      createdById: technician.id,
    });
  });

  it('leaves untouched fields alone', async () => {
    // A correction sends what changed. Sending only the name must not blank the
    // environment, the category or the notes.
    const { prisma, service } = build();

    await service.updateArea(technician, ROOM, { name: 'Hall' });

    const [[args]] = prisma.propertyArea.update.mock.calls;
    expect(Object.keys(args.data)).toEqual(['name']);
  });

  it('clears a category when one is explicitly nulled', async () => {
    const { prisma, service } = build();

    await service.updateArea(technician, ROOM, { category: null });

    const [[args]] = prisma.propertyArea.update.mock.calls;
    expect(args.data).toEqual({ category: null });
  });

  it('refuses after the inspection is finalized, even once reopened', async () => {
    // `finalizedAt`, not status alone — the same rule that governs photo
    // deletion. A reopen must not reopen the naming of areas behind a report
    // already closed and possibly shared.
    const { prisma, service } = build({
      inspection: { status: 'IN_PROGRESS', finalizedAt: new Date('2026-08-13T00:00:00.000Z') },
    });

    await expect(service.updateArea(technician, ROOM, { name: 'Hall' })).rejects.toMatchObject({
      status: 409,
      code: 'INSPECTION_FINALIZED',
    });
    expect(prisma.propertyArea.update).not.toHaveBeenCalled();
  });

  it('scopes to the caller through the assigned-room guard', async () => {
    const { prisma, service } = build();
    prisma.inspectionArea.findFirst.mockResolvedValue(null);

    await expect(service.updateArea(technician, ROOM, { name: 'Hall' })).rejects.toMatchObject({
      status: 404,
      code: 'ASSIGNED_ROOM_NOT_FOUND',
    });
  });
});
