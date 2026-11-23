import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { MACHINE_FORBIDDEN_PERMISSIONS } from '@texasrenters/shared';

import { SaveTruckKeepLevelsDto, TruckStockController } from '../src/admin/truck-stock.controller';
import { TruckStockService } from '../src/admin/truck-stock.service';
import { PERMISSIONS_METADATA_KEY, type AuthenticatedUser } from '../src/common/auth';

/**
 * The trucks on the console (the office, 2026-11-24): what is kept on each
 * truck, and the asks from the trucks. Every item, place and person invented.
 * Filling an ask with a move is in stock-slips.spec.ts; asking from the phone
 * in technician-stock.spec.ts.
 */

const ORG = 'a0000000-0000-4000-8000-000000000001';
const id = (n: number) => `a0000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`;
const FILTER = id(1);
const BATTERY = id(2);
const ALARM = id(3);
const STOREROOM = id(11);
const TRUCK = id(12);
const keeper = { id: id(801), organizationId: ORG, displayName: 'Sample Stock Keeper', roles: [UserRole.INSPECTION_SUPERVISOR], permissions: ['inventory:read', 'inventory:manage'], principalType: 'USER' } as unknown as AuthenticatedUser;

type Row = Record<string, unknown>;

function harness() {
  const items: Row[] = [
    { id: ALARM, code: 'SMK-0010', name: 'Smoke alarm', unit: 'each' },
    { id: BATTERY, code: 'BAT-9V', name: 'Battery, 9 V', unit: 'each' },
    { id: FILTER, code: 'FLT-16251', name: 'Filter 16x25x1', unit: 'each' },
  ];
  const places: Row[] = [
    { id: STOREROOM, organizationId: ORG, name: 'Storeroom', code: 'STORE', kind: 'STOCKROOM', active: true },
    { id: TRUCK, organizationId: ORG, name: 'Truck 1', code: 'TRK-01', kind: 'VAN', active: true },
  ];
  const keeps: Row[] = [{ placeId: TRUCK, itemId: FILTER, keepAtLeast: 6 }];
  const levels: Row[] = [{ placeId: TRUCK, itemId: BATTERY, quantity: 2 }];
  const audits: Row[] = [];
  const ask = (n: number, status: string, at: string) => ({
    id: id(60 + n),
    note: null,
    status,
    createdAt: new Date(at),
    filledAt: status === 'FILLED' ? new Date(at) : null,
    filledByName: status === 'FILLED' ? 'Sample Stock Keeper' : null,
    place: { id: TRUCK, name: 'Truck 1' },
    askedBy: { id: id(802), displayName: 'Kim Example' },
    filledSlip: status === 'FILLED' ? { number: 'TR-0019' } : null,
    lines: [{ quantity: 4, item: { id: FILTER, code: 'FLT-16251', name: 'Filter 16x25x1', unit: 'each' } }],
  });
  const asks = [ask(1, 'FILLED', '2026-11-20T15:00:00Z'), ask(2, 'ASKED', '2026-11-24T16:40:00Z')];
  const prisma = {
    stockPlace: { findFirst: jest.fn(async ({ where }: { where: { id: string } }) => places.find((place) => place.id === where.id) ?? null) },
    stockItem: { findMany: jest.fn(async ({ where }: { where: { id?: { in: string[] } } }) => items.filter((item) => !where.id || where.id.in.includes(item.id as string))) },
    stockKeepLevel: {
      findMany: jest.fn(async () => keeps.map((keep) => ({ itemId: keep.itemId, keepAtLeast: keep.keepAtLeast }))),
      deleteMany: jest.fn(async ({ where }: { where: { itemId: { in: string[] } } }) => {
        for (let n = keeps.length - 1; n >= 0; n -= 1) if (where.itemId.in.includes(keeps[n]!.itemId as string)) keeps.splice(n, 1);
      }),
      upsert: jest.fn(async ({ where, create, update }: { where: { placeId_itemId: { itemId: string } }; create: Row; update: Row }) => {
        const found = keeps.find((keep) => keep.itemId === where.placeId_itemId.itemId);
        if (found) Object.assign(found, update);
        else keeps.push(create);
      }),
    },
    stockLevel: { findMany: jest.fn(async () => levels) },
    truckStockAsk: { findMany: jest.fn(async ({ where }: { where: { status: string } }) => asks.filter((one) => one.status === where.status)) },
    auditLog: { create: jest.fn(async ({ data }: { data: Row }) => audits.push(data)) },
  };
  Object.assign(prisma, { $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => work(prisma)) });
  return { service: new TruckStockService(prisma as never), keeps, audits };
}

