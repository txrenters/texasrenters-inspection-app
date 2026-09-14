import { UserRole } from '@texasrenters/shared';

import { AdminService } from '../src/admin/admin.service';
import type { AuthenticatedUser } from '../src/common/auth';
import { PresenceService } from '../src/realtime/presence.service';

/**
 * The notifications every console account shares.
 *
 * A notification used to reach only the consoles connected when it happened,
 * and lived on in each browser alone, so two accounts in the same office saw
 * different bells.
 */
describe('organization notifications', () => {
  const user = {
    id: 'admin-profile',
    organizationId: 'organization-1',
    roles: [UserRole.SYSTEM_ADMIN],
    permissions: ['inspections:read'],
  } as unknown as AuthenticatedUser;

  it("lists the organization's fifty most recent, newest first", async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'notification-2',
        kind: 'INSPECTION_SUBMITTED',
        title: 'Inspection submitted',
        body: '4226 Oak Shadows · Submitted by Moses',
        inspectionId: 'inspection-2',
        createdAt: new Date('2026-09-15T15:05:00.000Z'),
      },
    ]);
    const service = new AdminService(
      { organizationNotification: { findMany } } as never,
      new PresenceService(),
    );

    await expect(service.organizationNotifications(user)).resolves.toEqual([
      {
        id: 'notification-2',
        kind: 'INSPECTION_SUBMITTED',
        title: 'Inspection submitted',
        body: '4226 Oak Shadows · Submitted by Moses',
        inspectionId: 'inspection-2',
        occurredAt: '2026-09-15T15:05:00.000Z',
      },
    ]);
    // Scoped by the signed-in account's organization, never by anything asked for.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'organization-1' },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );
  });
});
