import { createHmac } from 'node:crypto';

import { UserRole } from '@texasrenters/shared';

import { PresenceService } from '../src/realtime/presence.service';
import { TechnicianEventsGateway } from '../src/realtime/technician-events.gateway';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function accessToken(authUserId: string) {
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    sub: authUserId,
    aud: 'authenticated',
    iss: 'https://api.texasrenters.com/auth',
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  const signature = createHmac('sha256', 'test-secret')
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

const technicianProfile = {
  id: 'technician-profile',
  authUserId: 'auth-tech',
  displayName: 'Field Technician',
  isActive: true,
  memberships: [{ organizationId: 'organization-1', role: UserRole.INSPECTION_TECHNICIAN }],
};

/** Lets the stored-notification write resolve and the emit after it run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('technician realtime authorization', () => {
  beforeEach(() => {
    process.env.AUTH_JWT_ISSUER = 'https://api.texasrenters.com/auth';
    process.env.AUTH_JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.AUTH_JWT_ISSUER;
    delete process.env.AUTH_JWT_SECRET;
  });

  it('joins only the technician room derived from the authenticated profile', async () => {
    const prisma = {
      userProfile: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'technician-profile',
          authUserId: 'auth-tech',
          displayName: 'Field Technician',
          isActive: true,
          memberships: [{ organizationId: 'organization-1', role: UserRole.INSPECTION_TECHNICIAN }],
        }),
      },
    };
    const client = {
      handshake: {
        auth: {
          accessToken: accessToken('auth-tech'),
          technicianId: 'attacker-selected-technician',
        },
      },
      data: {},
      join: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };

    await new TechnicianEventsGateway(prisma as never, new PresenceService()).handleConnection(client as never);

    expect(client.join).toHaveBeenCalledWith('technician:technician-profile');
    expect(client.join).not.toHaveBeenCalledWith('technician:attacker-selected-technician');
    // The namespace now carries administrators too. A technician must never
    // land in the organization room: it broadcasts what every technician in the
    // organization is doing, and this one is entitled to their own work only.
    expect(client.join).not.toHaveBeenCalledWith('organization:organization-1');
    expect(client.join).toHaveBeenCalledTimes(1);
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('puts an administrator in the organization room and no technician room', async () => {
    // This used to be "disconnects an authenticated account without the
    // technician role", which is why the web app had no realtime at all.
    const prisma = {
      userProfile: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-profile',
          authUserId: 'auth-admin',
          displayName: 'Administrator',
          isActive: true,
          memberships: [{ organizationId: 'organization-1', role: UserRole.SYSTEM_ADMIN }],
        }),
      },
    };
    const client = {
      handshake: {
        auth: { accessToken: accessToken('auth-admin'), organizationId: 'other-organization' },
      },
      data: {},
      join: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };

    await new TechnicianEventsGateway(prisma as never, new PresenceService()).handleConnection(client as never);

    expect(client.join).toHaveBeenCalledWith('organization:organization-1');
    // Derived from the authenticated profile, never from the handshake — an
    // administrator cannot ask to watch somebody else's organization.
    expect(client.join).not.toHaveBeenCalledWith('organization:other-organization');
    // Positions are a second room, and this account holds `technicians:read`.
    expect(client.join).toHaveBeenCalledWith('organization:organization-1:locations');
    // Two rooms, and neither of them a technician's.
    expect(client.join).toHaveBeenCalledTimes(2);
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('withholds live positions from an account that may read inspections but not technicians', async () => {
    // The boundary this room exists for. The organization room is joined on
    // `inspections:read`, but a position says where a named employee is, and
    // the HTTP endpoint serving the same data requires `technicians:read`.
    // Publishing positions into the organization room would hand them to every
    // account holding the weaker grant.
    const prisma = {
      userProfile: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'coordinator-profile',
          authUserId: 'auth-coordinator',
          displayName: 'Dana Coordinator',
          isActive: true,
          memberships: [{ organizationId: 'organization-1', role: UserRole.CHARGE_APPROVER }],
          roleAssignments: [
            {
              organizationId: 'organization-1',
              role: { permissions: ['inspections:read'] },
            },
          ],
        }),
      },
    };
    const client = {
      handshake: { auth: { accessToken: accessToken('auth-coordinator') } },
      data: {},
      join: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };

    await new TechnicianEventsGateway(prisma as never, new PresenceService()).handleConnection(client as never);

    expect(client.join).toHaveBeenCalledWith('organization:organization-1');
    expect(client.join).not.toHaveBeenCalledWith('organization:organization-1:locations');
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects an account that is neither a technician nor permitted to watch', async () => {
    // A membership label grants nothing on its own: permissions come from
    // administrator-created roles, and this account has none. It must not be
    // able to listen to an organization it cannot read over HTTP either.
    const prisma = {
      userProfile: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'approver-profile',
          authUserId: 'auth-approver',
          displayName: 'Casey Approver',
          isActive: true,
          memberships: [{ organizationId: 'organization-1', role: UserRole.CHARGE_APPROVER }],
          roleAssignments: [],
        }),
      },
    };
    const client = {
      handshake: { auth: { accessToken: accessToken('auth-approver') } },
      data: {},
      join: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };

    await new TechnicianEventsGateway(prisma as never, new PresenceService()).handleConnection(client as never);

    expect(client.join).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('tells the consoles watching the map when a technician opens the app', async () => {
    const prisma = { userProfile: { findUnique: jest.fn().mockResolvedValue(technicianProfile) } };
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const gateway = new TechnicianEventsGateway(prisma as never, new PresenceService());
    (gateway as unknown as { server: unknown }).server = { to };
    const connect = () =>
      gateway.handleConnection({
        handshake: { auth: { accessToken: accessToken('auth-tech') } },
        data: {},
        join: jest.fn().mockResolvedValue(undefined),
        emit: jest.fn(),
        disconnect: jest.fn(),
      } as never);

    await connect();
    // To the room joined on `technicians:locate`, the grant the map endpoint
    // serving the same fact requires.
    expect(to).toHaveBeenCalledWith('organization:organization-1:locations');
    expect(emit).toHaveBeenCalledWith('technician:presence', {
      technicianId: 'technician-profile',
      connected: true,
      lastSeenAt: expect.any(String),
    });

    // A second connection from the same phone is not arriving again.
    await connect();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('does not count a socket that closed while it was being authenticated', async () => {
    const client: Record<string, unknown> = {
      handshake: { auth: { accessToken: accessToken('auth-tech') } },
      data: {},
      disconnected: false,
      join: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
    const prisma = {
      userProfile: {
        findUnique: jest.fn().mockImplementation(async () => {
          // Its disconnect ran with no user attached and counted nothing, so
          // counting it now would leave this technician online until a restart.
          client.disconnected = true;
          return technicianProfile;
        }),
      },
    };
    const presence = new PresenceService();

    await new TechnicianEventsGateway(prisma as never, presence).handleConnection(client as never);

    expect(presence.presenceFor('technician-profile').isOnline).toBe(false);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('stores a notification before sending it, so every console account holds the same one', async () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const create = jest
      .fn()
      .mockResolvedValue({ id: 'notification-7', createdAt: new Date('2026-09-15T15:00:00.000Z') });
    const gateway = new TechnicianEventsGateway(
      { organizationNotification: { create } } as never,
      new PresenceService(),
    );
    (gateway as unknown as { server: unknown }).server = { to };

    const sent = await gateway.publishOrganizationNotification('organization-1', {
      kind: 'INSPECTION_SUBMITTED',
      title: 'Inspection submitted',
      body: '4226 Oak Shadows · Submitted by Moses',
      inspectionId: 'inspection-1',
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        organizationId: 'organization-1',
        kind: 'INSPECTION_SUBMITTED',
        title: 'Inspection submitted',
        body: '4226 Oak Shadows · Submitted by Moses',
        inspectionId: 'inspection-1',
      },
      select: { id: true, createdAt: true },
    });
    // The id the open consoles hear is the stored row's, which is what every
    // other account loads, so no bell counts it twice.
    expect(sent).toMatchObject({ id: 'notification-7', occurredAt: '2026-09-15T15:00:00.000Z' });
    expect(to).toHaveBeenCalledWith('organization:organization-1');
    expect(emit).toHaveBeenCalledWith('notification', sent);
  });

  it('still tells the open consoles when a notification cannot be stored', async () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const create = jest.fn().mockRejectedValue(new Error('database unavailable'));
    const gateway = new TechnicianEventsGateway(
      { organizationNotification: { create } } as never,
      new PresenceService(),
    );
    (gateway as unknown as { server: unknown }).server = { to };

    const sent = await gateway.publishOrganizationNotification('organization-1', {
      kind: 'INSPECTION_SUBMITTED',
      title: 'Inspection submitted',
      body: 'Submitted by Moses',
      inspectionId: 'inspection-1',
    });

    expect(sent.id).toEqual(expect.any(String));
    expect(emit).toHaveBeenCalledWith('notification', sent);
  });

  it('broadcasts an added area to the organization, not to any technician', async () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const create = jest
      .fn()
      .mockResolvedValue({ id: 'notification-8', createdAt: new Date('2026-09-15T15:00:00.000Z') });
    const gateway = new TechnicianEventsGateway(
      { organizationNotification: { create } } as never,
      new PresenceService(),
    );
    (gateway as unknown as { server: unknown }).server = { to };

    gateway.publishAreaAdded('organization-1', {
      inspectionId: 'inspection-1',
      areaId: 'area-1',
      areaName: 'Utility Room',
      floorName: 'Ground Floor',
      propertyName: '1458 Oak Ridge Drive',
      technicianName: 'Field Technician',
    });

    const [event, payload] = emit.mock.calls[0]!;
    expect(event).toBe('area:added');
    // Enough to render the notification without a follow-up fetch — a toast
    // that forces someone to go looking is worse than no toast.
    expect(payload).toMatchObject({
      areaName: 'Utility Room',
      propertyName: '1458 Oak Ridge Drive',
      technicianName: 'Field Technician',
    });
    expect(payload.occurredAt).toEqual(expect.any(String));

    // The bell's copy is stored, so an account that was not connected sees it too.
    await settle();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'organization-1',
          kind: 'AREA_ADDED',
          title: 'New area: Utility Room',
          body: '1458 Oak Ridge Drive · Ground Floor · Added by Field Technician',
          inspectionId: 'inspection-1',
        }),
      }),
    );
    expect(emit).toHaveBeenLastCalledWith(
      'notification',
      expect.objectContaining({ id: 'notification-8', kind: 'AREA_ADDED' }),
    );
    // Both to the organization's administrators, never a technician's room.
    expect(to.mock.calls.map(([room]) => room)).toEqual([
      'organization:organization-1',
      'organization:organization-1',
    ]);
  });

  it('hands every event to push delivery, which decides what is worth sending', () => {
    /**
     * The gateway used to gate on ASSIGNED itself, so a reopened inspection and
     * an evidence request reached nobody whose app was closed. Which kinds
     * deserve a push is a question about wording and noise, so it belongs with
     * the copy in MobilePushService rather than here.
     */
    const mobilePush = { send: jest.fn().mockResolvedValue(undefined) };
    const gateway = new TechnicianEventsGateway({} as never, new PresenceService(), mobilePush as never);

    gateway.publish('technician-1', 'inspection-1', 'ASSIGNED');
    gateway.publish('technician-1', 'inspection-2', 'REOPENED');

    expect(mobilePush.send).toHaveBeenCalledWith('ASSIGNED', 'technician-1', 'inspection-1');
    expect(mobilePush.send).toHaveBeenCalledWith('REOPENED', 'technician-1', 'inspection-2');
  });
});
