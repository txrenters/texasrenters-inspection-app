import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { MACHINE_FORBIDDEN_PERMISSIONS, type StartStockCountInput, type StockCountDetail } from '@texasrenters/shared';

import { CancelStockCountDto, PostStockCountDto, SaveStockCountDto, StartStockCountDto, StockCountsController } from '../src/admin/stock-counts.controller';
import { StockCountsService } from '../src/admin/stock-counts.service';
import { assertStockNotFrozen } from '../src/admin/stock-freeze';
import { PERMISSIONS_METADATA_KEY, type AuthenticatedUser } from '../src/common/auth';

/**
 * Inventory counts, phase 6 (2026-11-19). Every id, name, code and price here
 * is invented. The database below keeps counts, their lines and the stock
 * movements the way the service reads and writes them, and adds stock up from
 * the movements as the real one's trigger does. What only the real database
 * does (one unfinished count a place, a count posted by whoever counted it,
 * stock held still under a yearly count) is in the migration and is not
 * exercised here.
 */

const ORG = 'a0000000-0000-4000-8000-000000000001';
const OTHER_ORG = 'a0000000-0000-4000-8000-000000000002';
const id = (n: number) => `a0000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`;
const FILTER = id(1);
const BATTERY = id(2);
const OLD_PART = id(3);
const GLUE = id(4);
const STOCKROOM = id(11);
const VAN = id(12);
const SHED = id(13);
const key = (n: number) => id(900 + n);

const person = (n: number, displayName: string, permissions: string[], organizationId = ORG): AuthenticatedUser =>
  ({ id: id(800 + n), authUserId: `auth-${n}`, organizationId, displayName, roles: [UserRole.INSPECTION_SUPERVISOR], permissions, mustChangePassword: false, principalType: 'USER' }) as AuthenticatedUser;
