import { ValidationPipe } from '@nestjs/common';
import { UserRole, type SaveStockCountInput } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { ApplicationError } from '../src/common/errors';
import { SavePhoneCountDto, TechnicianCountsController } from '../src/technician/technician-counts.controller';
import { TechnicianCountsService } from '../src/technician/technician-counts.service';

/**
 * Counting a truck from the phone (2026-11-19). Every id, name and code here
 * is invented. The writing itself is the office's and is covered by
 * stock-counts.spec.ts: here it is a stand-in that keeps what it was asked to
 * save, so these cover what the phone may see, may ask for, and may send twice.
 */

const ORG = 'a0000000-0000-4000-8000-000000000001';
const OTHER_ORG = 'a0000000-0000-4000-8000-000000000002';
const id = (n: number) => `a0000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`;
const STOCKROOM = id(11);
const MY_TRUCK = id(12);
const SHARED_TRUCK = id(13);
const THEIR_TRUCK = id(14);
const MY_COUNT = id(21);
const STOCKROOM_COUNT = id(22);
const THEIR_COUNT = id(23);
const YEARLY_COUNT = id(24);
const SHARED_COUNT = id(25);
const FILTER_LINE = id(41);
const BATTERY_LINE = id(42);
const SETTLED_LINE = id(43);
/** On the truck and not on the count (2026-11-24). */
const EXTRA = id(4);

const technician = (n: number, displayName: string, organizationId = ORG): AuthenticatedUser =>
  ({ id: id(800 + n), authUserId: `auth-${n}`, organizationId, displayName, roles: [UserRole.INSPECTION_TECHNICIAN], permissions: [], mustChangePassword: false, principalType: 'USER' }) as AuthenticatedUser;
const ana = technician(1, 'Ana Sample');
const ben = technician(2, 'Ben Sample');
const stranger = technician(3, 'Other Office', OTHER_ORG);

type Row = Record<string, unknown>;
interface Line extends Row {
  id: string;
  countId: string;
  itemId: string;
  countedQuantity: number | null;
  recount: boolean;
  expectedQuantity: number | null;
  item: { code: string; name: string; unit: string };
}