describe('what is kept on a truck', () => {
  it('lists every item in use, those kept or held there first, with what is kept and on hand', async () => {
    const { service } = harness();
    const kept = await service.keepLevels(keeper, TRUCK);
    expect(kept.place).toEqual({ id: TRUCK, name: 'Truck 1', code: 'TRK-01' });
    expect(kept.levels.map((level) => [level.code, level.keepAtLeast, level.onHand])).toEqual([
      ['BAT-9V', null, 2],
      ['FLT-16251', 6, 0],
      ['SMK-0010', null, 0],
    ]);
  });

  it('sets a level, clears one sent as none, and is audited once', async () => {
    const { service, keeps, audits } = harness();
    await service.saveKeepLevels(keeper, TRUCK, { levels: [{ itemId: BATTERY, keepAtLeast: 6 }, { itemId: FILTER, keepAtLeast: null }] });
    expect(keeps).toEqual([expect.objectContaining({ itemId: BATTERY, keepAtLeast: 6, updatedById: keeper.id })]);
    expect(audits).toEqual([expect.objectContaining({ action: 'STOCK_KEEP_LEVELS_SET', metadata: { place: 'Truck 1', set: 1, cleared: 1 } })]);
  });

  it('is a truck\'s alone, of items in use, each once', async () => {
    const { service } = harness();
    await expect(service.keepLevels(keeper, STOREROOM)).rejects.toMatchObject({ code: 'STOCK_PLACE_NOT_A_TRUCK' });
    await expect(service.saveKeepLevels(keeper, TRUCK, { levels: [{ itemId: id(99), keepAtLeast: 2 }] })).rejects.toMatchObject({ code: 'STOCK_ITEM_NOT_FOUND' });
    await expect(service.saveKeepLevels(keeper, TRUCK, { levels: [{ itemId: FILTER, keepAtLeast: 2 }, { itemId: FILTER, keepAtLeast: 3 }] })).rejects.toMatchObject({ code: 'STOCK_KEEP_ITEM_TWICE' });
  });
});

describe('asks from the trucks', () => {
  it('lists the waiting ones first, then the latest filled with the move that filled it', async () => {
    const { service } = harness();
    const { asks } = await service.asks(keeper);
    expect(asks.map((ask) => [ask.status, ask.filled?.slipNumber ?? null])).toEqual([
      ['ASKED', null],
      ['FILLED', 'TR-0019'],
    ]);
    expect(asks[0]).toMatchObject({ place: { name: 'Truck 1' }, askedBy: { name: 'Kim Example' }, lines: [{ code: 'FLT-16251', quantity: 4 }] });
  });
});

describe('the routes', () => {
  const permissionsOf = (name: string) => Reflect.getMetadata(PERMISSIONS_METADATA_KEY, (TruckStockController.prototype as unknown as Record<string, object>)[name]!) as string[];

  it('reads with inventory:read and sets what is kept with inventory:manage, which no API key holds', () => {
    expect(permissionsOf('asks')).toEqual(['inventory:read']);
    expect(permissionsOf('keepLevels')).toEqual(['inventory:read']);
    expect(permissionsOf('saveKeepLevels')).toEqual(['inventory:read', 'inventory:manage']);
    expect(MACHINE_FORBIDDEN_PERMISSIONS).toContain('inventory:manage');
  });

  it('takes the levels the page sends and nothing else', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const check = (body: unknown) => pipe.transform(body, { type: 'body', metatype: SaveTruckKeepLevelsDto });
    await expect(check({ levels: [{ itemId: FILTER, keepAtLeast: 6 }, { itemId: BATTERY, keepAtLeast: null }] })).resolves.toBeDefined();
    await expect(check({ levels: [{ itemId: FILTER, keepAtLeast: -1 }] })).rejects.toBeTruthy();
    await expect(check({ levels: [{ itemId: FILTER, keepAtLeast: 6, placeId: TRUCK }] })).rejects.toBeTruthy();
  });
});
