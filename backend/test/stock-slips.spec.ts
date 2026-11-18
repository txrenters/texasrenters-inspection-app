import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { MACHINE_FORBIDDEN_PERMISSIONS, type PostStockSlipInput } from '@texasrenters/shared';

import { PERMISSIONS_METADATA_KEY } from '../src/common/auth';
import { PostStockSlipDto, ReverseStockSlipDto, StockSlipChoicesQueryDto, StockSlipsController } from '../src/admin/stock-slips.controller';
import { StockSlipsService } from '../src/admin/stock-slips.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Withdrawals, returns and moves, phase 5 (2026-11-19). Every id, name, code
 * and price here is invented. The database below keeps slips and stock
 * movements the way the service reads and writes them, adds stock up from the
 * movements as the real one's trigger does, and refuses a level below nothing
 * with the real check's name. What only the real database does (a slip whose
 * places do not fit its kind, a movement used by two lines) is in the
 * migration and is not exercised here.
 */

const ORG = 'a0000000-0000-4000-8000-000000000001';
const OTHER_ORG = 'a0000000-0000-4000-8000-000000000002';
const id = (n: number) => `a0000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`;
const FILTER = id(1);
const BATTERY = id(2);
const OLD_PART = id(3);
const STOCKROOM = id(11);
const VAN = id(12);
const SHED = id(13);
const TECH = id(21);
const OTHER_TECH = id(22);
const CLERK = id(23);
const VISIT = id(31);
const OTHER_VISIT = id(32);
const CANCELLED_VISIT = id(33);
const key = (n: number) => id(900 + n);

const person = (n: number, displayName: string, permissions: string[], organizationId = ORG): AuthenticatedUser =>
  ({ id: id(800 + n), authUserId: `auth-${n}`, organizationId, displayName, roles: [UserRole.INSPECTION_SUPERVISOR], permissions, mustChangePassword: false, principalType: 'USER' }) as AuthenticatedUser;
const keeper = person(1, 'Sample Stock Keeper', ['inventory:read', 'inventory:withdraw']);
const outsider = person(2, 'Other Office', ['inventory:read', 'inventory:withdraw'], OTHER_ORG);

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([field, value]) => {
    if (value === undefined) return true;
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      const rule = value as { in?: unknown[]; not?: unknown; gt?: number };
      if (rule.in) return rule.in.includes(row[field]);
      if (rule.not !== undefined) return row[field] !== rule.not;
      if (rule.gt !== undefined) return (row[field] as number) > rule.gt;
      return true;
    }
    return (row[field] ?? null) === value;
  });
}

