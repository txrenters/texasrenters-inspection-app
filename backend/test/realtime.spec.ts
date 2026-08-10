import { createHmac } from 'node:crypto';

import { UserRole } from '@texasrenters/shared';

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

    await new TechnicianEventsGateway(prisma as never).handleConnection(client as never);

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

    await new TechnicianEventsGateway(prisma as never).handleConnection(client as never);

    expect(client.join).toHaveBeenCalledWith('organization:organization-1');
    // Derived from the authenticated profile, never from the handshake — an
    // administrator cannot ask to watch somebody else's organization.
    expect(client.join).not.toHaveBeenCalledWith('organization:other-organization');
    expect(client.join).toHaveBeenCalledTimes(1);
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

    await new TechnicianEventsGateway(prisma as never).handleConnection(client as never);

    expect(client.join).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('broadcasts an added area to the organization, not to any technician', () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const gateway = new TechnicianEventsGateway({} as never);
    (gateway as unknown as { server: unknown }).server = { to };

    gateway.publishAreaAdded('organization-1', {
      inspectionId: 'inspection-1',
      areaId: 'area-1',
      areaName: 'Utility Room',
      floorName: 'Ground Floor',
      propertyName: '1458 Oak Ridge Drive',
      technicianName: 'Field Technician',
    });

    expect(to).toHaveBeenCalledWith('organization:organization-1');
    expect(to).toHaveBeenCalledTimes(1);
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
  });

  it('fans an assignment event out to background push delivery', () => {
    const mobilePush = { sendAssignment: jest.fn().mockResolvedValue(undefined) };
    const gateway = new TechnicianEventsGateway({} as never, mobilePush as never);

    gateway.publish('technician-1', 'inspection-1', 'ASSIGNED');

    expect(mobilePush.sendAssignment).toHaveBeenCalledWith('technician-1', 'inspection-1');
  });
});