const counter = person(1, 'Sample Counter', ['inventory:read', 'inventory:count']);
const manager = person(2, 'Sample Manager', ['inventory:read', 'inventory:count-approve']);
/** May count and may approve: still never approves what they counted, and never sees its expected numbers. */
const both = person(3, 'Sample Both', ['inventory:read', 'inventory:count', 'inventory:count-approve']);
const reader = person(4, 'Sample Reader', ['inventory:read']);
const outsider = person(5, 'Other Office', ['inventory:read', 'inventory:count', 'inventory:count-approve'], OTHER_ORG);

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([field, value]) => {
    if (value === undefined) return true;
    if (field === 'OR') return (value as Where[]).some((part) => matches(row, part));
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      const rule = value as { in?: unknown[]; not?: unknown; gt?: number; gte?: unknown };
      if (rule.in) return rule.in.includes(row[field]);
      if ('not' in rule) return (row[field] ?? null) !== rule.not;
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
    { id: GLUE, organizationId: ORG, code: 'PST-0001', codeKey: 'pst-0001', name: 'Glue boards', unit: 'pack', active: true },
  ];
  const places: Row[] = [
    { id: STOCKROOM, organizationId: ORG, name: 'Stockroom', nameKey: 'stockroom', kind: 'STOCKROOM', active: true },
    { id: VAN, organizationId: ORG, name: 'Van 1', nameKey: 'van 1', kind: 'VAN', active: true },
    { id: SHED, organizationId: ORG, name: 'Old shed', nameKey: 'old shed', kind: 'STOCKROOM', active: false },
  ];
  // 40 filters at $3.90 in the stockroom and 10 at $4.40 in the van: $4.00 each on average. 6 batteries at $1.85.
  // 2 of a part since switched off are still on the shelf. Glue boards have never been anywhere.
  const movements: Row[] = [
    { id: id(301), organizationId: ORG, itemId: FILTER, placeId: STOCKROOM, kind: 'OPENING_BALANCE', quantity: 40, unitCostCents: 390, createdAt: new Date('2026-11-18T15:00:00.000Z') },
    { id: id(302), organizationId: ORG, itemId: FILTER, placeId: VAN, kind: 'OPENING_BALANCE', quantity: 10, unitCostCents: 440, createdAt: new Date('2026-11-18T15:01:00.000Z') },
    { id: id(303), organizationId: ORG, itemId: BATTERY, placeId: STOCKROOM, kind: 'OPENING_BALANCE', quantity: 6, unitCostCents: 185, createdAt: new Date('2026-11-18T15:02:00.000Z') },
    { id: id(304), organizationId: ORG, itemId: OLD_PART, placeId: STOCKROOM, kind: 'OPENING_BALANCE', quantity: 2, unitCostCents: 100, createdAt: new Date('2026-11-18T15:03:00.000Z') },
    { id: id(305), organizationId: ORG, itemId: FILTER, placeId: STOCKROOM, kind: 'WITHDRAWAL', quantity: -4, unitCostCents: 400, createdAt: new Date('2026-11-18T16:00:00.000Z') },
    { id: id(306), organizationId: ORG, itemId: FILTER, placeId: STOCKROOM, kind: 'RETURN', quantity: 4, unitCostCents: 400, createdAt: new Date('2026-11-18T16:30:00.000Z') },
  ];
  const SEEDED = movements.length;
  const counts: Row[] = [];
  const lines: Row[] = [];
  const audits: Row[] = [];
  let series = 0;
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
  const wholeLine = (line: Row) => ({ ...line, item: items.find((one) => one.id === line.itemId)!, place: place(line.placeId)! });
  const whole = (count: Row): Row & { lines: ReturnType<typeof wholeLine>[] } => {
    const mine = lines.filter((line) => line.countId === count.id).map(wholeLine);
    // The service's order: by place, then by code.
    mine.sort((left, right) => String(left.place.name).localeCompare(String(right.place.name)) || String(left.item.code).localeCompare(String(right.item.code)));
    return { ...count, place: place(count.placeId), lines: mine, _count: { lines: mine.length } };
  };
  const update = (rows: Row[]) =>
    jest.fn(async ({ where, data }: { where: Where; data: Row }) => {
      const found = rows.filter((row) => matches(row, where));
      for (const row of found) Object.assign(row, data);
      return { count: found.length };
    });

  const db = {
    stockCount: {
      findMany: jest.fn(async ({ where, distinct }: { where: Where; distinct?: string[] }) => {
        const found = counts.filter((row) => matches(row, where)).map(whole).reverse();
        return distinct ? found.filter((row, index) => found.findIndex((other) => other.kind === row.kind) === index) : found;
      }),
      findFirst: jest.fn(async ({ where }: { where: Where }) => {
        const found = counts.find((row) => matches(row, where));
        return found ? whole(found) : null;
      }),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const blank = { status: 'OPEN', countedById: null, countedByName: null, submittedAt: null, approvedById: null, approvedByName: null, postedAt: null, netValueCents: null, cancelledAt: null, cancelledByName: null, cancelReason: null };
        const row = { id: id(100 + counts.length), ...blank, createdAt: new Date((clock += 1000)), ...data };
        counts.push(row);
        return row;
      }),
      updateMany: update(counts),
    },
    stockCountLine: {
      createMany: jest.fn(async ({ data }: { data: Row[] }) => {
        for (const row of data) lines.push({ id: id(500 + lines.length), countedQuantity: null, firstCountedQuantity: null, recount: false, expectedQuantity: null, unitCostCents: null, reason: null, movementId: null, ...row });
      }),
      findMany: jest.fn(async ({ where }: { where: Where }) => lines.filter((row) => matches(row, where)).map(wholeLine)),
      findFirst: jest.fn(async ({ where }: { where: Where }) => {
        const found = lines.find((row) => matches(row, where));
        return found ? wholeLine(found) : null;
      }),
      updateMany: update(lines),
      groupBy: jest.fn(async ({ where }: { where: Where }) => {
        const by = new Map<unknown, number>();
        for (const row of lines.filter((line) => matches(line, where))) by.set(row.countId, (by.get(row.countId) ?? 0) + 1);
        return [...by].map(([countId, all]) => ({ countId, _count: { _all: all } }));
      }),
    },
    stockItem: { findMany: jest.fn(async ({ where }: { where: Where }) => items.filter((row) => matches(row, where))) },
    stockPlace: { findMany: jest.fn(async ({ where }: { where: Where }) => places.filter((row) => matches(row, where))) },
    stockLevel: { findMany: jest.fn(async ({ where }: { where: Where }) => levels().filter((row) => matches(row, where))) },
    stockMovement: {
      // The newest movement of each item: what one cost last.
      findMany: jest.fn(async ({ where }: { where: Where }) => {
        const found = [...movements].reverse().filter((row) => matches(row, where));
        return found.filter((row, index) => found.findIndex((other) => other.itemId === row.itemId) === index);
      }),
      create: jest.fn(async ({ data }: { data: Row }) => {
        if (onHand(data.itemId as string, data.placeId as string) + (data.quantity as number) < 0) throw new Error('violates check constraint "StockLevel_never_below_nothing"');
        const row = { id: id(400 + movements.length), createdAt: new Date((clock += 1000)), ...data };
        movements.push(row);
        return row;
      }),
      groupBy: jest.fn(async ({ where }: { where: Where }) => {
        const taken = new Map<string, Row>();
        for (const row of movements.filter((movement) => matches(movement, where))) {
          const at = `${String(row.placeId)}|${String(row.itemId)}`;
          const sum = taken.get(at) ?? { placeId: row.placeId, itemId: row.itemId, _sum: { quantity: 0 } };
          (sum._sum as { quantity: number }).quantity += row.quantity as number;
          taken.set(at, sum);
        }
        return [...taken.values()];
      }),
    },
    auditLog: { create: jest.fn(async ({ data }: { data: Row }) => audits.push(data)) },
    // The lock a count is started under, and the CNT series.
    $queryRaw: jest.fn(async (_: unknown, ...values: unknown[]) => (values.includes('CNT') ? [{ taken: (series += 1) }] : [{ locked: '' }])),
    // The two statements written by hand: what was expected, for many lines at once; and lines sent back for a second count.
    $executeRaw: jest.fn(async (_: unknown, ...values: unknown[]) => {
      if (values.length === 4) {
        const [ids, expected, costs] = values as [string[], number[], number[]];
        ids.forEach((lineId, index) => Object.assign(lines.find((line) => line.id === lineId)!, { expectedQuantity: expected[index], unitCostCents: costs[index] }));
      } else {
        for (const lineId of values[1] as string[]) {
          const line = lines.find((one) => one.id === lineId)!;
          Object.assign(line, { firstCountedQuantity: line.countedQuantity, countedQuantity: null, recount: true });
        }
      }
      return 1;
    }),
  };
  const transaction = { $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => work(client)) };
  const client: unknown = Object.assign(db, transaction);
  return { db, counts, lines, movements, audits, onHand, added: () => movements.slice(SEEDED), service: new StockCountsService(db as never) };
}

