import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import type { TechnicianPosition } from '@texasrenters/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { keys } from './queries';
import { AdminRealtimeProvider } from './realtime';

/**
 * The console's live connection, as every account holds it.
 *
 * One account showed Moses online while another showed him offline, and
 * notifications reached some consoles and not others.
 */

type Handler = (...args: never[]) => void;
type Deliver = (data: object) => void;

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  const connections: Array<{ url: string; options: { auth: (deliver: Deliver) => void } }> = [];
  const socket = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(),
  };
  return {
    handlers,
    connections,
    socket,
    io: (url: string, options: { auth: (deliver: Deliver) => void }) => {
      connections.push({ url, options });
      return socket;
    },
    api: vi.fn(),
    push: vi.fn(),
    merge: vi.fn(),
    toast: vi.fn(),
  };
});

vi.mock('socket.io-client', () => ({ io: mocks.io }));
vi.mock('./api', () => ({ api: mocks.api }));
vi.mock('./auth', () => ({ useAuth: () => ({ session: { accessToken: 'token-at-load' } }) }));
vi.mock('./notifications', () => ({
  useNotifications: () => ({ push: mocks.push, merge: mocks.merge }),
}));
vi.mock('./session', () => ({ getSession: async () => ({ accessToken: 'token-now' }) }));
vi.mock('sonner', () => ({ toast: { info: mocks.toast } }));

const submitted = {
  id: 'notification-1',
  kind: 'INSPECTION_SUBMITTED',
  title: 'Inspection submitted',
  body: '4226 Oak Shadows · Submitted by Moses',
  inspectionId: 'inspection-1',
  occurredAt: '2026-09-15T15:00:00.000Z',
};

const moses: TechnicianPosition = {
  id: 'ping-1',
  technicianId: 'tech-moses',
  latitude: 29.7604,
  longitude: -95.3698,
  accuracyMeters: 10,
  batteryPercent: null,
  headingDegrees: null,
  speedMetersPerSecond: null,
  recordedAt: '2026-09-15T14:00:00.000Z',
  technician: { id: 'tech-moses', displayName: 'Moses' },
  app: { connected: false, lastSeenAt: '2026-09-15T13:00:00.000Z' },
};

function mount() {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <AdminRealtimeProvider>
        <span />
      </AdminRealtimeProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function fire(event: string, ...args: unknown[]) {
  const handler = mocks.handlers.get(event) as unknown as (...values: unknown[]) => void;
  act(() => handler(...args));
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://inspection-api.example.test');
  mocks.handlers.clear();
  mocks.connections.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('the console realtime connection', () => {
  it("shows a technician's app opening on every console the moment it happens", () => {
    const queryClient = mount();
    queryClient.setQueryData<TechnicianPosition[]>(keys.technicianLocations, [moses]);

    fire('technician:presence', {
      technicianId: 'tech-moses',
      connected: true,
      lastSeenAt: '2026-09-15T15:00:00.000Z',
    });

    expect(queryClient.getQueryData<TechnicianPosition[]>(keys.technicianLocations)?.[0]?.app).toEqual({
      connected: true,
      lastSeenAt: '2026-09-15T15:00:00.000Z',
    });
  });

  it("catches up on connecting: the map refetches and the organization's notifications load", async () => {
    mocks.api.mockResolvedValue([submitted]);
    const queryClient = mount();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    fire('technician:ready', { connectedAt: '2026-09-15T15:01:00.000Z' });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.technicianLocations });
    expect(mocks.api).toHaveBeenCalledWith('/api/v1/admin/notifications');
    await waitFor(() => expect(mocks.merge).toHaveBeenCalledWith([submitted]));
    // Loaded, not announced: history is not news.
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('announces a live notification and keeps it in the bell', () => {
    mount();

    fire('notification', submitted);

    expect(mocks.push).toHaveBeenCalledWith(submitted);
    expect(mocks.toast).toHaveBeenCalledWith('Inspection submitted', {
      description: '4226 Oak Shadows · Submitted by Moses',
    });
  });

  it('leaves an added area to its stored notification, so it is announced once', () => {
    mount();

    fire('area:added', {
      inspectionId: 'inspection-1',
      areaId: 'area-1',
      areaName: 'Utility Room',
      floorName: null,
      propertyName: '4226 Oak Shadows',
      technicianName: 'Moses',
      occurredAt: '2026-09-15T15:00:00.000Z',
    });

    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('offers the token the session holds at each attempt, not the one the page loaded with', async () => {
    mount();
    const deliver = vi.fn();

    mocks.connections[0]?.options.auth(deliver);

    await waitFor(() => expect(deliver).toHaveBeenCalledWith({ accessToken: 'token-now' }));
  });

  it('connects again after the server hangs up, which socket.io never does by itself', () => {
    vi.useFakeTimers();
    mount();

    fire('disconnect', 'transport close');
    act(() => vi.advanceTimersByTime(60_000));
    // A dropped network is socket.io's own to recover from.
    expect(mocks.socket.connect).not.toHaveBeenCalled();

    fire('disconnect', 'io server disconnect');
    act(() => vi.advanceTimersByTime(2_000));
    expect(mocks.socket.connect).toHaveBeenCalledTimes(1);
  });
});
