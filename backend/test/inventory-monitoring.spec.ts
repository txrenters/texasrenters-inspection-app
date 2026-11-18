import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { InventoryMonitoringController, InventoryMonitoringQueryDto } from '../src/admin/inventory-monitoring.controller';
import { InventoryMonitoringService } from '../src/admin/inventory-monitoring.service';
import { PERMISSIONS_METADATA_KEY, type AuthenticatedUser } from '../src/common/auth';

/**
 * Reorder and usage, phase 7 (2026-11-19). Every id, name, code and figure
 * here is invented. The three sums the database makes are given here as the
 * rows it would return; that the statements themselves add up a real ledger
 * is checked against a real Postgres outside this suite. This one covers what
 * the service makes of them.
 */

const ORG = 'a0000000-0000-4000-8000-000000000001';
const id = (n: number) => `a0000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`;
const FILTER = id(1);
const BATTERY = id(2);
const FLEA = id(3);
const GLUE = id(4);
const ANA = id(21);
const BEN = id(22);
const HOMES = 'tenant-homes';

const reader = { id: id(801), organizationId: ORG, displayName: 'Sample Reader', roles: [UserRole.INSPECTION_SUPERVISOR], permissions: ['inventory:read'], principalType: 'USER' } as unknown as AuthenticatedUser;

type Row = Record<string, unknown>;

function database(over: { moved?: Row[]; technicians?: Row[]; jobs?: Row[] } = {}) {
  const vendor = { id: id(31), name: 'Hill Country Supply' };
  const items: Row[] = [
    { id: FILTER, code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each', xeroTenantId: HOMES, reorderLevel: 18, reorderQuantity: 36, usualVendor: vendor },
    { id: BATTERY, code: 'PRT-0001', name: 'Battery, 9 V', unit: 'each', xeroTenantId: HOMES, reorderLevel: 12, reorderQuantity: 0, usualVendor: null },
    { id: FLEA, code: 'PST-0002', name: 'Flea treatment, 1 qt', unit: 'bottle', xeroTenantId: null, reorderLevel: 4, reorderQuantity: 6, usualVendor: null },
    // Plenty on hand: not on the list.
    { id: GLUE, code: 'PST-0001', name: 'Glue boards', unit: 'pack', xeroTenantId: null, reorderLevel: 8, reorderQuantity: 12, usualVendor: null },
  ];
  const levels = [
    { itemId: BATTERY, _sum: { quantity: 5 } },
    { itemId: FLEA, _sum: { quantity: 2 } },
    { itemId: GLUE, _sum: { quantity: 14 } },
  ];
  const moved = over.moved ?? [
    // 30 filters and 15 batteries taken out, 2 batteries brought back, over 30 days.
    { kind: 'WITHDRAWAL', itemId: FILTER, quantity: -30, value: BigInt(-12000) },
    { kind: 'WITHDRAWAL', itemId: BATTERY, quantity: -15, value: BigInt(-2775) },
    { kind: 'RETURN', itemId: BATTERY, quantity: 2, value: BigInt(370) },
    { kind: 'RECEIPT', itemId: FILTER, quantity: 36, value: BigInt(14040) },
    { kind: 'COUNT_ADJUSTMENT', itemId: FLEA, quantity: -2, value: BigInt(-5700) },
    { kind: 'COUNT_ADJUSTMENT', itemId: GLUE, quantity: 1, value: BigInt(910) },
    { kind: 'OPENING_BALANCE', itemId: GLUE, quantity: 14, value: BigInt(12740) },
    { kind: 'TRANSFER', itemId: FILTER, quantity: 0, value: BigInt(0) },
  ];
  const technicians = over.technicians ?? [
    { technicianId: BEN, slips: 3, value: BigInt(3105) },
    { technicianId: ANA, slips: 7, value: BigInt(11300) },
  ];
  const jobs = over.jobs ?? [
    { job: null, visits: 0, value: BigInt(2150) },
    { job: 'PEST_CONTROL', visits: 4, value: BigInt(3255) },
    { job: 'HVAC_FILTER', visits: 20, value: BigInt(9000) },
  ];
  const db = {
    stockItem: { findMany: jest.fn(async () => items) },
    stockLevel: { groupBy: jest.fn(async () => levels) },
    purchaseOrderLine: { findMany: jest.fn(async () => [{ itemId: FLEA, quantity: 6, receivedQuantity: 0 }, { itemId: FILTER, quantity: 36, receivedQuantity: 36 }, { itemId: BATTERY, quantity: 24, receivedQuantity: 20 }]) },
    userProfile: { findMany: jest.fn(async () => [{ id: ANA, displayName: 'Ana Sample' }, { id: BEN, displayName: 'Ben Sample' }]) },
    xeroOrganisation: { findMany: jest.fn(async () => [{ xeroTenantId: HOMES, name: 'Example Home Services LLC' }]) },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      void values;
      const sql = strings.join('?');
      return sql.includes('"StockMovement" moved') ? moved : sql.includes('visit."inspectionType"') ? jobs : technicians;
    }),
  };
  return { db, service: new InventoryMonitoringService(db as never) };
}

// "Today" is the Texas day 2026-11-19 whatever the machine's clock says: only the date is held still, so nothing waits on a timer.
beforeAll(() => {
  jest.useFakeTimers({ now: new Date('2026-11-19T18:00:00.000Z'), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'performance', 'hrtime'] });
});
afterAll(() => {
  jest.useRealTimers();
});