function harness() {
  const places: Row[] = [
    { id: STOCKROOM, organizationId: ORG, name: 'Storeroom', kind: 'STOCKROOM', technicianId: null, active: true },
    { id: MY_TRUCK, organizationId: ORG, name: 'Truck 1', kind: 'VAN', technicianId: ana.id, active: true },
    { id: SHARED_TRUCK, organizationId: ORG, name: 'Shared truck', kind: 'VAN', technicianId: null, active: true },
    { id: THEIR_TRUCK, organizationId: ORG, name: 'Truck 2', kind: 'VAN', technicianId: ben.id, active: true },
  ];
  const day = new Date('2026-11-19T00:00:00.000Z');
  const counts: Row[] = [
    { id: MY_COUNT, organizationId: ORG, number: 'CNT-0013', kind: 'MONTHLY', day, status: 'OPEN', placeId: MY_TRUCK, countedById: null, createdAt: 1 },
    { id: STOCKROOM_COUNT, organizationId: ORG, number: 'CNT-0014', kind: 'MONTHLY', day, status: 'OPEN', placeId: STOCKROOM, countedById: null, createdAt: 2 },
    { id: THEIR_COUNT, organizationId: ORG, number: 'CNT-0015', kind: 'MONTHLY', day, status: 'OPEN', placeId: THEIR_TRUCK, countedById: null, createdAt: 3 },
    { id: YEARLY_COUNT, organizationId: ORG, number: 'CNT-0016', kind: 'YEARLY', day, status: 'OPEN', placeId: null, countedById: null, createdAt: 4 },
    { id: SHARED_COUNT, organizationId: ORG, number: 'CNT-0017', kind: 'QUARTERLY', day, status: 'COUNTING', placeId: SHARED_TRUCK, countedById: ben.id, createdAt: 5 },
  ];
  const lines: Line[] = [
    { id: FILTER_LINE, organizationId: ORG, countId: MY_COUNT, itemId: id(1), countedQuantity: null, recount: false, expectedQuantity: null, item: { code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each' } },
    { id: BATTERY_LINE, organizationId: ORG, countId: MY_COUNT, itemId: id(2), countedQuantity: 4, recount: false, expectedQuantity: null, item: { code: 'PRT-0001', name: 'Battery, 9 V', unit: 'each' } },
    // Handed in already: what was expected of it is written, and it is never sent to the phone.
    { id: SETTLED_LINE, organizationId: ORG, countId: MY_COUNT, itemId: id(3), countedQuantity: 2, recount: false, expectedQuantity: 9, item: { code: 'PST-0001', name: 'Glue boards', unit: 'pack' } },
  ];
  const saved: { user: AuthenticatedUser; countId: string; input: SaveStockCountInput; handIn: boolean }[] = [];
  let recounts = 0;
  // Every item in use (2026-11-24); the CO detector is on the truck but not on the count.
  const items: Row[] = [
    { id: id(1), code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each' },
    { id: id(2), code: 'PRT-0001', name: 'Battery, 9 V', unit: 'each' },
    { id: id(3), code: 'PST-0001', name: 'Glue boards', unit: 'pack' },
    { id: EXTRA, code: 'CO-0002', name: 'CO detector', unit: 'each' },
  ];
  const audits: Row[] = [];

  const prisma = {
    stockPlace: {
      findMany: jest.fn(async ({ where }: { where: { organizationId: string; active: boolean; kind: string; OR: { technicianId: string | null }[] } }) =>
        places.filter((place) => place.organizationId === where.organizationId && place.active === where.active && place.kind === where.kind && where.OR.some((one) => one.technicianId === place.technicianId)).map((place) => ({ id: place.id })),
      ),
    },
    stockCount: {
      findMany: jest.fn(async ({ where }: { where: { organizationId: string; status: { in: string[] }; placeId: { in: string[] }; OR: { countedById: string | null }[] } }) =>
        counts
          .filter((count) => count.organizationId === where.organizationId && where.status.in.includes(count.status as string) && where.placeId.in.includes(count.placeId as string) && where.OR.some((one) => one.countedById === count.countedById))
          .map((count) => ({ ...count, place: { id: count.placeId, name: places.find((place) => place.id === count.placeId)!.name }, lines: lines.filter((line) => line.countId === count.id && line.expectedQuantity === null) })),
      ),
      findFirst: jest.fn(async ({ where }: { where: { id: string; organizationId: string } }) => counts.find((count) => count.id === where.id && count.organizationId === where.organizationId) ?? null),
    },
    stockCountLine: {
      findMany: jest.fn(async ({ where }: { where: { organizationId: string; countId: string; expectedQuantity?: null; itemId?: { in: string[] } } }) =>
        lines.filter(
          (line) =>
            line.organizationId === where.organizationId &&
            line.countId === where.countId &&
            (!('expectedQuantity' in where) || line.expectedQuantity === null) &&
            (!where.itemId || where.itemId.in.includes(line.itemId as string)),
        ),
      ),
      createMany: jest.fn(async ({ data }: { data: Row[] }) =>
        lines.push(...data.map((line, n) => ({ ...line, id: `found-${lines.length + n}`, countId: line.countId as string, itemId: line.itemId as string, countedQuantity: null, recount: false, expectedQuantity: null, item: items.find((item) => item.id === line.itemId) as Line['item'] }))),
      ),
    },
    // Every item in use (2026-11-24): the phone's catalog, and what a found item is checked against.
    stockItem: { findMany: jest.fn(async ({ where }: { where: { id?: { in: string[] } } }) => items.filter((item) => !where.id || where.id.in.includes(item.id as string))) },
    auditLog: { create: jest.fn(async ({ data }: { data: Row }) => audits.push(data)) },
  };
  // The office's own writing, stood in for: it keeps what it was asked and does what handing in does.
  const office = {
    save: jest.fn(async (user: AuthenticatedUser, countId: string, input: SaveStockCountInput, handIn: boolean) => {
      saved.push({ user, countId, input, handIn });
      const count = counts.find((one) => one.id === countId)!;
      count.status = 'COUNTING';
      count.countedById = user.id;
      for (const sent of input.lines) lines.find((line) => line.id === sent.lineId)!.countedQuantity = sent.counted;
      if (handIn && recounts) {
        const again = lines.find((line) => line.id === FILTER_LINE)!;
        again.countedQuantity = null;
        again.recount = true;
        lines.find((line) => line.id === BATTERY_LINE)!.expectedQuantity = 4;
      } else if (handIn) {
        count.status = 'REVIEW';
        for (const line of lines.filter((one) => one.countId === countId)) line.expectedQuantity ??= 0;
      }
      return { recounts: handIn ? recounts : 0 };
    }),
  };
  const service = new TechnicianCountsService(prisma as never, office as never);
  return { service, counts, lines, saved, audits, askForRecount: () => (recounts = 1) };
}

const refusal = async (attempt: Promise<unknown>) => {
  const error = await attempt.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof ApplicationError)) throw new Error('Expected a refusal.');
  return { code: error.code, status: error.getStatus(), message: error.message };
};
const BOTH = [
  { lineId: FILTER_LINE, counted: 8, second: false },
  { lineId: BATTERY_LINE, counted: 4, second: false },
];

describe('what the phone is shown', () => {
  it('is the open count of the technician\'s own truck, with only the lines still to count and nothing expected', async () => {
    const { service } = harness();
    const { counts } = await service.mine(ana);
    expect(counts).toEqual([
      {
        id: MY_COUNT,
        number: 'CNT-0013',
        title: 'Monthly count, November 2026',
        place: { id: MY_TRUCK, name: 'Truck 1' },
        lines: [
          { lineId: FILTER_LINE, itemId: id(1), code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each', counted: null, second: false },
          { lineId: BATTERY_LINE, itemId: id(2), code: 'PRT-0001', name: 'Battery, 9 V', unit: 'each', counted: 4, second: false },
        ],
      },
    ]);
    // Blind: no word of what the console expects, a difference or a cost leaves the server.
    expect(JSON.stringify(counts)).not.toMatch(/expected|difference|cost|value/i);
  });

  it('never offers a storeroom\'s count, the yearly count, another technician\'s truck, or one somebody else has begun', async () => {
    const { service } = harness();
    // Ana: not the storeroom, not the yearly, not Ben's truck, and the shared truck's count is Ben's already.
    expect((await service.mine(ana)).counts.map((count) => count.id)).toEqual([MY_COUNT]);
    // Ben: his own truck, and the shared truck's count he began.
    expect((await service.mine(ben)).counts.map((count) => count.id)).toEqual([THEIR_COUNT, SHARED_COUNT]);
    expect((await service.mine(stranger)).counts).toEqual([]);
  });
});

describe('what the phone may send', () => {
  it('keeps what is counted so far through the office\'s own save, as this technician', async () => {
    const { service, saved } = harness();
    const result = await service.save(ana, MY_COUNT, { lines: [{ lineId: FILTER_LINE, counted: 8, second: false }], handIn: false });
    expect(saved).toEqual([{ user: ana, countId: MY_COUNT, input: { lines: [{ lineId: FILTER_LINE, counted: 8 }] }, handIn: false }]);
    expect(result.outcome).toBe('saved');
    expect(result.counts[0]!.lines.find((line) => line.lineId === FILTER_LINE)!.counted).toBe(8);
  });

  it('hands the count in, and it leaves the phone\'s list', async () => {
    const { service, saved } = harness();
    const result = await service.save(ana, MY_COUNT, { lines: BOTH, handIn: true });
    expect(saved[0]!.handIn).toBe(true);
    expect(result).toEqual({ counts: [], catalog: expect.any(Array), outcome: 'handed-in', recounts: 0 });
  });

  it('says so when a line comes back for a second count, and shows it waiting again', async () => {
    const { service, askForRecount } = harness();
    askForRecount();
    const result = await service.save(ana, MY_COUNT, { lines: BOTH, handIn: true });
    expect(result.outcome).toBe('recount');
    expect(result.recounts).toBe(1);
    expect(result.counts[0]!.lines).toEqual([{ lineId: FILTER_LINE, itemId: id(1), code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each', counted: null, second: true }]);
  });

  it('refuses a count that is not of one of the technician\'s trucks, as if it were not there', async () => {
    const { service, saved } = harness();
    for (const [who, countId] of [
      [ana, STOCKROOM_COUNT],
      [ana, THEIR_COUNT],
      [ana, YEARLY_COUNT],
      [stranger, MY_COUNT],
      [ana, id(999)],
    ] as const)
      expect(await refusal(service.save(who, countId, { lines: BOTH, handIn: false }))).toMatchObject({ code: 'STOCK_COUNT_NOT_FOUND', status: 404 });
    expect(saved).toEqual([]);
  });

  it('refuses a count somebody else has begun, a cancelled one, and a line sent twice', async () => {
    const { service, counts, saved } = harness();
    expect(await refusal(service.save(ana, SHARED_COUNT, { lines: BOTH, handIn: false }))).toMatchObject({ code: 'STOCK_COUNT_SOMEBODY_ELSE', status: 403 });
    expect(await refusal(service.save(ana, MY_COUNT, { lines: [BOTH[0]!, BOTH[0]!], handIn: false }))).toMatchObject({ code: 'STOCK_COUNT_LINE_TWICE', status: 400 });
    counts.find((count) => count.id === MY_COUNT)!.status = 'CANCELLED';
    expect(await refusal(service.save(ana, MY_COUNT, { lines: BOTH, handIn: true }))).toMatchObject({ code: 'STOCK_COUNT_NOT_COUNTING', message: 'The office cancelled that count.' });
    expect(saved).toEqual([]);
  });
});

describe('a hand-in the phone sends twice', () => {
  it('records once when the count went for review: the second is answered, and writes nothing', async () => {
    const { service, saved } = harness();
    await service.save(ana, MY_COUNT, { lines: BOTH, handIn: true });
    const again = await service.save(ana, MY_COUNT, { lines: BOTH, handIn: true });
    expect(again).toEqual({ counts: [], catalog: expect.any(Array), outcome: 'already', recounts: 0 });
    expect(saved).toHaveLength(1);
  });

  it('is never taken as the second count of a line that came back', async () => {
    const { service, saved, lines, askForRecount } = harness();
    askForRecount();
    await service.save(ana, MY_COUNT, { lines: BOTH, handIn: true });
    // The same first counts arrive again: the filter is now waiting for its SECOND count.
    const again = await service.save(ana, MY_COUNT, { lines: BOTH, handIn: true });
    expect(again.outcome).toBe('already');
    expect(saved).toHaveLength(1);
    expect(lines.find((line) => line.id === FILTER_LINE)!.countedQuantity).toBeNull();
    // Even alone, with the number it had: a first count is not a second.
    expect((await service.save(ana, MY_COUNT, { lines: [BOTH[0]!], handIn: true })).outcome).toBe('already');
    expect(saved).toHaveLength(1);

    // The real second count goes through.
    const second = await service.save(ana, MY_COUNT, { lines: [{ lineId: FILTER_LINE, counted: 7, second: true }], handIn: false });
    expect(second.outcome).toBe('saved');
    expect(saved).toHaveLength(2);
  });

  it('is refused for somebody who did not count it', async () => {
    const { service, counts } = harness();
    await service.save(ana, MY_COUNT, { lines: BOTH, handIn: true });
    // The truck is handed to nobody in particular afterwards: Ben can reach it, but the count was Ana's.
    counts.find((count) => count.id === MY_COUNT)!.placeId = SHARED_TRUCK;
    expect(await refusal(service.save(ben, MY_COUNT, { lines: BOTH, handIn: true }))).toMatchObject({ code: 'STOCK_COUNT_SOMEBODY_ELSE' });
  });
});

describe('the route', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (body: unknown) => pipe.transform(body, { type: 'body', metatype: SavePhoneCountDto });

  it('takes the contract\'s fields and nothing else', async () => {
    await expect(check({ lines: BOTH, handIn: true })).resolves.toMatchObject({ handIn: true });
    for (const extra of [{ countedById: ana.id }, { expected: 9 }, { placeId: STOCKROOM }]) await expect(check({ lines: BOTH, handIn: true, ...extra })).rejects.toBeTruthy();
    await expect(check({ lines: [{ ...BOTH[0]!, expected: 9 }], handIn: true })).rejects.toBeTruthy();
  });

  it('refuses a count that is not a whole number of units, and an empty send', async () => {
    for (const counted of [-1, 1.5, '8', null]) await expect(check({ lines: [{ lineId: FILTER_LINE, counted, second: false }], handIn: false })).rejects.toBeTruthy();
    // An empty send passes the route since 2026-11-24 (it may carry only what was found); the service refuses it.
    await expect(check({ lines: BOTH })).rejects.toBeTruthy();
  });

  it('is for signed-in technicians only', () => {
    expect(Reflect.getMetadata('roles', TechnicianCountsController)).toEqual([UserRole.INSPECTION_TECHNICIAN]);
  });
});

// Found on the truck and not on the list (the office, 2026-11-24).
describe('an item found that the count did not list', () => {
  it('is added to the count with what was found, sent twice it is added once, and the phone is told every item in use', async () => {
    const { service, lines, audits, saved } = harness();
    const before = await service.mine(ana);
    expect(before.catalog.map((item) => item.code)).toEqual(expect.arrayContaining(['FLT-0003']));
    const found = { lines: [], found: [{ itemId: EXTRA, counted: 3 }], handIn: false };
    await service.save(ana, MY_COUNT, found);
    await service.save(ana, MY_COUNT, found);
    expect(lines.filter((line) => line.itemId === EXTRA)).toHaveLength(1);
    expect(saved.at(-1)!.input.lines).toEqual([{ lineId: lines.find((line) => line.itemId === EXTRA)!.id, counted: 3 }]);
    expect(audits.filter((audit) => audit.action === 'STOCK_COUNT_ITEMS_FOUND')).toHaveLength(1);
  });

  it('refuses a send with nothing counted and nothing found, and an item not in use', async () => {
    const { service } = harness();
    await expect(service.save(ana, MY_COUNT, { lines: [], handIn: false })).rejects.toMatchObject({ code: 'STOCK_COUNT_NOTHING' });
    await expect(service.save(ana, MY_COUNT, { lines: [], found: [{ itemId: 'a0000000-0000-4000-8000-999999999999', counted: 1 }], handIn: false })).rejects.toMatchObject({ code: 'STOCK_ITEM_NOT_FOUND' });
  });
});
