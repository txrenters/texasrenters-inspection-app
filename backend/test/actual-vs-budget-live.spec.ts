import { UserRole } from '@prisma/client';

import { ActualVsBudgetGateway } from '../src/admin/actual-vs-budget.gateway';
import { ActualVsBudgetService } from '../src/admin/actual-vs-budget.service';
import type { AuthenticatedUser } from '../src/common/auth';
import * as auth from '../src/common/auth';

/**
 * Actual vs Budget, live (2026-11-17). The office: "we should make it real time
 * cause there are two roles and users who are going to constantly update it, it
 * should sync all the time like the spreadsheet". Ids and names invented.
 */

const ORG = '70000000-0000-4000-8000-000000000001';
const TECH = '70000000-0000-4000-8000-000000000002';
const VISIT = '70000000-0000-4000-8000-000000000101';
const office = {
  id: '70000000-0000-4000-8000-000000000009',
  organizationId: ORG,
  displayName: 'Office Coordinator',
  roles: [UserRole.INSPECTION_SUPERVISOR],
  permissions: ['invoices:read', 'invoices:manage'],
  principalType: 'USER',
  mustChangePassword: false,
} as unknown as AuthenticatedUser;

function service() {
  const db: Record<string, unknown> = {
    inspection: {
      findFirst: jest.fn(async () => ({ id: VISIT, scheduledAt: new Date('2026-11-11T00:00:00.000Z'), assignments: [{ technicianId: TECH }] })),
    },
    organizationMember: { findFirst: jest.fn(async () => ({ userProfile: { id: TECH, displayName: 'Sample Technician' } })) },
    revenueLogEntry: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'entry-1', ...data })),
    },
    revenueDayEntry: { findUnique: jest.fn(async () => null), upsert: jest.fn() },
    revenueWeekEntry: { findUnique: jest.fn(async () => null), upsert: jest.fn() },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn(async (work: (tx: unknown) => unknown): Promise<unknown> => work(db)),
  };
  const live = { publishChange: jest.fn() };
  return { revenue: new ActualVsBudgetService(db as never, live as unknown as ActualVsBudgetGateway), live };
}

describe('every save is told to the office', () => {
  it("names the log's cells a visit's save changed, and who changed them", async () => {
    const { revenue, live } = service();
    await revenue.saveVisit(office, VISIT, { workOrder: '37826', driveTime: '10–20 min' });
    expect(live.publishChange).toHaveBeenCalledWith(ORG, {
      scope: 'log',
      cells: [`log:${VISIT}:workOrder`, `log:${VISIT}:driveTime`],
      by: { userId: office.id, name: 'Office Coordinator' },
    });
  });

  it("names a technician's day and week cells as every sheet shows them", async () => {
    const { revenue, live } = service();
    await revenue.saveDay(office, TECH, '2026-11-11', { workSeconds: 30300 });
    expect(live.publishChange).toHaveBeenLastCalledWith(ORG, expect.objectContaining({ scope: 'day', cells: [`day:${TECH}:2026-11-11:workSeconds`] }));
    await revenue.saveWeek(office, TECH, '2026-11-09', { targetCents: 244000 });
    expect(live.publishChange).toHaveBeenLastCalledWith(ORG, expect.objectContaining({ scope: 'week', cells: [`week:${TECH}:2026-11-09:targetCents`] }));
  });

  it('tells nothing when a save is refused', async () => {
    const { revenue, live } = service();
    await expect(revenue.saveWeek(office, TECH, '2026-11-10', { remarks: 'x' })).rejects.toMatchObject({ code: 'BAD_DATES' });
    expect(live.publishChange).not.toHaveBeenCalled();
  });
});

describe('the live channel', () => {
  function gateway() {
    const emitted: { room: string; event: string; payload: unknown }[] = [];
    const sockets: unknown[] = [];
    const server = {
      to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) }),
      in: () => ({ fetchSockets: async () => sockets }),
    };
    const live = new ActualVsBudgetGateway({} as never);
    (live as unknown as { server: unknown }).server = server;
    return { live, emitted, sockets };
  }
  const socket = (user: AuthenticatedUser | undefined, token = 'token') => ({
    handshake: { auth: { accessToken: token } },
    data: user ? { user, view: null, cell: null } : {},
    disconnected: false,
    join: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
  });

  afterEach(() => jest.restoreAllMocks());

  it("lets in only an account that may read the office's money", async () => {
    const { live } = gateway();
    jest.spyOn(auth, 'authenticateApplicationUser').mockResolvedValue({ ...office, permissions: ['inspections:read'] } as never);
    const refused = socket(undefined);
    await live.handleConnection(refused as never);
    expect(refused.disconnect).toHaveBeenCalledWith(true);
    expect(refused.join).not.toHaveBeenCalled();

    jest.spyOn(auth, 'authenticateApplicationUser').mockResolvedValue(office as never);
    const allowed = socket(undefined);
    await live.handleConnection(allowed as never);
    expect(allowed.join).toHaveBeenCalledWith(`actual-vs-budget:${ORG}`);
    expect(allowed.emit).toHaveBeenCalledWith('ready', expect.anything());
  });

  it('tells a save to the office, stamped', () => {
    const { live, emitted } = gateway();
    live.publishChange(ORG, { scope: 'log', cells: ['log:a:workOrder'], by: { userId: 'u', name: 'N' } });
    expect(emitted).toEqual([{ room: `actual-vs-budget:${ORG}`, event: 'changed', payload: expect.objectContaining({ scope: 'log', at: expect.any(String) }) }]);
  });

  it("shows each person's sheet and cell to the others, once a person, and ignores what is not a name", async () => {
    const { live, emitted, sockets } = gateway();
    const mine = socket(office);
    const other = { ...office, id: 'other', displayName: 'Second Coordinator' } as AuthenticatedUser;
    sockets.push(mine, socket(other), socket(other));
    await live.focus(mine as never, { view: 'tracker', cell: `day:${TECH}:2026-11-11:workSeconds` });
    await live.focus(mine as never, { view: '<script>', cell: 'x'.repeat(500) });
    const last = emitted.at(-1)!;
    expect(last.event).toBe('presence');
    expect((last.payload as { editors: unknown[] }).editors).toEqual([
      { userId: office.id, name: 'Office Coordinator', view: null, cell: null },
      { userId: 'other', name: 'Second Coordinator', view: null, cell: null },
    ]);
    const first = emitted.find((entry) => entry.event === 'presence')!;
    expect((first.payload as { editors: { cell: string | null }[] }).editors[0]!.cell).toBe(`day:${TECH}:2026-11-11:workSeconds`);
  });
});
