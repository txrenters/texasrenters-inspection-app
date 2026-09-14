import { UserRole } from '@texasrenters/shared';

import { PresenceService } from '../src/realtime/presence.service';
import { TechnicianEventsGateway } from '../src/realtime/technician-events.gateway';

describe('PresenceService', () => {
  it('reports an account online while it holds a socket', () => {
    const presence = new PresenceService();
    expect(presence.presenceFor('user-1')).toEqual({ isOnline: false, lastSeenAt: null });

    presence.connected('user-1');
    expect(presence.presenceFor('user-1').isOnline).toBe(true);

    presence.disconnected('user-1');
    expect(presence.presenceFor('user-1').isOnline).toBe(false);
  });

  it('counts sockets rather than flagging, so one closing tab is not going offline', () => {
    const presence = new PresenceService();

    // A console in two tabs, or a phone reconnecting before the old socket has
    // timed out. A boolean would let the first disconnect mark them away while
    // they are still connected.
    presence.connected('user-1');
    presence.connected('user-1');
    presence.disconnected('user-1');

    expect(presence.presenceFor('user-1').isOnline).toBe(true);
    presence.disconnected('user-1');
    expect(presence.presenceFor('user-1').isOnline).toBe(false);
  });

  it('keeps a last-seen time after the last socket closes', () => {
    const presence = new PresenceService();
    presence.connected('user-1');
    presence.disconnected('user-1');

    const { isOnline, lastSeenAt } = presence.presenceFor('user-1');
    expect(isOnline).toBe(false);
    // Offline with no time at all reads as "never connected", which is a
    // different fact from "connected, then left".
    expect(lastSeenAt).not.toBeNull();
  });

  it('never counts below zero, so a stray disconnect cannot hide a live socket', () => {
    const presence = new PresenceService();
    presence.connected('user-1');
    presence.disconnected('user-1');
    presence.disconnected('user-1');
    presence.connected('user-1');

    expect(presence.presenceFor('user-1').isOnline).toBe(true);
  });

  it('says when an account arrives and when it leaves, and nothing in between', () => {
    const presence = new PresenceService();

    expect(presence.connected('user-1')).toBe(true);
    // A second tab, or a phone reconnecting early: still the same person, here.
    expect(presence.connected('user-1')).toBe(false);
    expect(presence.disconnected('user-1')).toBe(false);
    expect(presence.disconnected('user-1')).toBe(true);
    // A stray disconnect after the last one is not leaving twice.
    expect(presence.disconnected('user-1')).toBe(false);
    expect(presence.disconnected('never-seen')).toBe(false);
  });

  it('answers for many accounts at once, and for ones it has never seen', () => {
    const presence = new PresenceService();
    presence.connected('user-1');

    expect(presence.presenceForMany(['user-1', 'user-2'])).toMatchObject({
      'user-1': { isOnline: true },
      'user-2': { isOnline: false, lastSeenAt: null },
    });
  });
});

describe('gateway presence tracking', () => {
  const socket = (user?: { id: string; roles?: UserRole[] }) =>
    ({ data: user ? { user: { organizationId: 'organization-1', roles: [], ...user } } : {} }) as never;

  const watchedGateway = (presence: PresenceService) => {
    const gateway = new TechnicianEventsGateway({} as never, presence);
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    (gateway as unknown as { server: unknown }).server = { to };
    return { gateway, emit, to };
  };

  it('does not decrement for a socket that never authenticated', () => {
    const presence = new PresenceService();
    const gateway = new TechnicianEventsGateway({} as never, presence);

    presence.connected('user-1');
    // handleConnection disconnects an unauthenticated socket before setting
    // `data.user`, so its disconnect must not decrement somebody else's count —
    // or one failed connection would mark a working account offline.
    gateway.handleDisconnect(socket());

    expect(presence.presenceFor('user-1').isOnline).toBe(true);
  });

  it('marks the account offline when its own socket closes', () => {
    const presence = new PresenceService();
    const gateway = new TechnicianEventsGateway({} as never, presence);

    presence.connected('user-1');
    gateway.handleDisconnect(socket({ id: 'user-1' }));

    expect(presence.presenceFor('user-1').isOnline).toBe(false);
  });

  it('tells every console watching the map when a technician closes their last connection', () => {
    /**
     * Each console used to learn whether the app was open only from its own
     * last fetch of the map, minutes apart, so one account showed Moses online
     * while another showed him offline — and they swapped as each fetched again.
     */
    const presence = new PresenceService();
    const { gateway, emit, to } = watchedGateway(presence);
    const moses = { id: 'tech-moses', roles: [UserRole.INSPECTION_TECHNICIAN] };

    presence.connected('tech-moses');
    presence.connected('tech-moses');
    gateway.handleDisconnect(socket(moses));
    // Still holding a connection: nothing changed for anyone watching.
    expect(to).not.toHaveBeenCalled();

    gateway.handleDisconnect(socket(moses));
    expect(to).toHaveBeenCalledWith('organization:organization-1:locations');
    expect(emit).toHaveBeenCalledWith('technician:presence', {
      technicianId: 'tech-moses',
      connected: false,
      lastSeenAt: expect.any(String),
    });
  });

  it('says nothing to the map when an administrator closes the console', () => {
    const presence = new PresenceService();
    const { gateway, to } = watchedGateway(presence);

    presence.connected('admin-1');
    gateway.handleDisconnect(socket({ id: 'admin-1', roles: [UserRole.SYSTEM_ADMIN] }));

    expect(presence.presenceFor('admin-1').isOnline).toBe(false);
    expect(to).not.toHaveBeenCalled();
  });
});