function database() {
  const items: Row[] = [
    { id: FILTER, organizationId: ORG, code: 'FLT-0003', codeKey: 'flt-0003', name: 'Filter 20x25x1', unit: 'each', active: true },
    { id: BATTERY, organizationId: ORG, code: 'PRT-0001', codeKey: 'prt-0001', name: 'Battery, 9 V', unit: 'each', active: true },
    { id: OLD_PART, organizationId: ORG, code: 'PRT-0002', codeKey: 'prt-0002', name: 'Old part', unit: 'each', active: false },
  ];
  const places: Row[] = [
    { id: STOCKROOM, organizationId: ORG, name: 'Stockroom', nameKey: 'stockroom', kind: 'STOCKROOM', technicianId: null, active: true },
    { id: VAN, organizationId: ORG, name: 'Van 1', nameKey: 'van 1', kind: 'VAN', technicianId: TECH, active: true },
    { id: SHED, organizationId: ORG, name: 'Old shed', nameKey: 'old shed', kind: 'STOCKROOM', technicianId: null, active: false },
  ];
  const members: Row[] = [
    { organizationId: ORG, userProfileId: TECH, role: UserRole.INSPECTION_TECHNICIAN, userProfile: { id: TECH, displayName: 'Sample Technician' } },
    { organizationId: ORG, userProfileId: OTHER_TECH, role: UserRole.INSPECTION_TECHNICIAN, userProfile: { id: OTHER_TECH, displayName: 'Another Technician' } },
    { organizationId: ORG, userProfileId: CLERK, role: UserRole.INSPECTION_SUPERVISOR, userProfile: { id: CLERK, displayName: 'Sample Clerk' } },
  ];
  const visit = (visitId: string, technicianId: string, over: Row = {}) => ({
    id: visitId,
    organizationId: ORG,
    status: 'SCHEDULED',
    scheduledAt: new Date('2026-11-19T00:00:00.000Z'),
    technicianId,
    jobberVisitTitle: null,
    inspectionType: 'HVAC_FILTER',
    propertywareBuilding: { addressLine1: '100 Sample St' },
    property: null,
    ...over,
  });
  const visits: Row[] = [visit(VISIT, TECH), visit(OTHER_VISIT, OTHER_TECH, { jobberVisitTitle: 'Move out', propertywareBuilding: null, property: { addressLine1: '200 Example Ave' } }), visit(CANCELLED_VISIT, TECH, { status: 'CANCELLED' })];
  // 40 filters at $3.90 in the stockroom and 10 at $4.40 in the van: $4.00 each on average. 6 batteries at $1.85.
  const movements: Row[] = [
    { id: id(301), organizationId: ORG, itemId: FILTER, placeId: STOCKROOM, kind: 'OPENING_BALANCE', quantity: 40, unitCostCents: 390, createdAt: new Date('2026-11-18T15:00:00.000Z') },
    { id: id(302), organizationId: ORG, itemId: FILTER, placeId: VAN, kind: 'OPENING_BALANCE', quantity: 10, unitCostCents: 440, createdAt: new Date('2026-11-18T15:01:00.000Z') },
    { id: id(303), organizationId: ORG, itemId: BATTERY, placeId: STOCKROOM, kind: 'OPENING_BALANCE', quantity: 6, unitCostCents: 185, createdAt: new Date('2026-11-18T15:02:00.000Z') },
  ];
  const slips: Row[] = [];
  const slipLines: Row[] = [];
  const audits: Row[] = [];
  const series = new Map<string, number>();
  let clock = Date.parse('2026-11-19T15:00:00.000Z');

  const levels = () => {
    const held = new Map<string, Row>();
    for (const movement of movements) {
      const at = `${String(movement.itemId)}|${String(movement.placeId)}`;
      const level = held.get(at) ?? { organizationId: movement.organizationId, itemId: movement.itemId, placeId: movement.placeId, quantity: 0, valueCents: 0 };
      level.quantity = (level.quantity as number) + (movement.quantity as number);
      level.valueCents = (level.valueCents as number) + (movement.quantity as number) * (movement.unitCostCents as number);
      held.set(at, level);
    }
    return [...held.values()];
  };
  const onHand = (itemId: string, placeId: string) => (levels().find((level) => level.itemId === itemId && level.placeId === placeId)?.quantity as number | undefined) ?? 0;
  const place = (placeId: unknown) => {
    const found = places.find((one) => one.id === placeId);
    return found ? { id: found.id, name: found.name } : null;
  };
  const movement = (movementId: unknown) => {
    const found = movements.find((one) => one.id === movementId);
    return found ? { ...found, place: place(found.placeId) } : null;
  };
  const whole = (slip: Row) => ({
    ...slip,
    technician: slip.technicianId ? (members.find((member) => member.userProfileId === slip.technicianId)!.userProfile as Row) : null,
    fromPlace: place(slip.fromPlaceId),
    toPlace: place(slip.toPlaceId),
    inspection: visits.find((one) => one.id === slip.inspectionId) ?? null,
    lines: slipLines.filter((line) => line.slipId === slip.id).map((line) => ({ ...line, item: items.find((one) => one.id === line.itemId)!, movement: movement(line.movementId), movementIn: movement(line.movementInId) })),
  });
  /** A visit is the technician's when the `assignments` rule names them; a day and a status narrow it as the service asks. */
  const visitsWhere = (where: Where) =>
    visits.filter((one) => {
      const assigned = (where.assignments as { some: { technicianId: string } } | undefined)?.some.technicianId;
      if (assigned && one.technicianId !== assigned) return false;
      if (where.scheduledAt instanceof Date && (one.scheduledAt as Date).getTime() !== where.scheduledAt.getTime()) return false;
      return matches(one, { ...where, assignments: undefined, scheduledAt: undefined });
    });

  const db = {
    stockSlip: {
      findMany: jest.fn(async ({ where }: { where: Where }) => slips.filter((row) => matches(row, where)).map(whole).reverse()),
      findFirst: jest.fn(async ({ where }: { where: Where }) => {
        const found = slips.find((row) => matches(row, where));
        return found ? whole(found) : null;
      }),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: id(100 + slips.length), reversedAt: null, reversedById: null, reversedByName: null, reverseReason: null, createdAt: new Date((clock += 1000)), ...data };
        slips.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Row }) => {
        const found = slips.filter((row) => matches(row, where));
        for (const row of found) Object.assign(row, data);
        return { count: found.length };
      }),
    },
    stockSlipLine: { create: jest.fn(async ({ data }: { data: Row }) => slipLines.push({ id: id(200 + slipLines.length), ...data })) },
    stockItem: { findMany: jest.fn(async ({ where }: { where: Where }) => items.filter((row) => matches(row, where))) },
    stockPlace: { findMany: jest.fn(async ({ where }: { where: Where }) => places.filter((row) => matches(row, where))) },
    stockLevel: {
      findMany: jest.fn(async ({ where }: { where: Where }) => levels().filter((row) => matches(row, where))),
      findUnique: jest.fn(async ({ where }: { where: { itemId_placeId: { itemId: string; placeId: string } } }) => ({ quantity: onHand(where.itemId_placeId.itemId, where.itemId_placeId.placeId) })),
    },
    stockMovement: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        if (onHand(data.itemId as string, data.placeId as string) + (data.quantity as number) < 0) throw new Error('violates check constraint "StockLevel_never_below_nothing"');
        if (data.reversesId && movements.some((one) => one.reversesId === data.reversesId)) throw Object.assign(new Error('reversed once'), { code: 'P2002' });
        const row = { id: id(400 + movements.length), reversesId: null, createdAt: new Date((clock += 1000)), ...data };
        movements.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: { where: Where }) => [...movements].reverse().find((row) => matches(row, where)) ?? null),
    },
    organizationMember: {
      findMany: jest.fn(async ({ where }: { where: Where }) => members.filter((row) => matches(row, { ...where, userProfile: undefined }))),
      findFirst: jest.fn(async ({ where }: { where: Where }) => members.find((row) => matches(row, where)) ?? null),
    },
    inspection: {
      findMany: jest.fn(async ({ where }: { where: Where }) => visitsWhere(where)),
      findFirst: jest.fn(async ({ where }: { where: Where }) => visitsWhere(where)[0] ?? null),
    },
    // No yearly count is open, so stock moves (stock-counts.spec.ts covers the freeze).
    stockCount: { findFirst: jest.fn(async (): Promise<{ number: string } | null> => null) },
    auditLog: { create: jest.fn(async ({ data }: { data: Row }) => audits.push(data)) },
    $queryRaw: jest.fn(async (_: unknown, __: string, kind: string) => {
      series.set(kind, (series.get(kind) ?? 0) + 1);
      return [{ taken: series.get(kind) }];
    }),
  };
  const transaction = { $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => work(client)) };
  const client: unknown = Object.assign(db, transaction);
  return { db, slips, slipLines, movements, audits, onHand, service: new StockSlipsService(db as never) };
}