describe('what to reorder', () => {
  it('lists each item at or below its reorder level, with what is on order, how long it lasts and what to ask for', async () => {
    const { service } = database();
    const { reorder } = await service.report(reader);

    expect(reorder.map((row) => row.code)).toEqual(['FLT-0003', 'PRT-0001', 'PST-0002']);
    // None on hand, 30 used in 30 days: gone already. Its usual order is 36.
    expect(reorder[0]).toMatchObject({ status: 'OUT', onHand: 0, reorderLevel: 18, onOrder: 0, used: 30, lastsDays: 0, suggested: 36, usualVendor: { name: 'Hill Country Supply' }, company: { tenantId: HOMES, name: 'Example Home Services LLC' } });
    // 5 on hand, 13 used (15 out, 2 back) in 30 days: about 11 days. 4 of an order are still to come. No usual quantity: enough to get above 12.
    expect(reorder[1]).toMatchObject({ status: 'LOW', onHand: 5, onOrder: 4, used: 13, lastsDays: 11, suggested: 8, usualVendor: null });
    // None was taken out, so nobody can say how long it lasts; 6 are on order.
    expect(reorder[2]).toMatchObject({ onHand: 2, onOrder: 6, used: 0, lastsDays: null, suggested: 6, company: null });
  });

  it('asks only for the orders of the items on the list, and for none when nothing is low', async () => {
    const { db, service } = database();
    await service.report(reader);
    expect(db.purchaseOrderLine.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG, itemId: { in: [FILTER, BATTERY, FLEA] }, order: { status: { in: ['APPROVED', 'SENT', 'PARTLY_RECEIVED'] } } }) }));

    const full = database();
    full.db.stockLevel.groupBy.mockResolvedValue([FILTER, BATTERY, FLEA, GLUE].map((itemId) => ({ itemId, _sum: { quantity: 99 } })));
    expect((await full.service.report(reader)).reorder).toEqual([]);
    expect(full.db.purchaseOrderLine.findMany).not.toHaveBeenCalled();
  });
});

describe('what the materials came to', () => {
  it('adds up what was used, bought and lost in counts over the period', async () => {
    const { service } = database();
    const report = await service.report(reader);
    // $120.00 + $27.75 out, $3.70 back.
    expect(report).toMatchObject({ period: '30d', from: '2026-10-21', to: '2026-11-19', usedCents: 14405, boughtCents: 14040, lostInCountsCents: 4790 });
  });

  it('ranks the technicians by what they used, and the kinds of job, with what no visit was named for last', async () => {
    const { service } = database();
    const report = await service.report(reader);
    expect(report.byTechnician).toEqual([
      { technicianId: ANA, name: 'Ana Sample', valueCents: 11300, slips: 7 },
      { technicianId: BEN, name: 'Ben Sample', valueCents: 3105, slips: 3 },
    ]);
    expect(report.byJob).toEqual([
      { job: 'Hvac filter', visits: 20, valueCents: 9000 },
      { job: 'Pest control', visits: 4, valueCents: 3255 },
      { job: null, visits: 0, valueCents: 2150 },
    ]);
  });

  it('is nothing at all for an office that has moved nothing', async () => {
    const { db, service } = database({ moved: [], technicians: [], jobs: [] });
    const report = await service.report(reader);
    expect(report).toMatchObject({ usedCents: 0, boughtCents: 0, lostInCountsCents: 0, byTechnician: [], byJob: [] });
    expect(db.userProfile.findMany).not.toHaveBeenCalled();
  });

  it('counts from the first Texas moment of the period, for this office only', async () => {
    const { db, service } = database();
    await service.report(reader, 'quarter');
    await service.report(reader, 'year');
    const since = db.$queryRaw.mock.calls.map((call) => (call[2] as Date).toISOString());
    // Three sums a report: 30 days (not asked here), the quarter from October 1 and the year from January 1, at midnight in Texas.
    expect(new Set(since)).toEqual(new Set(['2026-10-01T05:00:00.000Z', '2026-01-01T06:00:00.000Z']));
    expect(db.$queryRaw.mock.calls.every((call) => call[1] === ORG)).toBe(true);
    expect((await service.report(reader, 'quarter')).from).toBe('2026-10-01');
  });

  it('makes nine reads at most, whatever there is to add up', async () => {
    const { db, service } = database();
    await service.report(reader);
    const reads = [db.stockItem.findMany, db.stockLevel.groupBy, db.purchaseOrderLine.findMany, db.userProfile.findMany, db.xeroOrganisation.findMany, db.$queryRaw].reduce((sum, read) => sum + read.mock.calls.length, 0);
    expect(reads).toBe(8);
  });
});

describe('what the API accepts', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (value: unknown) => pipe.transform(value, { type: 'query', metatype: InventoryMonitoringQueryDto });

  it('takes a period it knows, or none', async () => {
    await expect(check({})).resolves.toBeDefined();
    await expect(check({ period: 'quarter' })).resolves.toMatchObject({ period: 'quarter' });
    await expect(check({ period: 'decade' })).rejects.toBeDefined();
    await expect(check({ organizationId: ORG })).rejects.toBeDefined();
  });

  it('is read by anybody who sees the inventory', () => {
    expect(Reflect.getMetadata(PERMISSIONS_METADATA_KEY, InventoryMonitoringController.prototype.report)).toEqual(['inventory:read']);
  });
});