const monthly = (over: Partial<StartStockCountInput> = {}): StartStockCountInput => ({ kind: 'MONTHLY', placeId: STOCKROOM, itemIds: [FILTER, BATTERY], note: null, requestKey: key(1), ...over });
const quarterly = (over: Partial<StartStockCountInput> = {}) => monthly({ kind: 'QUARTERLY', itemIds: [], requestKey: key(2), ...over });
const yearly = (over: Partial<StartStockCountInput> = {}) => monthly({ kind: 'YEARLY', placeId: null, itemIds: [], requestKey: key(3), ...over });
/** Every waiting line of a count, counted as given by item code. */
const tally = (count: StockCountDetail, counted: Record<string, number | null>) => ({ lines: count.rows.filter((row) => row.itemCode in counted).map((row) => ({ lineId: row.id, counted: counted[row.itemCode]! })) });
const row = (count: StockCountDetail, code: string) => count.rows.find((one) => one.itemCode === code)!;

// "Today" is the Texas day 2026-11-19 whatever the machine's clock says: only the date is held still, so nothing waits on a timer.
beforeAll(() => {
  jest.useFakeTimers({ now: new Date('2026-11-19T18:00:00.000Z'), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'performance', 'hrtime'] });
});
afterAll(() => {
  jest.useRealTimers();
});