const slip = (over: Partial<PostStockSlipInput> = {}): PostStockSlipInput => ({
  kind: 'WITHDRAWAL',
  technicianId: TECH,
  fromPlaceId: STOCKROOM,
  toPlaceId: null,
  inspectionId: VISIT,
  note: null,
  requestKey: key(1),
  lines: [{ itemId: FILTER, quantity: 4 }],
  ...over,
});
const bringBack = (over: Partial<PostStockSlipInput> = {}) => slip({ kind: 'RETURN', fromPlaceId: null, toPlaceId: STOCKROOM, requestKey: key(2), lines: [{ itemId: FILTER, quantity: 1 }], ...over });
const move = (over: Partial<PostStockSlipInput> = {}) => slip({ kind: 'TRANSFER', technicianId: null, inspectionId: null, toPlaceId: VAN, requestKey: key(3), lines: [{ itemId: FILTER, quantity: 12 }], ...over });
const added = (movements: Row[]) => movements.slice(3);

// "Today" is the Texas day 2026-11-19 whatever the machine's clock says: only the date is held still, so nothing waits on a timer.
beforeAll(() => {
  jest.useFakeTimers({ now: new Date('2026-11-19T18:00:00.000Z'), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'performance', 'hrtime'] });
});
afterAll(() => {
  jest.useRealTimers();
});

