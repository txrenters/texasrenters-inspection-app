import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { FloorPlanAdminService } from '../src/admin/floor-plan-admin.service';

const admin: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Property Admin',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: [],
  mustChangePassword: false,
};

function buildService() {
  const prisma = {
    propertyArea: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'area-1',
        propertyId: 'bld-1',
        unitId: null,
        name: 'Backyard',
        status: 'DRAFT',
        floor: { id: 'floor-1', name: 'Added areas', sortOrder: 1 },
      }),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'area-1',
          propertyId: 'bld-1',
          status: (data.status as string) ?? 'DRAFT',
          archivedAt: (data.archivedAt as Date) ?? null,
        }),
      ),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const service = new FloorPlanAdminService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, prisma };
}

describe('admin area reject/archive (evidence preserved)', () => {
  it('rejects a pending area without touching its media', async () => {
    const { service, prisma } = buildService();
    const result = await service.rejectArea(admin, 'area-1', 'Duplicate of kitchen');
    expect(prisma.propertyArea.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'area-1' }, data: { status: 'REJECTED' } }),
    );
    // No delete of InspectionArea / media occurs.
    expect((result as { status: string }).status).toBe('REJECTED');
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'PROPERTY_AREA_REJECTED' }),
      }),
    );
  });

  it('archives an area by stamping archivedAt (soft, reversible)', async () => {
    const { service, prisma } = buildService();
    await service.archiveArea(admin, 'area-1');
    const call = prisma.propertyArea.update.mock.calls[0][0] as { data: { archivedAt: Date } };
    expect(call.data.archivedAt).toBeInstanceOf(Date);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'PROPERTY_AREA_ARCHIVED' }),
      }),
    );
  });
});