describe('starting a count', () => {
  it('lists the chosen items of the place for a monthly count, numbered and named for its month', async () => {
    const { service, audits } = database();
    const count = await service.start(counter, monthly({ note: '  month   end ' }));

    expect(count).toMatchObject({ number: 'CNT-0001', kind: 'MONTHLY', title: 'Monthly count, November 2026', status: 'OPEN', place: { id: STOCKROOM, name: 'Stockroom' }, day: '2026-11-19', lines: 2, counted: 0, note: 'month end', startedBy: 'Sample Counter' });
    expect(count.rows.map((line) => [line.itemCode, line.place.name, line.counted, line.expected])).toEqual([
      ['FLT-0003', 'Stockroom', null, null],
      ['PRT-0001', 'Stockroom', null, null],
    ]);
    expect(count.can).toEqual({ count: true, recount: false, post: false, cancel: true });
    expect(audits).toEqual([expect.objectContaining({ action: 'STOCK_COUNT_STARTED', actorUserId: counter.id, metadata: { number: 'CNT-0001', kind: 'MONTHLY', lines: 2 } })]);
  });

  it('starts one count however many times the same press arrives', async () => {
    const { service, counts, lines } = database();
    const first = await service.start(counter, monthly());
    const second = await service.start(counter, monthly());
    expect(second.id).toBe(first.id);
    expect(counts).toHaveLength(1);
    expect(lines).toHaveLength(2);
  });

  it('takes everything in the place for a quarterly count: each item in use, and what is still on the shelf of one switched off', async () => {
    const { service } = database();
    const count = await service.start(counter, quarterly());
    expect(count.title).toBe('Quarterly count, Q4 2026');
    expect(count.rows.map((line) => line.itemCode)).toEqual(['FLT-0003', 'PRT-0001', 'PRT-0002', 'PST-0001']);
    expect(new Set(count.rows.map((line) => line.place.name))).toEqual(new Set(['Stockroom']));
  });

  it('takes every place for a yearly count: each item in a stockroom, and in a van what it has carried', async () => {
    const { service } = database();
    const count = await service.start(counter, yearly({ placeId: STOCKROOM }));
    expect(count).toMatchObject({ title: 'Yearly count, 2026', place: null });
    expect(count.rows.map((line) => `${line.place.name}: ${line.itemCode}`)).toEqual(['Stockroom: FLT-0003', 'Stockroom: PRT-0001', 'Stockroom: PRT-0002', 'Stockroom: PST-0001', 'Van 1: FLT-0003']);
  });

  it('needs a place, and items for a monthly count, that are in use', async () => {
    const { service } = database();
    await expect(service.start(counter, monthly({ placeId: null }))).rejects.toMatchObject({ status: 400, message: 'Choose the place to count.' });
    await expect(service.start(counter, monthly({ itemIds: [] }))).rejects.toMatchObject({ message: 'Choose at least one item to count.' });
    await expect(service.start(counter, monthly({ itemIds: [FILTER, OLD_PART] }))).rejects.toMatchObject({ code: 'STOCK_ITEM_NOT_FOUND' });
    await expect(service.start(counter, monthly({ placeId: SHED }))).rejects.toMatchObject({ code: 'STOCK_PLACE_NOT_FOUND' });
    await expect(service.start(outsider, monthly())).rejects.toMatchObject({ code: 'STOCK_PLACE_NOT_FOUND' });
  });

  it('keeps a place in one unfinished count, and nothing else open beside a yearly one', async () => {
    const { service } = database();
    await service.start(counter, monthly());
    await expect(service.start(counter, quarterly())).rejects.toMatchObject({ status: 409, message: 'CNT-0001 is already counting that place. Post or cancel it first.' });
    await expect(service.start(counter, yearly())).rejects.toMatchObject({ message: 'CNT-0001 is still open. Post or cancel it before starting the yearly count.' });
    // Another place is free.
    await expect(service.start(counter, quarterly({ placeId: VAN }))).resolves.toMatchObject({ number: 'CNT-0002' });

    const fresh = database();
    await fresh.service.start(counter, yearly());
    await expect(fresh.service.start(counter, monthly())).rejects.toMatchObject({ message: 'The yearly count CNT-0001 is open. Post or cancel it before starting another.' });
  });
});

describe('counting', () => {
  it('keeps what has been counted so far, and never shows the counter what was expected', async () => {
    const { service } = database();
    const started = await service.start(counter, monthly());
    const saved = await service.save(counter, started.id, tally(started, { 'FLT-0003': 40 }), false);

    expect(saved).toMatchObject({ status: 'COUNTING', counted: 1, countedBy: 'Sample Counter', reviewing: false, matched: null, different: null, recounts: 0 });
    expect(saved.rows.map((line) => [line.itemCode, line.counted, line.expected, line.difference])).toEqual([
      ['FLT-0003', 40, null, null],
      ['PRT-0001', null, null, null],
    ]);
  });

  it('belongs to the first person to enter a number', async () => {
    const { service } = database();
    const started = await service.start(counter, monthly());
    await service.save(counter, started.id, tally(started, { 'FLT-0003': 40 }), false);
    await expect(service.save(both, started.id, tally(started, { 'PRT-0001': 6 }), false)).rejects.toMatchObject({ status: 403, code: 'STOCK_COUNT_SOMEBODY_ELSE' });
    expect((await service.get(both, started.id)).can.count).toBe(false);
  });

  it('is not handed in until every line is counted, and takes only its own lines', async () => {
    const { service, lines } = database();
    const started = await service.start(counter, monthly());
    await expect(service.save(counter, started.id, tally(started, { 'FLT-0003': 40 }), true)).rejects.toMatchObject({ status: 409, message: '1 item is not counted yet.' });
    await expect(service.save(counter, started.id, { lines: [{ lineId: id(999), counted: 1 }] }, false)).rejects.toMatchObject({ code: 'STOCK_COUNT_LINE_NOT_OPEN' });
    await expect(service.save(counter, started.id, { lines: [{ lineId: started.rows[0]!.id, counted: 1 }, { lineId: started.rows[0]!.id, counted: 2 }] }, false)).rejects.toMatchObject({ code: 'STOCK_COUNT_LINE_TWICE' });
    await expect(service.save(outsider, started.id, tally(started, { 'FLT-0003': 40 }), false)).rejects.toMatchObject({ status: 404 });
    expect(lines.every((line) => line.expectedQuantity === null)).toBe(true);
  });
});