describe('a withdrawal', () => {
  it('takes stock out of the place at what the item costs on average, for the technician and the visit', async () => {
    const { service, movements, onHand, audits } = database();
    const { slips } = await service.post(keeper, slip({ note: '  for the   upstairs unit ' }));

    expect(added(movements)).toEqual([expect.objectContaining({ itemId: FILTER, placeId: STOCKROOM, kind: 'WITHDRAWAL', quantity: -4, unitCostCents: 400, note: 'WD-0001, Sample Technician', createdByName: 'Sample Stock Keeper' })]);
    expect(onHand(FILTER, STOCKROOM)).toBe(36);
    expect(slips).toEqual([
      expect.objectContaining({
        number: 'WD-0001',
        kind: 'WITHDRAWAL',
        day: '2026-11-19',
        technician: { id: TECH, name: 'Sample Technician' },
        from: { id: STOCKROOM, name: 'Stockroom' },
        to: null,
        visit: { id: VISIT, title: 'Hvac filter', address: '100 Sample St' },
        note: 'for the upstairs unit',
        lines: [{ itemCode: 'FLT-0003', itemName: 'Filter 20x25x1', quantity: 4, unitCostCents: 400 }],
        costCents: 1600,
        by: 'Sample Stock Keeper',
        reversed: null,
      }),
    ]);
    expect(audits).toEqual([expect.objectContaining({ action: 'STOCK_SLIP_POSTED', actorUserId: keeper.id, metadata: expect.objectContaining({ number: 'WD-0001', costCents: 1600 }) })]);
  });

  it('posts once however many times the same press arrives', async () => {
    const { service, movements, slips } = database();
    await service.post(keeper, slip());
    await service.post(keeper, slip());
    expect(slips).toHaveLength(1);
    expect(added(movements)).toHaveLength(1);
  });

  it('never takes out more than is in that place, and posts none of a slip with one such line', async () => {
    const { service, movements, slips } = database();
    await expect(service.post(keeper, slip({ lines: [{ itemId: BATTERY, quantity: 2 }, { itemId: FILTER, quantity: 41 }] }))).rejects.toMatchObject({ code: 'STOCK_SLIP_NOT_READY', message: 'Only 40 of FLT-0003 are there.' });
    await expect(service.post(keeper, slip({ fromPlaceId: VAN, lines: [{ itemId: BATTERY, quantity: 1 }] }))).rejects.toMatchObject({ message: 'None of PRT-0001 is there.' });
    expect(slips).toHaveLength(0);
    expect(added(movements)).toHaveLength(0);
  });

  it('says so when somebody else took the stock in the same moment', async () => {
    const { service, db } = database();
    db.stockMovement.create.mockRejectedValueOnce(new Error('new row violates check constraint "StockLevel_never_below_nothing"'));
    await expect(service.post(keeper, slip())).rejects.toMatchObject({ status: 409, code: 'STOCK_NOT_ENOUGH' });
  });

  it('is for one of this office\'s technicians, and a visit of their own', async () => {
    const { service, slips } = database();
    await expect(service.post(keeper, slip({ technicianId: CLERK, inspectionId: null }))).rejects.toMatchObject({ code: 'STOCK_TECHNICIAN_NOT_FOUND' });
    await expect(service.post(keeper, slip({ inspectionId: OTHER_VISIT }))).rejects.toMatchObject({ code: 'STOCK_VISIT_NOT_FOUND' });
    await expect(service.post(keeper, slip({ technicianId: null }))).rejects.toMatchObject({ message: 'Say who is taking it.' });
    expect(slips).toHaveLength(0);
  });

  it('refuses an item switched off, a place not in use, and an item on two lines', async () => {
    const { service } = database();
    await expect(service.post(keeper, slip({ lines: [{ itemId: OLD_PART, quantity: 1 }] }))).rejects.toMatchObject({ code: 'STOCK_ITEM_NOT_FOUND' });
    await expect(service.post(keeper, slip({ fromPlaceId: SHED }))).rejects.toMatchObject({ code: 'STOCK_PLACE_NOT_FOUND' });
    await expect(service.post(keeper, slip({ lines: [{ itemId: FILTER, quantity: 1 }, { itemId: FILTER, quantity: 2 }] }))).rejects.toMatchObject({ code: 'STOCK_SLIP_ITEM_TWICE' });
  });

  it('touches nothing of another office', async () => {
    const { service, slips } = database();
    await expect(service.post(outsider, slip())).rejects.toMatchObject({ code: 'STOCK_ITEM_NOT_FOUND' });
    await service.post(keeper, slip());
    expect((await service.list(outsider)).slips).toEqual([]);
    await expect(service.reverse(outsider, slips[0]!.id as string, { reason: 'not ours' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('a return', () => {
  it('brings stock back into a place at the average cost, with its own series', async () => {
    const { service, movements, onHand } = database();
    const { slips } = await service.post(keeper, bringBack());
    expect(added(movements)).toEqual([expect.objectContaining({ itemId: FILTER, placeId: STOCKROOM, kind: 'RETURN', quantity: 1, unitCostCents: 400 })]);
    expect(onHand(FILTER, STOCKROOM)).toBe(41);
    expect(slips[0]).toMatchObject({ number: 'RT-0001', kind: 'RETURN', from: null, to: { id: STOCKROOM, name: 'Stockroom' } });
  });

  it('comes back at what the last of it left at when none is on hand', async () => {
    const { service, movements } = database();
    await service.post(keeper, slip({ lines: [{ itemId: BATTERY, quantity: 6 }] }));
    await service.post(keeper, bringBack({ lines: [{ itemId: BATTERY, quantity: 2 }] }));
    expect(added(movements)[1]).toMatchObject({ kind: 'RETURN', quantity: 2, unitCostCents: 185 });
  });
});

describe('a move between places', () => {
  it('leaves one place and arrives in the other at the same cost, with nobody and no visit on it', async () => {
    const { service, movements, onHand } = database();
    // Sent with a technician and a visit by mistake: a move keeps neither.
    const { slips } = await service.post(keeper, move({ technicianId: TECH, inspectionId: VISIT }));
    expect(added(movements)).toEqual([
      expect.objectContaining({ placeId: STOCKROOM, kind: 'TRANSFER', quantity: -12, unitCostCents: 400, note: 'TR-0001' }),
      expect.objectContaining({ placeId: VAN, kind: 'TRANSFER', quantity: 12, unitCostCents: 400 }),
    ]);
    expect([onHand(FILTER, STOCKROOM), onHand(FILTER, VAN)]).toEqual([28, 22]);
    expect(slips[0]).toMatchObject({ number: 'TR-0001', technician: null, visit: null, from: { name: 'Stockroom' }, to: { name: 'Van 1' } });
  });

  it('needs two different places', async () => {
    const { service } = database();
    await expect(service.post(keeper, move({ toPlaceId: STOCKROOM }))).rejects.toMatchObject({ message: 'Choose two different places.' });
  });
});

describe('reversing a slip', () => {
  it('puts the stock back where it was, at the same cost, with who and why', async () => {
    const { service, slips, movements, onHand, audits } = database();
    await service.post(keeper, slip());
    const withdrawal = added(movements)[0]!;
    const list = await service.reverse(keeper, slips[0]!.id as string, { reason: '  wrong   technician ' });

    expect(added(movements)[1]).toMatchObject({ kind: 'REVERSAL', placeId: STOCKROOM, quantity: 4, unitCostCents: 400, reversesId: withdrawal.id, note: 'WD-0001 reversed: wrong technician' });
    expect(onHand(FILTER, STOCKROOM)).toBe(40);
    expect(list.slips[0]!.reversed).toMatchObject({ by: 'Sample Stock Keeper', reason: 'wrong technician' });
    expect(audits.at(-1)).toMatchObject({ action: 'STOCK_SLIP_REVERSED', metadata: { number: 'WD-0001', reason: 'wrong technician' } });
  });

  it('needs a reason, and happens once', async () => {
    const { service, slips, movements } = database();
    await service.post(keeper, slip());
    const slipId = slips[0]!.id as string;
    await expect(service.reverse(keeper, slipId, { reason: '   ' })).rejects.toMatchObject({ code: 'STOCK_SLIP_REVERSAL_NEEDS_REASON' });
    await service.reverse(keeper, slipId, { reason: 'entered twice' });
    await expect(service.reverse(keeper, slipId, { reason: 'entered twice' })).rejects.toMatchObject({ code: 'STOCK_SLIP_ALREADY_REVERSED' });
    expect(added(movements)).toHaveLength(2);
  });

  it('undoes both halves of a move', async () => {
    const { service, slips, onHand } = database();
    await service.post(keeper, move());
    await service.reverse(keeper, slips[0]!.id as string, { reason: 'wrong van' });
    expect([onHand(FILTER, STOCKROOM), onHand(FILTER, VAN)]).toEqual([40, 10]);
  });

  it('cannot take back out what is no longer there', async () => {
    const { service, slips, movements } = database();
    // 2 batteries come back to the van, then 1 leaves it again: the return of 2 can no longer be undone.
    await service.post(keeper, bringBack({ toPlaceId: VAN, lines: [{ itemId: BATTERY, quantity: 2 }] }));
    await service.post(keeper, slip({ fromPlaceId: VAN, lines: [{ itemId: BATTERY, quantity: 1 }], requestKey: key(4) }));
    const before = movements.length;
    await expect(service.reverse(keeper, slips[0]!.id as string, { reason: 'never came back' })).rejects.toMatchObject({ code: 'STOCK_NOT_ENOUGH', message: 'Only 1 of PRT-0001 is still in Van 1, so 2 cannot be taken back out.' });
    expect(movements).toHaveLength(before);
    expect(slips[0]!.reversedAt).toBeNull();
  });
});

describe('what the form chooses from', () => {
  it('lists the technicians, the places in use, the items switched on and what is where', async () => {
    const { service } = database();
    const choices = await service.choices(keeper);
    expect(choices.technicians).toEqual([{ id: OTHER_TECH, name: 'Another Technician' }, { id: TECH, name: 'Sample Technician' }]);
    expect(choices.places.map((place) => place.name)).toEqual(['Stockroom', 'Van 1']);
    expect(choices.items.map((item) => item.code)).toEqual(['FLT-0003', 'PRT-0001']);
    expect(choices.levels).toEqual(expect.arrayContaining([expect.objectContaining({ itemId: FILTER, placeId: VAN, quantity: 10 })]));
    expect(choices.visits).toEqual([]);
    expect(choices.day).toBe('2026-11-19');
  });

  it('offers the chosen technician\'s visits for the day, without the cancelled ones or anybody else\'s', async () => {
    const { service } = database();
    expect((await service.choices(keeper, TECH, '2026-11-19')).visits).toEqual([{ id: VISIT, title: 'Hvac filter', address: '100 Sample St' }]);
    expect((await service.choices(keeper, OTHER_TECH, '2026-11-19')).visits).toEqual([{ id: OTHER_VISIT, title: 'Move out', address: '200 Example Ave' }]);
    expect((await service.choices(keeper, TECH, '2026-11-20')).visits).toEqual([]);
  });
});

describe('what the API accepts', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (value: unknown, metatype: new () => object, type: 'body' | 'query' = 'body') => pipe.transform(value, { type, metatype });

  it('takes the whole slip the page sends', async () => {
    await expect(check(slip({ note: 'for the upstairs unit' }), PostStockSlipDto)).resolves.toMatchObject({ kind: 'WITHDRAWAL', lines: [{ itemId: FILTER, quantity: 4 }] });
    await expect(check(move(), PostStockSlipDto)).resolves.toMatchObject({ kind: 'TRANSFER', technicianId: null });
    await expect(check({ reason: 'wrong van' }, ReverseStockSlipDto)).resolves.toMatchObject({ reason: 'wrong van' });
    await expect(check({ technicianId: TECH, day: '2026-11-19' }, StockSlipChoicesQueryDto, 'query')).resolves.toMatchObject({ day: '2026-11-19' });
  });

  it('refuses a quantity of nothing, a slip with no lines, a kind it does not know and a field it does not know', async () => {
    await expect(check(slip({ lines: [{ itemId: FILTER, quantity: 0 }] }), PostStockSlipDto)).rejects.toBeDefined();
    await expect(check(slip({ lines: [{ itemId: FILTER, quantity: 1.5 }] }), PostStockSlipDto)).rejects.toBeDefined();
    await expect(check(slip({ lines: [] }), PostStockSlipDto)).rejects.toBeDefined();
    await expect(check({ ...slip(), kind: 'GIFT' }, PostStockSlipDto)).rejects.toBeDefined();
    await expect(check({ ...slip(), unitCostCents: 1 }, PostStockSlipDto)).rejects.toBeDefined();
    await expect(check({ reason: '' }, ReverseStockSlipDto)).rejects.toBeDefined();
    await expect(check({ day: 'tomorrow' }, StockSlipChoicesQueryDto, 'query')).rejects.toBeDefined();
  });

  it('lets nobody record or reverse without the permission, and no API key hold it', () => {
    const needs = (method: keyof StockSlipsController) => Reflect.getMetadata(PERMISSIONS_METADATA_KEY, StockSlipsController.prototype[method]) as string[];
    expect(needs('list')).toEqual(['inventory:read']);
    for (const method of ['choices', 'post', 'reverse'] as const) expect(needs(method)).toEqual(['inventory:read', 'inventory:withdraw']);
    expect(MACHINE_FORBIDDEN_PERMISSIONS).toContain('inventory:withdraw');
  });
});
