import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { STOCK_IMPORT_COLUMNS, type StockImportInput, type StockImportRow } from '@texasrenters/shared';

import { InventoryImportController, StockImportDto } from '../src/admin/inventory-import.controller';
import { InventoryImportService } from '../src/admin/inventory-import.service';
import type { AuthenticatedUser } from '../src/common/auth';
import { businessDate } from '../src/common/business-day';

/**
 * The stock import (2026-11-23): the office's stock from a spreadsheet, each
 * row an item at a place. A new code is made from its row; every row sets an
 * opening balance; nothing is saved until every row is right. Every id, code,
 * place and price here is invented.
 */

const ORG = '71000000-0000-4000-8000-000000000001';
const id = (n: number) => `71000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`;
const FILTER = id(1);
const STORE = id(11);
const TRUCK = id(12);
const SHED = id(13);
const FILTERS = id(21);
const KEY = id(90);

const keeper: AuthenticatedUser = {
  id: id(901),
  authUserId: 'auth-keeper',
  organizationId: ORG,
  displayName: 'Sample Keeper',
  roles: [UserRole.INSPECTION_SUPERVISOR],
  permissions: ['inventory:read', 'inventory:manage'],
  mustChangePassword: false,
  principalType: 'USER',
} as AuthenticatedUser;

type Row = Record<string, unknown>;

function database() {
  const items: Row[] = [{ id: FILTER, organizationId: ORG, code: 'FLT-16251', codeKey: 'flt-16251', name: 'Filter 16x25x1', active: true }];
  const places: Row[] = [
    { id: STORE, organizationId: ORG, code: 'STORE', name: 'Office Storeroom', active: true },
    { id: TRUCK, organizationId: ORG, code: 'TRK-01', name: 'Truck 1', active: true },
    { id: SHED, organizationId: ORG, code: 'SHED', name: 'Old shed', active: false },
  ];
  const movements: Row[] = [];
  const audits: Row[] = [];
  let yearly: { number: string } | null = null;
  const db = {
    stockItem: {
      findMany: jest.fn(async ({ where }: { where: { codeKey: { in: string[] } } }) => items.filter((item) => where.codeKey.in.includes(item.codeKey as string))),
      createMany: jest.fn(async ({ data }: { data: Row[] }) => {
        items.push(...data);
        return { count: data.length };
      }),
    },
    stockPlace: { findMany: jest.fn(async () => places) },
    stockCategory: { findMany: jest.fn(async () => [{ id: FILTERS, name: 'Filters', prefix: 'FLT' }]) },
    purchasingCode: {
      findMany: jest.fn(async ({ where }: { where: Row }) =>
        where.kind === 'UNIT' ? [{ name: 'each' }, { name: 'box' }] : [{ id: id(31), code: 'ITEM', keepsStock: true }],
      ),
      findFirst: jest.fn(async () => ({ id: id(31) })),
      createMany: jest.fn(async () => ({ count: 0 })),
    },
    xeroOrganisation: { findMany: jest.fn(async () => [{ xeroTenantId: 'tenant-thmp', name: 'Texas Home Maintenance Pros', purchaserCode: 'THMP' }]) },
    vendor: { findMany: jest.fn(async () => [{ id: id(41), number: 'V-00003', name: 'Hill Country Supply' }]) },
    stockCount: { findFirst: jest.fn(async () => yearly) },
    stockMovement: {
      findMany: jest.fn(async ({ where }: { where: { itemId: { in: string[] } } }) =>
        movements.filter((movement) => where.itemId.in.includes(movement.itemId as string)).map(({ itemId, placeId }) => ({ itemId, placeId })),
      ),
      findFirst: jest.fn(async ({ where }: { where: { requestKey: { startsWith: string } } }) => movements.find((movement) => String(movement.requestKey).startsWith(where.requestKey.startsWith)) ?? null),
      createMany: jest.fn(async ({ data }: { data: Row[] }) => {
        movements.push(...data);
        return { count: data.length };
      }),
    },
    auditLog: {
      create: jest.fn(async ({ data }: { data: Row }) => audits.push(data)),
      findFirst: jest.fn(async ({ where }: { where: Row }) => audits.find((audit) => audit.entityId === where.entityId) ?? null),
    },
    // Purchasing Setup: nothing saved, so whoever manages inventory keeps the item codes, as before Setup.
    purchasingSettings: { findUnique: jest.fn(async (): Promise<unknown> => null) },
    purchasingApprovalStep: { findMany: jest.fn(async () => []) },
    $queryRaw: jest.fn(async () => []),
  };
  const client: unknown = Object.assign(db, { $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work(client)) });
  return {
    db,
    items,
    movements,
    audits,
    openYearly: () => (yearly = { number: 'CNT-0009' }),
    service: new InventoryImportService(db as never),
  };
}