describe('handing a count in', () => {
  it('writes what was expected at that moment and puts the count up for review, where somebody else sees the differences', async () => {
    const { service, audits } = database();
    const started = await service.start(counter, monthly());
    const handed = await service.save(counter, started.id, tally(started, { 'FLT-0003': 40, 'PRT-0001': 5 }), true);

    // The counter: handed in, and still not shown what was expected.
    expect(handed).toMatchObject({ status: 'REVIEW', recounts: 0, reviewing: false, can: { count: false, recount: false, post: false, cancel: false } });
    expect(handed.rows.every((line) => line.expected === null && line.difference === null)).toBe(true);

    const review = await service.get(manager, started.id);
    expect(review).toMatchObject({ reviewing: true, matched: 1, different: 1, can: { count: false, recount: true, post: true, cancel: true } });
    expect(row(review, 'FLT-0003')).toMatchObject({ expected: 40, counted: 40, difference: 0, valueCents: 0 });
    expect(row(review, 'PRT-0001')).toMatchObject({ expected: 6, counted: 5, difference: -1, valueCents: -185 });
    // Somebody who only reads the inventory sees the count, not its expected numbers.
    expect((await service.get(reader, started.id)).reviewing).toBe(false);
    expect(audits.at(-1)).toMatchObject({ action: 'STOCK_COUNT_HANDED_IN', metadata: { number: 'CNT-0001', lines: 2, recounts: 0 } });
  });

  it('sends a difference worth more than $25 back for a second count before anybody reviews it', async () => {
    const { service, lines } = database();
    const started = await service.start(counter, monthly());
    // 10 filters short at $4.00 is $40.00.
    const first = await service.save(counter, started.id, tally(started, { 'FLT-0003': 30, 'PRT-0001': 6 }), true);

    expect(first).toMatchObject({ status: 'COUNTING', recounts: 1, counted: 1 });
    expect(row(first, 'FLT-0003')).toMatchObject({ counted: null, recount: true, expected: null });
    expect(lines.find((line) => line.itemId === FILTER)).toMatchObject({ firstCountedQuantity: 30, expectedQuantity: null });
    // The battery was handed in and is not counted over.
    await expect(service.save(counter, started.id, tally(first, { 'PRT-0001': 9 }), false)).rejects.toMatchObject({ code: 'STOCK_COUNT_LINE_NOT_OPEN' });

    // Counted again and still short: now it goes to review as it is.
    const second = await service.save(counter, started.id, tally(first, { 'FLT-0003': 31 }), true);
    expect(second).toMatchObject({ status: 'REVIEW', recounts: 0 });
    expect(row(await service.get(manager, started.id), 'FLT-0003')).toMatchObject({ expected: 40, counted: 31, difference: -9, valueCents: -3600, recount: true });
  });

  it('prices an item with none on hand at what one cost last', async () => {
    const { service, movements } = database();
    movements.push({ id: id(390), organizationId: ORG, itemId: BATTERY, placeId: STOCKROOM, kind: 'WITHDRAWAL', quantity: -6, unitCostCents: 185, createdAt: new Date('2026-11-19T14:00:00.000Z') });
    const started = await service.start(counter, monthly({ itemIds: [BATTERY] }));
    await service.save(counter, started.id, tally(started, { 'PRT-0001': 2 }), true);
    expect(row(await service.get(manager, started.id), 'PRT-0001')).toMatchObject({ expected: 0, counted: 2, difference: 2, valueCents: 370 });
  });
});

