import { createHmac } from 'node:crypto';

import { UserRole } from '@texasrenters/shared';

import { TechnicianEventsGateway } from '../src/realtime/technician-events.gateway';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function accessToken(authUserId: string) {
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    sub: authUserId,
    aud: 'authenticated',
    iss: 'https://example.supabase.co/auth/v1',
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  const signature = createHmac('sha256', 'test-secret')
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

describe('technician realtime authorization', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_JWT_SECRET;
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
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects an authenticated account without the technician role', async () => {
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
      handshake: { auth: { accessToken: accessToken('auth-admin') } },
      data: {},
      join: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };

    await new TechnicianEventsGateway(prisma as never).handleConnection(client as never);

    expect(client.join).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('fans an assignment event out to background push delivery', () => {
    const mobilePush = { sendAssignment: jest.fn().mockResolvedValue(undefined) };
    const gateway = new TechnicianEventsGateway({} as never, mobilePush as never);

    gateway.publish('technician-1', 'inspection-1', 'ASSIGNED');

    expect(mobilePush.sendAssignment).toHaveBeenCalledWith('technician-1', 'inspection-1');
  });
});