const blank = Object.fromEntries(STOCK_IMPORT_COLUMNS.map((column) => [column.key, ''])) as Omit<StockImportRow, 'line'>;
const row = (line: number, over: Partial<StockImportRow>): StockImportRow => ({ ...blank, line, ...over });
const NEW_BATTERY = { code: 'bat-9v', description: 'Battery, 9 V', category: 'Filters', unit: 'Each', company: 'THMP', place: 'Truck 1', quantity: '6', unitCost: '$1.85', price: '2.10', vendor: 'V-00003' };
const file = (rows: StockImportRow[], over: Partial<StockImportInput> = {}): StockImportInput => ({ rows, day: '2026-11-20', fileName: 'stock.xlsx', requestKey: KEY, ...over });

describe('checking a stock import', () => {
  it('reads each row against the office: a new code is made from its row, a code already made only takes stock', async () => {
    const { service, movements, items } = database();
    const check = await service.check(keeper, file([row(2, { code: 'FLT-16251', place: 'STORE', quantity: '24', unitCost: '3.90' }), row(3, NEW_BATTERY), row(4, { code: 'BAT-9V', place: 'office storeroom', quantity: '1,200', unitCost: '1.85' })]));
    expect(check).toMatchObject({ ready: true, problems: [], newItems: 1, existingItems: 1, totalQuantity: 1230, totalValueCents: 24 * 390 + 6 * 185 + 1200 * 185 });
    expect(check.rows.map((one) => [one.line, one.code, one.item, one.place])).toEqual([
      [2, 'FLT-16251', 'EXISTING', 'Office Storeroom'],
      [3, 'BAT-9V', 'NEW', 'Truck 1'],
      [4, 'BAT-9V', 'NEW', 'Office Storeroom'],
    ]);
    // A check writes nothing.
    expect(movements).toHaveLength(0);
    expect(items).toHaveLength(1);
  });

  it('says what is wrong, row by row, and is not ready while anything is', async () => {
    const { service, movements } = database();
    movements.push({ itemId: FILTER, placeId: STORE, requestKey: 'earlier' });
    const check = await service.check(
      keeper,
      file([
        row(2, { code: 'FLT-16251', place: 'STORE', quantity: '24', unitCost: '3.90' }),
        row(3, { code: 'FLT#1', place: 'Moon', quantity: '2.5', unitCost: 'free' }),
        row(4, { code: 'GLU-1', place: 'SHED', quantity: '3', unitCost: '9' }),
        row(5, { ...NEW_BATTERY, unit: 'pallet', company: 'Somebody else', vendor: 'Nobody' }),
        row(6, { ...NEW_BATTERY, description: 'Battery, AA' }),
        row(7, { ...NEW_BATTERY }),
      ]),
    );
    expect(check.ready).toBe(false);
    const said = Object.fromEntries(check.rows.map((one) => [one.line, one.problems]));
    expect(said[2]).toEqual(['FLT-16251 already has an opening balance in Office Storeroom. Reverse that one first to enter another.']);
    expect(said[3]).toEqual([
      '"FLT#1" is not an item code: 2 to 24 capitals, digits and dashes, like FLT-16251.',
      'The quantity is a whole number above 0.',
      'The unit cost is an amount of dollars, like 3.90.',
      '"Moon" is not one of the places.',
    ]);
    expect(said[4]).toEqual(['Old shed is switched off.', 'GLU-1 is new: give its description.', 'GLU-1 is new: give its category.', 'GLU-1 is new: give its unit of measure.', 'GLU-1 is new: give the company it is bought for.']);
    expect(said[5]).toEqual(['"pallet" is not one of the units of measure: each, box.', '"Somebody else" is not one of the companies.', '"Nobody" is not one of the vendors.']);
    // Row 5 made nothing, so row 6 is the battery's first, as "Battery, AA"; row 7 says otherwise, at the same truck again.
    expect(said[6]).toEqual([]);
    expect(said[7]).toEqual(['BAT-9V is described differently on an earlier row.', 'BAT-9V at Truck 1 is on an earlier row too.']);
  });

  it('refuses the whole file while a yearly count is open, a day ahead, or for somebody who does not keep the item codes', async () => {
    const frozen = database();
    frozen.openYearly();
    expect((await frozen.service.check(keeper, file([row(2, NEW_BATTERY)]))).problems).toEqual(['The yearly count CNT-0009 is open, so stock cannot move until it is posted or cancelled.']);

    const { service, db } = database();
    expect((await service.check(keeper, file([row(2, NEW_BATTERY)], { day: '2999-01-01' }))).problems[0]).toMatch(/^The stock cannot be as of a day after today/);
    // Setup gives the item codes to the code admin, which the keeper here is not.
    db.purchasingSettings.findUnique.mockResolvedValue({
      approvalLimitCents: 50000,
      quotesAboveLimit: 2,
      emailApprovers: false,
      reapproveChangedOrders: false,
      approverOwnCompaniesOnly: true,
      fileGroups: ['PDF'],
      fileMaxBytes: 20_000_000,
      filesMax: 20,
      quoteFileAboveCents: null,
      fileRemoval: 'UNTIL_SENT',
      codeKeepers: { ITEMS: 'CODE_ADMIN' },
      requisitionPage: {},
    } as never);
    const check = await service.check(keeper, file([row(2, NEW_BATTERY)]));
    expect(check.ready).toBe(false);
    expect(check.problems.at(-1)).toMatch(/The file makes 1 new item code\.$/);
  });
});