describe('reviewing and posting', () => {
  const handedIn = async (counted: Record<string, number> = { 'FLT-0003': 38, 'PRT-0001': 7 }, by = counter) => {
    const made = database();
    const started = await made.service.start(by, monthly());
    await made.service.save(by, started.id, tally(started, counted), true);
    return { ...made, countId: started.id, review: await made.service.get(manager, started.id) };
  };
  const reasons = (review: StockCountDetail, given: Record<string, string>) => ({ reasons: Object.entries(given).map(([code, reason]) => ({ lineId: row(review, code).id, reason })) }) as never;

  it('writes one adjustment a line that differed, at what the item cost, with its reason, who approved and what it came to', async () => {
    const { service, countId, review, added, onHand, audits } = await handedIn();
    const posted = await service.post(manager, countId, reasons(review, { 'FLT-0003': 'TAKEN_WITHOUT_WITHDRAWAL', 'PRT-0001': 'RETURNED_WITHOUT_RETURN' }));

    expect(added()).toEqual([
      expect.objectContaining({ itemId: FILTER, placeId: STOCKROOM, kind: 'COUNT_ADJUSTMENT', quantity: -2, unitCostCents: 400, note: 'CNT-0001: taken without a withdrawal', createdByName: 'Sample Manager' }),
      expect.objectContaining({ itemId: BATTERY, placeId: STOCKROOM, kind: 'COUNT_ADJUSTMENT', quantity: 1, unitCostCents: 185, note: 'CNT-0001: returned without a return' }),
    ]);
    expect([onHand(FILTER, STOCKROOM), onHand(BATTERY, STOCKROOM)]).toEqual([38, 7]);
    expect(posted).toMatchObject({ status: 'POSTED', approvedBy: 'Sample Manager', netValueCents: -615, can: { count: false, recount: false, post: false, cancel: false } });
    expect(row(posted, 'FLT-0003').reason).toBe('TAKEN_WITHOUT_WITHDRAWAL');
    expect(audits.at(-1)).toMatchObject({ action: 'STOCK_COUNT_POSTED', actorUserId: manager.id, metadata: { number: 'CNT-0001', lines: 2, adjusted: 2, netValueCents: -615 } });
    // Once it is posted the counter sees what was expected too.
    expect(row(await service.get(counter, countId), 'FLT-0003')).toMatchObject({ expected: 40, difference: -2 });
  });

  it('posts a count that matched with no movement at all', async () => {
    const { service, countId, added } = await handedIn({ 'FLT-0003': 40, 'PRT-0001': 6 });
    await expect(service.post(manager, countId, { reasons: [] })).resolves.toMatchObject({ status: 'POSTED', netValueCents: 0 });
    expect(added()).toEqual([]);
  });

  it('is never approved by the person who counted, whatever they may do elsewhere', async () => {
    const { service, countId, review, added } = await handedIn(undefined, both);
    const own = await service.get(both, countId);
    expect(own).toMatchObject({ reviewing: false, can: { recount: false, post: false } });
    expect(own.rows.every((line) => line.expected === null)).toBe(true);
    await expect(service.post(both, countId, reasons(review, { 'FLT-0003': 'NOT_KNOWN', 'PRT-0001': 'NOT_KNOWN' }))).rejects.toMatchObject({ status: 403, code: 'STOCK_COUNT_OWN' });
    await expect(service.recount(both, countId, row(review, 'FLT-0003').id)).rejects.toMatchObject({ code: 'STOCK_COUNT_OWN' });
    expect(added()).toEqual([]);
  });

  it('needs a reason for each difference, and one that fits it', async () => {
    const { service, countId, review, added, counts } = await handedIn();
    await expect(service.post(manager, countId, reasons(review, { 'FLT-0003': 'DAMAGED' }))).rejects.toMatchObject({ status: 409, message: 'Say why PRT-0001 differs.' });
    // Nothing short was "returned", and nothing over was "damaged".
    await expect(service.post(manager, countId, reasons(review, { 'FLT-0003': 'RETURNED_WITHOUT_RETURN', 'PRT-0001': 'NOT_KNOWN' }))).rejects.toMatchObject({ message: 'Say why FLT-0003 differs.' });
    await expect(service.post(manager, countId, reasons(review, { 'FLT-0003': 'NOT_KNOWN', 'PRT-0001': 'DAMAGED' }))).rejects.toMatchObject({ message: 'Say why PRT-0001 differs.' });
    expect(added()).toEqual([]);
    expect(counts[0]!.status).toBe('REVIEW');
  });

  it('sends one line back for a second count when the reviewer asks', async () => {
    const { service, countId, review, audits } = await handedIn();
    const back = await service.recount(manager, countId, row(review, 'PRT-0001').id);
    expect(back).toMatchObject({ status: 'COUNTING', can: { post: false } });
    expect(row(back, 'PRT-0001')).toMatchObject({ counted: null, recount: true, expected: null });
    expect(audits.at(-1)).toMatchObject({ action: 'STOCK_COUNT_RECOUNT_ASKED', metadata: { number: 'CNT-0001', item: 'PRT-0001' } });
    await expect(service.post(manager, countId, { reasons: [] })).rejects.toMatchObject({ code: 'STOCK_COUNT_NOT_IN_REVIEW' });

    const again = await service.get(counter, countId);
    expect(again.can.count).toBe(true);
    await service.save(counter, countId, tally(again, { 'PRT-0001': 6 }), true);
    expect(row(await service.get(manager, countId), 'PRT-0001')).toMatchObject({ expected: 6, counted: 6, difference: 0 });
  });

  it('says so when stock has left the place since it was counted', async () => {
    const { service, countId, review, movements, counts } = await handedIn({ 'FLT-0003': 38, 'PRT-0001': 4 });
    // 5 of the 6 batteries leave after the count: taking 2 more out would go below nothing.
    movements.push({ id: id(391), organizationId: ORG, itemId: BATTERY, placeId: STOCKROOM, kind: 'WITHDRAWAL', quantity: -5, unitCostCents: 185, createdAt: new Date() });
    await expect(service.post(manager, countId, reasons(review, { 'FLT-0003': 'NOT_KNOWN', 'PRT-0001': 'NOT_KNOWN' }))).rejects.toMatchObject({ status: 409, code: 'STOCK_COUNT_STOCK_MOVED' });
    expect(counts[0]!.status).toBe('REVIEW');
  });

  it('is reviewed only by somebody of this office who may approve', async () => {
    const { service, countId } = await handedIn();
    await expect(service.post(outsider, countId, { reasons: [] })).rejects.toMatchObject({ status: 404 });
    await expect(service.get(outsider, countId)).rejects.toMatchObject({ status: 404 });
    expect((await service.list(outsider)).counts).toEqual([]);
  });
});

