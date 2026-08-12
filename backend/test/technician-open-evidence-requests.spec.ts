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

function build(rows: unknown[] = []) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const service = new TechnicianService(
    { areaEvidenceRequest: { findMany } } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { findMany, service };
}

/** A row shaped like the select in `openEvidenceRequests`. */
function request(overrides: Record<string, unknown> = {}) {
  return {
    id: 'request-1',
    inspectionId: 'inspection-1',
    inspectionAreaId: 'area-1',
    note: 'The dishwasher was never opened.',
    requestedAt: new Date('2026-08-12T09:00:00.000Z'),
    inspectionArea: { propertyArea: { name: 'Kitchen' } },
    inspection: {
      propertywareBuilding: { name: '17307 Nordway Dr' },
      propertywareUnit: { name: 'Unit B' },
    },
    ...overrides,
  };
}

describe('open evidence requests', () => {
  it('asks only for this technician’s current assignments', async () => {
    const { findMany, service } = build();

    await service.openEvidenceRequests(technician);

    const where = findMany.mock.calls[0][0].where;
    // `isCurrent` is the load-bearing part: without it a reassigned inspection
    // keeps notifying the technician who no longer has it, and they drive to a
    // property that is not theirs.
    expect(where.inspection.assignments.some).toEqual({
      technicianId: technician.id,
      isCurrent: true,
    });
  });

  it('excludes requests against work that is already closed', async () => {
    const { findMany, service } = build();

    await service.openEvidenceRequests(technician);

    const where = findMany.mock.calls[0][0].where;
    expect(where.status).toBe('OPEN');
    // A request on a completed or cancelled inspection is not something to send
    // anyone back for, and it would sit on the badge for ever.
    expect(where.inspection.status.notIn).toEqual(
      expect.arrayContaining(['COMPLETED', 'CANCELLED']),
    );
  });

  it('answers oldest first', async () => {
    const { findMany, service } = build();

    await service.openEvidenceRequests(technician);

    // The one that has been waiting longest is the one to do.
    expect(findMany.mock.calls[0][0].orderBy).toEqual({ requestedAt: 'asc' });
  });

  it('names the property, because this is read outside any one inspection', async () => {
    const { service } = build([request()]);

    const [first] = await service.openEvidenceRequests(technician);

    // An area name alone does not tell a technician which building to drive to.
    expect(first).toMatchObject({
      roomName: 'Kitchen',
      propertyName: '17307 Nordway Dr',
      unitName: 'Unit B',
      inspectionId: 'inspection-1',
      roomId: 'area-1',
    });
    expect(first!.requestedAt).toBe('2026-08-12T09:00:00.000Z');
  });

  it('survives a property or unit the join did not resolve', async () => {
    const { service } = build([
      request({ inspection: { propertywareBuilding: null, propertywareUnit: null } }),
    ]);

    const [first] = await service.openEvidenceRequests(technician);

    // A missing name must not blank the row: the request still has to be
    // actionable, and the area name is the part that locates the work.
    expect(first).toMatchObject({ propertyName: 'Property', unitName: null });
  });
});