describe('importing it', () => {
  it('writes every item and opening balance at once, audited once, and a second press writes nothing more', async () => {
    const { service, items, movements, audits } = database();
    const input = file([row(2, { code: 'FLT-16251', place: 'STORE', quantity: '24', unitCost: '3.90' }), row(3, NEW_BATTERY), row(4, { code: 'BAT-9V', place: 'STORE', quantity: '12', unitCost: '1.85' })]);
    expect(await service.import(keeper, input)).toEqual({ rows: 3, newItems: 1, totalValueCents: 24 * 390 + 6 * 185 + 12 * 185 });

    const battery = items.find((item) => item.code === 'BAT-9V')!;
    expect(battery).toMatchObject({ codeKey: 'bat-9v', name: 'Battery, 9 V', unit: 'each', categoryId: FILTERS, xeroTenantId: 'tenant-thmp', priceCents: 210, usualVendorId: id(41), lineTypeId: id(31) });
    expect(movements.map((movement) => [movement.itemId, movement.placeId, movement.quantity, movement.unitCostCents, movement.kind, movement.requestKey])).toEqual([
      [FILTER, STORE, 24, 390, 'OPENING_BALANCE', `${KEY}:2`],
      [battery.id, TRUCK, 6, 185, 'OPENING_BALANCE', `${KEY}:3`],
      [battery.id, STORE, 12, 185, 'OPENING_BALANCE', `${KEY}:4`],
    ]);
    expect(movements[0]).toMatchObject({ day: new Date('2026-11-20T00:00:00.000Z'), note: 'Imported from stock.xlsx, row 2', createdByName: 'Sample Keeper' });
    expect(audits).toEqual([expect.objectContaining({ action: 'STOCK_IMPORTED', entityType: 'StockImport', entityId: KEY, metadata: expect.objectContaining({ rows: 3, newItems: 1, codesMade: ['BAT-9V'], day: '2026-11-20' }) })]);

    expect(await service.import(keeper, input)).toEqual({ rows: 3, newItems: 1, totalValueCents: 24 * 390 + 6 * 185 + 12 * 185 });
    expect(movements).toHaveLength(3);
    expect(audits).toHaveLength(1);
  });

  it('writes nothing while anything in the file is wrong', async () => {
    const { service, items, movements } = database();
    await expect(service.import(keeper, file([row(2, NEW_BATTERY), row(3, { code: 'GLU-1', place: 'Moon', quantity: '3', unitCost: '9' })]))).rejects.toMatchObject({
      code: 'STOCK_IMPORT_NOT_READY',
    });
    expect(items).toHaveLength(1);
    expect(movements).toHaveLength(0);
  });

  it('dates the stock today when no day is given, and needs its request key', async () => {
    const { service, movements } = database();
    await expect(service.import(keeper, file([row(2, NEW_BATTERY)], { requestKey: undefined }))).rejects.toMatchObject({ code: 'STOCK_IMPORT_KEY_NEEDED' });
    await service.import(keeper, file([row(2, NEW_BATTERY)], { day: undefined }));
    expect(movements[0]!.day).toEqual(new Date(`${businessDate()}T00:00:00.000Z`));
  });
});

describe('the requests the page sends', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (body: unknown) => pipe.transform(body, { type: 'body', metatype: StockImportDto });

  it('name every column of a row, and need Manage inventory', async () => {
    const body: Required<StockImportInput> = { rows: [row(2, NEW_BATTERY)], day: '2026-11-20', fileName: 'stock.xlsx', requestKey: KEY };
    await expect(check(body)).resolves.toBeDefined();
    await expect(check({ ...body, rows: [{ ...row(2, NEW_BATTERY), colour: 'red' }] })).rejects.toBeDefined();
    const permissionsOf = (method: 'check' | 'import') => Reflect.getMetadata('permissions', InventoryImportController.prototype[method]) as string[];
    expect(permissionsOf('check')).toEqual(['inventory:read', 'inventory:manage']);
    expect(permissionsOf('import')).toEqual(['inventory:read', 'inventory:manage']);
  });
});