describe('cancelling', () => {
  it('stops an unfinished count with a reason, and frees its place', async () => {
    const { service, audits, added } = database();
    const started = await service.start(counter, monthly());
    await service.save(counter, started.id, tally(started, { 'FLT-0003': 30, 'PRT-0001': 6 }), false);
    await expect(service.cancel(manager, started.id, { reason: '  ' })).rejects.toMatchObject({ code: 'STOCK_COUNT_CANCEL_NEEDS_REASON' });
    // Once somebody has counted, it is for an approver to stop.
    await expect(service.cancel(counter, started.id, { reason: 'wrong place' })).rejects.toMatchObject({ status: 403 });

    const stopped = await service.cancel(manager, started.id, { reason: ' wrong   place ' });
    expect(stopped).toMatchObject({ status: 'CANCELLED', cancelled: { by: 'Sample Manager', reason: 'wrong place' } });
    expect(audits.at(-1)).toMatchObject({ action: 'STOCK_COUNT_CANCELLED', metadata: { number: 'CNT-0001', reason: 'wrong place' } });
    expect(added()).toEqual([]);
    await expect(service.cancel(manager, started.id, { reason: 'again' })).rejects.toMatchObject({ code: 'STOCK_COUNT_FINISHED' });
    await expect(service.start(counter, quarterly())).resolves.toMatchObject({ number: 'CNT-0002' });
  });

  it('lets whoever started a count take it back while nobody has counted, and nobody who only reads', async () => {
    const { service } = database();
    const started = await service.start(counter, monthly());
    await expect(service.cancel(reader, started.id, { reason: 'not needed' })).rejects.toMatchObject({ status: 403 });
    await expect(service.cancel(counter, started.id, { reason: 'started by mistake' })).resolves.toMatchObject({ status: 'CANCELLED' });
  });
});

describe('a yearly count holds stock still', () => {
  it('refuses any other movement while it is open, and lets them through once it is not', async () => {
    const { service, db } = database();
    await expect(assertStockNotFrozen(db as never, ORG)).resolves.toBeUndefined();
    const started = await service.start(counter, yearly());
    await expect(assertStockNotFrozen(db as never, ORG)).rejects.toMatchObject({ status: 409, code: 'STOCK_FROZEN', message: 'The yearly count CNT-0001 is open, so stock cannot move until it is posted or cancelled.' });
    // Another office is not held.
    await expect(assertStockNotFrozen(db as never, OTHER_ORG)).resolves.toBeUndefined();
    await service.cancel(manager, started.id, { reason: 'not today' });
    await expect(assertStockNotFrozen(db as never, ORG)).resolves.toBeUndefined();
  });

  it('does not hold stock under a monthly count', async () => {
    const { service, db } = database();
    await service.start(counter, monthly());
    await expect(assertStockNotFrozen(db as never, ORG)).resolves.toBeUndefined();
  });
});

describe('the Counts tab', () => {
  it('lists the counts and says when each kind is next due, with this period\'s count and the last one posted', async () => {
    const { service } = database();
    const started = await service.start(counter, monthly());
    await service.save(counter, started.id, tally(started, { 'FLT-0003': 40, 'PRT-0001': 6 }), true);
    await service.post(manager, started.id, { reasons: [] });
    await service.start(counter, quarterly());

    const list = await service.list(reader);
    expect(list.counts.map((count) => [count.number, count.status, count.lines, count.counted])).toEqual([
      ['CNT-0002', 'OPEN', 4, 0],
      ['CNT-0001', 'POSTED', 2, 2],
    ]);
    expect(list.schedule).toEqual([
      { kind: 'MONTHLY', due: '2026-11-30', current: { id: started.id, number: 'CNT-0001', status: 'POSTED' }, lastPosted: { number: 'CNT-0001', day: '2026-11-19' } },
      { kind: 'QUARTERLY', due: '2026-12-31', current: expect.objectContaining({ number: 'CNT-0002', status: 'OPEN' }), lastPosted: null },
      { kind: 'YEARLY', due: '2026-12-31', current: null, lastPosted: null },
    ]);
  });

  it('suggests what has been taken out of each place for a monthly count', async () => {
    const { service } = database();
    const choices = await service.choices(counter);
    expect(choices.places.map((place) => place.name)).toEqual(['Stockroom', 'Van 1']);
    expect(choices.items.map((item) => item.code)).toEqual(['FLT-0003', 'PRT-0001', 'PST-0001']);
    expect(choices.fastMovers).toEqual([{ placeId: STOCKROOM, itemId: FILTER }]);
  });
});

describe('what the API accepts', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (value: unknown, metatype: new () => object) => pipe.transform(value, { type: 'body', metatype });

  it('takes what the pages send', async () => {
    await expect(check(monthly({ note: 'month end' }), StartStockCountDto)).resolves.toMatchObject({ kind: 'MONTHLY', itemIds: [FILTER, BATTERY] });
    await expect(check(yearly(), StartStockCountDto)).resolves.toMatchObject({ kind: 'YEARLY', placeId: null });
    await expect(check({ lines: [{ lineId: id(1), counted: 0 }, { lineId: id(2), counted: null }] }, SaveStockCountDto)).resolves.toMatchObject({ lines: [{ counted: 0 }, { counted: null }] });
    await expect(check({ reasons: [{ lineId: id(1), reason: 'DAMAGED' }] }, PostStockCountDto)).resolves.toBeDefined();
    await expect(check({ reason: 'wrong place' }, CancelStockCountDto)).resolves.toBeDefined();
  });

  it('refuses a count below nothing, a fraction, a reason it does not know, and a field it does not know', async () => {
    await expect(check({ lines: [{ lineId: id(1), counted: -1 }] }, SaveStockCountDto)).rejects.toBeDefined();
    await expect(check({ lines: [{ lineId: id(1), counted: 1.5 }] }, SaveStockCountDto)).rejects.toBeDefined();
    await expect(check({ lines: [{ lineId: id(1), counted: 1, expected: 1 }] }, SaveStockCountDto)).rejects.toBeDefined();
    await expect(check({ reasons: [{ lineId: id(1), reason: 'STOLEN' }] }, PostStockCountDto)).rejects.toBeDefined();
    await expect(check({ ...monthly(), kind: 'WEEKLY' }, StartStockCountDto)).rejects.toBeDefined();
    await expect(check({ ...monthly(), status: 'POSTED' }, StartStockCountDto)).rejects.toBeDefined();
    await expect(check({ reason: '' }, CancelStockCountDto)).rejects.toBeDefined();
  });

  it('keeps counting and approving behind their own permissions, which no API key may hold', () => {
    const needs = (method: keyof StockCountsController) => Reflect.getMetadata(PERMISSIONS_METADATA_KEY, StockCountsController.prototype[method]) as string[];
    for (const method of ['list', 'get', 'cancel'] as const) expect(needs(method)).toEqual(['inventory:read']);
    for (const method of ['choices', 'start', 'save', 'handIn'] as const) expect(needs(method)).toEqual(['inventory:read', 'inventory:count']);
    for (const method of ['recount', 'post'] as const) expect(needs(method)).toEqual(['inventory:read', 'inventory:count-approve']);
    expect(MACHINE_FORBIDDEN_PERMISSIONS).toEqual(expect.arrayContaining(['inventory:count', 'inventory:count-approve']));
  });
});
