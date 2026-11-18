import { ValidationPipe } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import {
  MACHINE_FORBIDDEN_PERMISSIONS,
  type OpeningBalanceInput,
  type ReverseMovementInput,
  type SaveStockCategoryInput,
  type SaveStockItemInput,
  type SaveStockPlaceInput,
  type SaveVendorInput,
} from '@texasrenters/shared';

import { InventoryController, OpeningBalanceDto, ReverseMovementDto, SaveStockCategoryDto, SaveStockItemDto, SaveStockPlaceDto, SaveVendorDto } from '../src/admin/inventory.controller';
import { InventoryService } from '../src/admin/inventory.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Inventory, phase 1 (2026-11-19): items, places, vendors and the stock
 * ledger. Every id, name, code and price here is invented.
 *
 * The database below keeps levels the way the real one does -- added up from
 * the movements as each is written -- so these tests would catch a service
 * that wrote on hand itself. What only the real database does (refusing an
 * UPDATE or DELETE of a movement, refusing a level below nothing) is in the
 * migration and is not exercised here.
 */

const ORG = '70000000-0000-4000-8000-000000000001';
const OTHER_ORG = '70000000-0000-4000-8000-000000000002';
const TECH = '70000000-0000-4000-8000-000000000003';
const STRANGER = '70000000-0000-4000-8000-000000000004';
const THMP = 'tenant-thmp';
const id = (n: number) => `70000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`;
const FILTER = id(1);
const BATTERY = id(2);
const THEIRS = id(3);
const STOCKROOM = id(11);
const VAN = id(12);
const CLOSED = id(13);
const KEY = id(90);
const FILTERS = id(31);
const RETIRED = id(32);

const office: AuthenticatedUser = {
  id: '70000000-0000-4000-8000-000000000009',
  authUserId: 'auth-office',
  organizationId: ORG,
  displayName: 'Office Coordinator',
  roles: [UserRole.INSPECTION_SUPERVISOR],
  permissions: ['inventory:read', 'inventory:manage'],
  mustChangePassword: false,
  principalType: 'USER',
} as AuthenticatedUser;

type Row = Record<string, unknown>;

function database() {
  const items: Row[] = [
    { id: FILTER, organizationId: ORG, code: 'FLT-16251', codeKey: 'flt-16251', name: 'Filter 16x25x1', unit: 'each', categoryId: FILTERS, category: { id: FILTERS, name: 'Filters' }, xeroTenantId: THMP, reorderLevel: 24, reorderQuantity: 48, active: true, usualVendor: null },
    { id: BATTERY, organizationId: ORG, code: 'BAT-9V', codeKey: 'bat-9v', name: 'Battery, 9 V', unit: 'each', categoryId: null, category: null, xeroTenantId: null, reorderLevel: 12, reorderQuantity: 24, active: true, usualVendor: null },
    { id: THEIRS, organizationId: OTHER_ORG, code: 'X-1', codeKey: 'x-1', name: 'Another office\'s item', unit: 'each', categoryId: null, category: null, xeroTenantId: null, reorderLevel: 0, reorderQuantity: 0, active: true, usualVendor: null },
  ];
  const places: Row[] = [
    { id: STOCKROOM, organizationId: ORG, name: 'Stockroom', kind: 'STOCKROOM', technicianId: null, technician: null, active: true },
    { id: VAN, organizationId: ORG, name: 'Van 1', kind: 'VAN', technicianId: TECH, technician: { displayName: 'Sample Technician' }, active: true },
    { id: CLOSED, organizationId: ORG, name: 'Old shed', kind: 'STOCKROOM', technicianId: null, technician: null, active: false },
  ];
  const categories: Row[] = [
    { id: FILTERS, organizationId: ORG, name: 'Filters', nameKey: 'filters', prefix: 'FLT', nextNumber: 3, active: true },
    { id: RETIRED, organizationId: ORG, name: 'Old parts', nameKey: 'old parts', prefix: 'OLD', nextNumber: 1, active: false },
  ];
  const vendors: Row[] = [];
  const movements: Row[] = [];
  const audits: Row[] = [];
  let clock = Date.parse('2026-11-19T15:00:00.000Z');

  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) => {
      if (value === undefined || key === 'userProfile') return true;
      if (key === 'reversedBy') return !movements.some((other) => other.reversesId === row.id);
      // `{ not: x }`: any row but that one.
      if (value !== null && typeof value === 'object' && 'not' in value) return row[key] !== (value as { not: unknown }).not;
      return row[key] === value;
    });
  const levels = (where: Row) => {
    const byKey = new Map<string, Row>();
    for (const movement of movements) {
      const key = `${String(movement.itemId)}|${String(movement.placeId)}`;
      const level = byKey.get(key) ?? { organizationId: movement.organizationId, itemId: movement.itemId, placeId: movement.placeId, quantity: 0, valueCents: 0 };
      level.quantity = (level.quantity as number) + (movement.quantity as number);
      level.valueCents = (level.valueCents as number) + (movement.quantity as number) * (movement.unitCostCents as number);
      byKey.set(key, level);
    }
    return [...byKey.values()].filter((level) => matches(level, where));
  };
  const whole = (movement: Row) => ({
    ...movement,
    reversedBy: (movements.find((other) => other.reversesId === movement.id) as { id: string } | undefined) ?? null,
    item: items.find((item) => item.id === movement.itemId),
    place: places.find((place) => place.id === movement.placeId),
  });
  /** The items a purchase requisition has asked for. */
  const requested: string[] = [];
  const table = (rows: Row[], create?: (data: Row) => Row) => ({
    findMany: jest.fn(async ({ where }: { where: Row }) => rows.filter((row) => matches(row, where))),
    findFirst: jest.fn(async ({ where }: { where: Row }) => rows.find((row) => matches(row, where)) ?? null),
    create: jest.fn(async ({ data }: { data: Row }) => {
      const row = create ? create(data) : { id: id(100 + rows.length), active: true, ...data };
      rows.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(rows.find((row) => row.id === where.id)!, data)),
  });

  const db = {
    stockItem: table(items, (data) => {
      const category = categories.find((row) => row.id === data.categoryId);
      return { id: id(100 + items.length), active: true, usualVendor: null, category: category ? { id: category.id, name: category.name } : null, ...data };
    }),
    stockCategory: {
      ...table(categories, (data) => ({ id: id(200 + categories.length), nextNumber: 1, active: true, ...data })),
      findMany: jest.fn(async ({ where }: { where: Row & { id?: { not: string } } }) =>
        categories
          .filter((row) => row.organizationId === where.organizationId && row.id !== where.id?.not)
          .map((row) => ({ ...row, _count: { items: items.filter((item) => item.categoryId === row.id).length } })),
      ),
    },
    stockPlace: table(places, (data) => ({ id: id(100 + places.length), active: true, technician: null, ...data })),
    vendor: table(vendors),
    stockMovement: {
      findFirst: jest.fn(async ({ where }: { where: Row }) => {
        const found = movements.find((row) => matches(row, where));
        return found ? whole(found) : null;
      }),
      findMany: jest.fn(async ({ where }: { where: Row }) => movements.filter((row) => matches(row, where)).map(whole).reverse()),
      count: jest.fn(async ({ where }: { where: Row }) => movements.filter((row) => matches(row, where)).length),
      create: jest.fn(async ({ data }: { data: Row }) => {
        if (data.reversesId && movements.some((row) => row.reversesId === data.reversesId))
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
        const row = { id: id(500 + movements.length), reversesId: null, requestKey: null, note: null, createdAt: new Date((clock += 1000)), ...data };
        movements.push(row);
        return row;
      }),
    },
    stockLevel: {
      findMany: jest.fn(async ({ where }: { where: Row }) => levels(where)),
      findUnique: jest.fn(async ({ where }: { where: { itemId_placeId: Row } }) => levels(where.itemId_placeId)[0] ?? null),
      aggregate: jest.fn(async ({ where }: { where: Row }) => ({ _sum: { quantity: levels(where).reduce((sum, level) => sum + (level.quantity as number), 0) } })),
      // How many different items each place has any of.
      groupBy: jest.fn(async ({ where }: { where: Row }) => {
        const held = new Map<unknown, number>();
        for (const level of levels({ organizationId: where.organizationId })) if ((level.quantity as number) > 0) held.set(level.placeId, (held.get(level.placeId) ?? 0) + 1);
        return [...held].map(([placeId, all]) => ({ placeId, _count: { _all: all } }));
      }),
    },
    xeroOrganisation: {
      findMany: jest.fn(async () => [{ xeroTenantId: THMP, name: 'THMP', status: 'CONNECTED' }]),
      findFirst: jest.fn(async ({ where }: { where: Row }) => (where.xeroTenantId === THMP ? { id: 'x', xeroTenantId: THMP, name: 'THMP' } : null)),
    },
    organizationMember: {
      findMany: jest.fn(async () => [{ userProfile: { id: TECH, displayName: 'Sample Technician' } }]),
      findFirst: jest.fn(async ({ where }: { where: Row }) => (where.userProfileId === TECH ? { id: 'member' } : null)),
    },
    // No yearly count is open, so stock moves (stock-counts.spec.ts covers the freeze).
    stockCount: { findFirst: jest.fn(async (): Promise<{ number: string } | null> => null) },
    // The papers that name an item: once any does, its code stays.
    purchaseRequisitionLine: { count: jest.fn(async ({ where }: { where: Row }) => requested.filter((itemId) => itemId === where.itemId).length) },
    purchaseOrderLine: { count: jest.fn(async () => 0) },
    auditLog: { create: jest.fn(async ({ data }: { data: Row }) => audits.push(data)) },
    // The advisory lock answers nothing; taking a category's next number answers the number taken.
    $queryRaw: jest.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      if (!sql.join('').includes('StockCategory')) return [];
      const category = categories.find((row) => row.id === values[0])!;
      category.nextNumber = (category.nextNumber as number) + 1;
      return [{ taken: (category.nextNumber as number) - 1 }];
    }),
  };
  const transaction = { $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => work(client)) };
  const client: unknown = Object.assign(db, transaction);
  return { db, movements, audits, items, places, vendors, categories, service: new InventoryService(db as never) };
}

const opening = (over: Partial<OpeningBalanceInput> = {}): OpeningBalanceInput => ({ placeId: STOCKROOM, quantity: 18, unitCostCents: 342, day: '2026-11-18', requestKey: KEY, ...over });

describe('what is on hand', () => {
  it('is the movements added up, split between stockrooms and vans, at what it cost', async () => {
    const { service } = database();
    await service.enterOpeningBalance(office, FILTER, opening());
    await service.enterOpeningBalance(office, FILTER, opening({ placeId: VAN, quantity: 5, unitCostCents: 360, requestKey: id(91) }));

    const stock = await service.stock(office);
    const filter = stock.items.find((item) => item.id === FILTER)!;
    expect(filter).toMatchObject({ onHand: 23, inStockrooms: 18, inVans: 5, valueCents: 18 * 342 + 5 * 360, status: 'LOW', company: { tenantId: THMP, name: 'THMP' } });
    expect(stock.items.find((item) => item.id === BATTERY)).toMatchObject({ onHand: 0, status: 'OUT', company: null });
  });

  it('never shows another office its items', async () => {
    const { service } = database();
    expect((await service.stock(office)).items.map((item) => item.id)).toEqual([FILTER, BATTERY]);
    await expect(service.item(office, THEIRS)).rejects.toMatchObject({ code: 'STOCK_ITEM_NOT_FOUND' });
    await expect(service.enterOpeningBalance(office, THEIRS, opening())).rejects.toMatchObject({ code: 'STOCK_ITEM_NOT_FOUND' });
  });

  it('shows each movement with the on hand it left, newest first', async () => {
    const { service } = database();
    await service.enterOpeningBalance(office, FILTER, opening());
    const detail = await service.enterOpeningBalance(office, FILTER, opening({ placeId: VAN, quantity: 5, requestKey: id(91) }));

    expect(detail.movements.map((movement) => [movement.placeName, movement.quantity, movement.onHandAfter])).toEqual([
      ['Van 1', 5, 23],
      ['Stockroom', 18, 18],
    ]);
    expect(detail.averageCostCents).toBe(342);
    expect(detail.levels).toEqual([
      { placeId: STOCKROOM, placeName: 'Stockroom', kind: 'STOCKROOM', quantity: 18 },
      { placeId: VAN, placeName: 'Van 1', kind: 'VAN', quantity: 5 },
    ]);
  });
});

describe('an opening balance', () => {
  it('is one movement, with who entered it, and an audit entry', async () => {
    const { service, movements, audits } = database();
    await service.enterOpeningBalance(office, FILTER, opening({ note: '  counted on the shelf ' }));

    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ organizationId: ORG, itemId: FILTER, placeId: STOCKROOM, kind: 'OPENING_BALANCE', quantity: 18, unitCostCents: 342, note: 'counted on the shelf', createdById: office.id, createdByName: 'Office Coordinator' });
    expect((movements[0]!.day as Date).toISOString()).toBe('2026-11-18T00:00:00.000Z');
    expect(audits).toEqual([expect.objectContaining({ action: 'STOCK_OPENING_BALANCE_ENTERED', actorUserId: office.id, entityType: 'StockMovement' })]);
  });

  it('sent twice is written once', async () => {
    const { service, movements } = database();
    await service.enterOpeningBalance(office, FILTER, opening());
    const again = await service.enterOpeningBalance(office, FILTER, opening());

    expect(movements).toHaveLength(1);
    expect(again.item.onHand).toBe(18);
  });

  it('is entered once per item and place, until it is reversed', async () => {
    const { service, movements } = database();
    await service.enterOpeningBalance(office, FILTER, opening());
    await expect(service.enterOpeningBalance(office, FILTER, opening({ quantity: 20, requestKey: id(91) }))).rejects.toMatchObject({ code: 'STOCK_OPENING_BALANCE_EXISTS' });

    await service.reverseMovement(office, movements[0]!.id as string, { reason: 'Counted the wrong shelf' });
    const detail = await service.enterOpeningBalance(office, FILTER, opening({ quantity: 20, requestKey: id(92) }));
    expect(detail.item.onHand).toBe(20);
  });

  it('is refused for a place that is switched off, a place of nobody, a day ahead, or a key used for another item', async () => {
    const { service, movements } = database();
    await expect(service.enterOpeningBalance(office, FILTER, opening({ placeId: CLOSED }))).rejects.toMatchObject({ code: 'STOCK_SWITCHED_OFF' });
    await expect(service.enterOpeningBalance(office, FILTER, opening({ placeId: id(77) }))).rejects.toMatchObject({ code: 'STOCK_PLACE_NOT_FOUND' });
    await expect(service.enterOpeningBalance(office, FILTER, opening({ day: '2999-01-01' }))).rejects.toMatchObject({ code: 'STOCK_DAY_AHEAD' });
    expect(movements).toHaveLength(0);

    await service.enterOpeningBalance(office, FILTER, opening());
    await expect(service.enterOpeningBalance(office, BATTERY, opening())).rejects.toMatchObject({ code: 'STOCK_REQUEST_REUSED' });
  });
});

describe('reversing a movement', () => {
  it('adds an opposite movement at the same cost and leaves the first as written', async () => {
    const { service, movements, audits } = database();
    await service.enterOpeningBalance(office, FILTER, opening());
    const first = { ...movements[0]! };
    const detail = await service.reverseMovement(office, first.id as string, { reason: ' Counted the wrong shelf ' });

    expect(movements[0]).toEqual(first);
    expect(movements[1]).toMatchObject({ kind: 'REVERSAL', quantity: -18, unitCostCents: 342, reversesId: first.id, note: 'Counted the wrong shelf', placeId: STOCKROOM });
    expect(detail.item).toMatchObject({ onHand: 0, valueCents: 0 });
    expect(detail.movements[1]).toMatchObject({ id: first.id, reversedById: movements[1]!.id });
    expect(audits.at(-1)).toMatchObject({ action: 'STOCK_MOVEMENT_REVERSED', entityId: first.id, metadata: expect.objectContaining({ reason: 'Counted the wrong shelf' }) });
  });

  it('happens once, and a reversal is not reversed', async () => {
    const { service, movements } = database();
    await service.enterOpeningBalance(office, FILTER, opening());
    await service.reverseMovement(office, movements[0]!.id as string, { reason: 'Wrong' });

    await expect(service.reverseMovement(office, movements[0]!.id as string, { reason: 'Again' })).rejects.toMatchObject({ code: 'STOCK_MOVEMENT_ALREADY_REVERSED' });
    await expect(service.reverseMovement(office, movements[1]!.id as string, { reason: 'Undo' })).rejects.toMatchObject({ code: 'STOCK_REVERSAL_OF_REVERSAL' });
    expect(movements).toHaveLength(2);
  });

  it('says so when the database refuses a second reversal made at the same moment', async () => {
    const { service, movements, db } = database();
    await service.enterOpeningBalance(office, FILTER, opening());
    // Both requests read the movement before either wrote: the unique index is what stops the second.
    movements.push({ id: id(600), organizationId: OTHER_ORG, itemId: THEIRS, placeId: STOCKROOM, kind: 'REVERSAL', quantity: -18, unitCostCents: 342, reversesId: movements[0]!.id });
    db.stockMovement.findFirst.mockResolvedValueOnce({ ...movements[0]!, reversedBy: null, item: { code: 'FLT-16251' }, place: { name: 'Stockroom' } } as never);

    await expect(service.reverseMovement(office, movements[0]!.id as string, { reason: 'Wrong' })).rejects.toMatchObject({ code: 'STOCK_MOVEMENT_ALREADY_REVERSED' });
  });

  it('leaves goods received to their purchase order, where the receipt is reversed', async () => {
    const { service, movements } = database();
    movements.push({ id: id(700), organizationId: ORG, itemId: FILTER, placeId: STOCKROOM, kind: 'RECEIPT', quantity: 24, unitCostCents: 390, reversesId: null });

    await expect(service.reverseMovement(office, id(700), { reason: 'Wrong order' })).rejects.toMatchObject({ code: 'STOCK_MOVEMENT_HAS_DOCUMENT' });
    expect(movements).toHaveLength(1);
  });

  it('needs a reason, and a movement of this office', async () => {
    const { service, movements } = database();
    await service.enterOpeningBalance(office, FILTER, opening());
    await expect(service.reverseMovement(office, movements[0]!.id as string, { reason: '   ' })).rejects.toMatchObject({ code: 'STOCK_REVERSAL_NEEDS_REASON' });
    await expect(service.reverseMovement({ ...office, organizationId: OTHER_ORG }, movements[0]!.id as string, { reason: 'Wrong' })).rejects.toMatchObject({ code: 'STOCK_MOVEMENT_NOT_FOUND' });
  });
});

describe('items', () => {
  it('are given the next code of their category, and nobody types one', async () => {
    const { service, items, audits, categories } = database();
    const first = await service.createItem(office, { name: ' Filter  20x20x1 ', categoryId: FILTERS, reorderLevel: 24, xeroTenantId: THMP });

    expect(first.item).toMatchObject({ code: 'FLT-0003', name: 'Filter 20x20x1', category: { id: FILTERS, name: 'Filters' } });
    expect(items.at(-1)).toMatchObject({ organizationId: ORG, code: 'FLT-0003', codeKey: 'flt-0003', categoryId: FILTERS, unit: 'each', reorderLevel: 24, xeroTenantId: THMP });
    expect(audits).toEqual([expect.objectContaining({ action: 'STOCK_ITEM_CREATED', metadata: { code: 'FLT-0003', name: 'Filter 20x20x1' } })]);

    expect((await service.createItem(office, { name: 'Filter 20x25x1', categoryId: FILTERS })).item.code).toBe('FLT-0004');
    expect(categories[0]).toMatchObject({ nextNumber: 5 });
  });

  it('step over a code somebody typed before the console gave them', async () => {
    const { service, items } = database();
    items.push({ id: id(60), organizationId: ORG, code: 'flt-0003', codeKey: 'flt-0003', name: 'Typed by hand', unit: 'each', categoryId: null, category: null, xeroTenantId: null, reorderLevel: 0, reorderQuantity: 0, active: true, usualVendor: null });

    expect((await service.createItem(office, { name: 'Filter 20x20x1', categoryId: FILTERS })).item.code).toBe('FLT-0004');
  });

  it('need a name and a category in use, and a company and vendor of this office', async () => {
    const { service, items } = database();
    const before = items.length;
    await expect(service.createItem(office, { name: ' ', categoryId: FILTERS })).rejects.toMatchObject({ code: 'STOCK_ITEM_INCOMPLETE' });
    await expect(service.createItem(office, { name: 'No category' })).rejects.toMatchObject({ code: 'STOCK_ITEM_INCOMPLETE' });
    await expect(service.createItem(office, { name: 'New', categoryId: RETIRED })).rejects.toMatchObject({ code: 'STOCK_CATEGORY_NOT_FOUND' });
    await expect(service.createItem(office, { name: 'New', categoryId: id(79) })).rejects.toMatchObject({ code: 'STOCK_CATEGORY_NOT_FOUND' });
    await expect(service.createItem(office, { name: 'New', categoryId: FILTERS, xeroTenantId: 'tenant-of-another-office' })).rejects.toMatchObject({ code: 'STOCK_COMPANY_NOT_FOUND' });
    await expect(service.createItem(office, { name: 'New', categoryId: FILTERS, usualVendorId: id(70) })).rejects.toMatchObject({ code: 'VENDOR_NOT_FOUND' });
    expect(items).toHaveLength(before);
  });

  it('change only what was sent', async () => {
    const { service, items, audits } = database();
    // The validation pipe hands over every field the DTO names, undefined where none was sent.
    await service.updateItem(office, FILTER, { reorderLevel: 30, name: undefined, categoryId: undefined, xeroTenantId: undefined } as SaveStockItemInput);

    expect(items[0]).toMatchObject({ code: 'FLT-16251', name: 'Filter 16x25x1', categoryId: FILTERS, xeroTenantId: THMP, reorderLevel: 30 });
    expect(audits.at(-1)).toMatchObject({ action: 'STOCK_ITEM_CHANGED', metadata: { code: 'FLT-16251', changed: ['reorderLevel'] } });
  });

  it('keep the category their code came from; one from before categories may be given one, and keeps its code', async () => {
    const { service, items, categories } = database();
    categories.push({ id: id(33), organizationId: ORG, name: 'Parts', nameKey: 'parts', prefix: 'PRT', nextNumber: 1, active: true });

    await expect(service.updateItem(office, FILTER, { categoryId: id(33) })).rejects.toMatchObject({ code: 'STOCK_ITEM_CATEGORY_FIXED' });
    await expect(service.updateItem(office, BATTERY, { categoryId: id(79) })).rejects.toMatchObject({ code: 'STOCK_CATEGORY_NOT_FOUND' });
    await service.updateItem(office, BATTERY, { categoryId: id(33) });
    expect(items[1]).toMatchObject({ code: 'BAT-9V', categoryId: id(33) });
    expect(categories.at(-1)).toMatchObject({ nextNumber: 1 });
  });

  it('take the code the stock keeper types, in capitals, with what one usually costs', async () => {
    const { service, items, categories } = database();
    const made = await service.createItem(office, { code: ' flt-20201 ', name: 'Filter 20x20x1', unit: 'pcs', categoryId: FILTERS, priceCents: 360 });
    expect(made.item).toMatchObject({ code: 'FLT-20201', name: 'Filter 20x20x1', unit: 'pcs', priceCents: 360 });
    expect(items.at(-1)).toMatchObject({ code: 'FLT-20201', codeKey: 'flt-20201', priceCents: 360 });
    // A typed code takes no number from the category: the next suggestion is still FLT-0003.
    expect(categories[0]).toMatchObject({ nextNumber: 3 });
    // No price is no price, not nothing.
    expect((await service.createItem(office, { name: 'Filter 20x25x1', categoryId: FILTERS })).item).toMatchObject({ code: 'FLT-0003', priceCents: null });
  });

  it('never share a code, whatever its case, and say whose it is', async () => {
    const { service, items } = database();
    const before = items.length;
    await expect(service.createItem(office, { code: 'flt-16251', name: 'Another filter', categoryId: FILTERS })).rejects.toMatchObject({ status: 409, code: 'STOCK_ITEM_CODE_TAKEN', message: 'FLT-16251 is already Filter 16x25x1. Choose another code.' });
    for (const code of ['F', 'FLT 16251!', '-FLT', 'X'.repeat(25), 'FLT_1']) await expect(service.createItem(office, { code, name: 'Bad code', categoryId: FILTERS })).rejects.toMatchObject({ status: 400, code: 'STOCK_ITEM_CODE_INVALID' });
    expect(items).toHaveLength(before);
  });

  it('change their code only while nothing has asked for, ordered or stocked them; the price any time', async () => {
    const { service, db, audits } = database();
    const fresh = await service.createItem(office, { name: 'Filter 20x20x1', categoryId: FILTERS });
    // Nothing names it yet: its code can be put right.
    await expect(service.updateItem(office, fresh.item.id, { code: 'flt-20201', priceCents: 360 })).resolves.toMatchObject({ item: { code: 'FLT-20201', priceCents: 360 } });
    expect(audits.at(-1)).toMatchObject({ action: 'STOCK_ITEM_CHANGED', metadata: { changed: expect.arrayContaining(['code', 'codeKey', 'priceCents']) } });
    await expect(service.updateItem(office, fresh.item.id, { code: 'FLT-16251' })).rejects.toMatchObject({ status: 409, code: 'STOCK_ITEM_CODE_TAKEN' });
    // Its own code sent back with the rest of the form is no change.
    await expect(service.updateItem(office, fresh.item.id, { code: 'FLT-20201', name: 'Filter 20x20x1, MERV 8' })).resolves.toMatchObject({ item: { code: 'FLT-20201', name: 'Filter 20x20x1, MERV 8' } });

    // A purchase request has asked for it: the code stays, the price still changes.
    db.purchaseRequisitionLine.count.mockResolvedValue(1);
    await expect(service.updateItem(office, fresh.item.id, { code: 'FLT-2020' })).rejects.toMatchObject({ status: 409, code: 'STOCK_ITEM_CODE_FIXED', message: 'FLT-20201 has been requested, ordered or stocked, so its code stays.' });
    await expect(service.updateItem(office, fresh.item.id, { priceCents: null })).resolves.toMatchObject({ item: { code: 'FLT-20201', priceCents: null } });

    // So does one with stock.
    db.purchaseRequisitionLine.count.mockResolvedValue(0);
    await service.enterOpeningBalance(office, FILTER, opening());
    await expect(service.updateItem(office, FILTER, { code: 'FLT-1625' })).rejects.toMatchObject({ code: 'STOCK_ITEM_CODE_FIXED' });
  });

  it('keep their company once they have moved, and stay on while they hold stock', async () => {
    const { service } = database();
    await service.enterOpeningBalance(office, FILTER, opening());

    await expect(service.updateItem(office, FILTER, { xeroTenantId: null })).rejects.toMatchObject({ code: 'STOCK_ITEM_COMPANY_FIXED' });
    await expect(service.updateItem(office, FILTER, { active: false })).rejects.toMatchObject({ code: 'STOCK_ITEM_HAS_STOCK' });
    await expect(service.updateItem(office, BATTERY, { active: false })).resolves.toMatchObject({ item: { active: false } });
    await expect(service.updateItem(office, THEIRS, { name: 'Ours now' })).rejects.toMatchObject({ code: 'STOCK_ITEM_NOT_FOUND' });
  });
});

describe('categories', () => {
  it('are listed with the code their next item will get', async () => {
    const { service } = database();
    expect((await service.stock(office)).categories).toEqual([
      { id: FILTERS, name: 'Filters', prefix: 'FLT', nextCode: 'FLT-0003', itemCount: 1, active: true },
      { id: RETIRED, name: 'Old parts', prefix: 'OLD', nextCode: 'OLD-0001', itemCount: 0, active: false },
    ]);
  });

  it('are added with a name and a prefix of their own, kept upper case, and audited', async () => {
    const { service, categories, audits } = database();
    const stock = await service.createCategory(office, { name: ' Pest  products ', prefix: 'pst' });

    expect(categories.at(-1)).toMatchObject({ organizationId: ORG, name: 'Pest products', nameKey: 'pest products', prefix: 'PST', nextNumber: 1 });
    expect(stock.categories.find((category) => category.prefix === 'PST')).toMatchObject({ nextCode: 'PST-0001', itemCount: 0 });
    expect(audits).toEqual([expect.objectContaining({ action: 'STOCK_CATEGORY_CREATED', metadata: { name: 'Pest products', prefix: 'PST' } })]);

    await expect(service.createCategory(office, { name: 'filters', prefix: 'FIL' })).rejects.toMatchObject({ code: 'STOCK_CATEGORY_TAKEN', message: 'There is already a category called filters.' });
    await expect(service.createCategory(office, { name: 'Furnace filters', prefix: 'flt' })).rejects.toMatchObject({ code: 'STOCK_CATEGORY_TAKEN', message: 'Another category already uses the prefix FLT.' });
    await expect(service.createCategory(office, { name: 'Bad', prefix: 'F' })).rejects.toMatchObject({ code: 'STOCK_PREFIX_SHAPE' });
    await expect(service.createCategory(office, { name: 'Bad', prefix: '9AB' })).rejects.toMatchObject({ code: 'STOCK_PREFIX_SHAPE' });
    await expect(service.createCategory(office, { name: ' ', prefix: 'ABC' })).rejects.toMatchObject({ code: 'STOCK_CATEGORY_INCOMPLETE' });
  });

  it('keep their prefix once it has numbered an item, and change it freely before', async () => {
    const { service, categories } = database();
    await expect(service.updateCategory(office, FILTERS, { prefix: 'FIL' })).rejects.toMatchObject({ code: 'STOCK_PREFIX_FIXED' });
    await service.updateCategory(office, FILTERS, { name: 'Air filters', prefix: 'FLT' });
    expect(categories[0]).toMatchObject({ name: 'Air filters', prefix: 'FLT' });

    await service.updateCategory(office, RETIRED, { prefix: 'prt', active: true });
    expect(categories[1]).toMatchObject({ prefix: 'PRT', active: true });
    await expect(service.updateCategory({ ...office, organizationId: OTHER_ORG }, FILTERS, { name: 'Theirs' })).rejects.toMatchObject({ code: 'STOCK_CATEGORY_NOT_FOUND' });
  });
});

describe('places and vendors', () => {
  it('give a van one of the office\'s technicians, and a stockroom none', async () => {
    const { service, places } = database();
    await service.createPlace(office, { name: 'Van 2', kind: 'VAN', technicianId: TECH });
    expect(places.at(-1)).toMatchObject({ name: 'Van 2', nameKey: 'van 2', kind: 'VAN', technicianId: TECH });

    await expect(service.createPlace(office, { name: 'Van 3', kind: 'VAN', technicianId: STRANGER })).rejects.toMatchObject({ code: 'STOCK_TECHNICIAN_NOT_FOUND' });
    await service.createPlace(office, { name: 'Back room', kind: 'STOCKROOM', technicianId: TECH });
    expect(places.at(-1)).toMatchObject({ name: 'Back room', technicianId: null });

    // A truck with nobody named on it: any technician may use it.
    await service.updatePlace(office, VAN, { technicianId: null });
    expect(places.find((place) => place.id === VAN)).toMatchObject({ kind: 'VAN', technicianId: null });
    await expect(service.updatePlace(office, VAN, { technicianId: STRANGER })).rejects.toMatchObject({ code: 'STOCK_TECHNICIAN_NOT_FOUND' });
  });

  it('keep their kind once made: a truck does not become a storeroom', async () => {
    const { service, places } = database();
    await expect(service.updatePlace(office, VAN, { kind: 'STOCKROOM' })).rejects.toMatchObject({ status: 409, code: 'STOCK_PLACE_KIND_FIXED', message: 'Van 1 keeps its kind. Make another place instead.' });
    expect(places.find((place) => place.id === VAN)).toMatchObject({ kind: 'VAN' });
    // Its own kind sent back with the rest of the form is no change.
    await expect(service.updatePlace(office, VAN, { kind: 'VAN', name: 'Truck 1' })).resolves.toBeDefined();
    expect(places.find((place) => place.id === VAN)).toMatchObject({ name: 'Truck 1', kind: 'VAN' });
  });

  it('say how many different items each place has any of', async () => {
    const { service } = database();
    await service.enterOpeningBalance(office, FILTER, opening());
    await service.enterOpeningBalance(office, FILTER, opening({ placeId: VAN, quantity: 5, unitCostCents: 360, requestKey: id(91) }));
    await service.enterOpeningBalance(office, BATTERY, opening({ quantity: 3, unitCostCents: 185, requestKey: id(92) }));
    const held = Object.fromEntries((await service.places(office)).places.map((place) => [place.id, place.itemsHeld]));
    expect(held[STOCKROOM]).toBe(2);
    expect(held[VAN]).toBe(1);
    // The Stock tab's own read says the same, from the levels it already has.
    expect((await service.stock(office)).places.find((place) => place.id === STOCKROOM)).toMatchObject({ itemsHeld: 2 });
  });

  it('keep a place on while it holds stock', async () => {
    const { service } = database();
    await service.enterOpeningBalance(office, FILTER, opening());
    await expect(service.updatePlace(office, STOCKROOM, { active: false })).rejects.toMatchObject({ code: 'STOCK_PLACE_HAS_STOCK' });
    const after = await service.updatePlace(office, VAN, { active: false });
    expect(after.places.find((place) => place.id === VAN)).toMatchObject({ active: false });
  });

  it('add and change a vendor, audited', async () => {
    const { service, vendors, audits } = database();
    await service.createVendor(office, { name: ' Hill Country  Supply ', email: 'orders@example.com', terms: 'Net 30' });
    expect(vendors[0]).toMatchObject({ organizationId: ORG, name: 'Hill Country Supply', nameKey: 'hill country supply', email: 'orders@example.com', terms: 'Net 30', phone: null });

    await service.updateVendor(office, vendors[0]!.id as string, { phone: '512-555-0100', email: null });
    expect(vendors[0]).toMatchObject({ phone: '512-555-0100', email: null, terms: 'Net 30' });
    expect(audits.map((audit) => audit.action)).toEqual(['VENDOR_CREATED', 'VENDOR_CHANGED']);
    await expect(service.updateVendor({ ...office, organizationId: OTHER_ORG }, vendors[0]!.id as string, { name: 'Theirs' })).rejects.toMatchObject({ code: 'VENDOR_NOT_FOUND' });
  });
});

describe('the requests the page sends', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (body: unknown, metatype: new () => object) => pipe.transform(body, { type: 'body', metatype });

  it('name every field of their contracts', async () => {
    const item: Required<SaveStockItemInput> = { code: 'flt-16251', priceCents: 342, name: 'Filter 16x25x1', unit: 'each', categoryId: FILTERS, xeroTenantId: THMP, reorderLevel: 24, reorderQuantity: 48, usualVendorId: id(70), active: true };
    const balance: Required<OpeningBalanceInput> = { placeId: STOCKROOM, quantity: 18, unitCostCents: 342, day: '2026-11-18', note: 'Counted', requestKey: KEY };
    const reversal: Required<ReverseMovementInput> = { reason: 'Counted the wrong shelf' };
    const place: Required<SaveStockPlaceInput> = { name: 'Van 1', kind: 'VAN', technicianId: TECH, active: true };
    const category: Required<SaveStockCategoryInput> = { name: 'Filters', prefix: 'flt', active: true };
    const vendor: Required<SaveVendorInput> = { name: 'Hill Country Supply', contactName: 'A person', email: 'orders@example.com', phone: '512-555-0100', terms: 'Net 30', notes: 'Delivers Tuesdays', active: true };

    await expect(check(item, SaveStockItemDto)).resolves.toBeDefined();
    await expect(check(balance, OpeningBalanceDto)).resolves.toBeDefined();
    await expect(check(reversal, ReverseMovementDto)).resolves.toBeDefined();
    await expect(check(place, SaveStockPlaceDto)).resolves.toBeDefined();
    await expect(check(vendor, SaveVendorDto)).resolves.toBeDefined();
    await expect(check(category, SaveStockCategoryDto)).resolves.toBeDefined();
    await expect(check({ xeroTenantId: null, usualVendorId: null }, SaveStockItemDto)).resolves.toBeDefined();
  });

  it('take a code typed for an item and its price, and refuse a price below nothing or a prefix that could not start a code', async () => {
    // The stock keeper may type the code (2026-11-19); the service decides its shape and whether it is free.
    await expect(check({ name: 'Filter', categoryId: FILTERS, code: 'FLT-9999', priceCents: 342 }, SaveStockItemDto)).resolves.toMatchObject({ code: 'FLT-9999', priceCents: 342 });
    await expect(check({ name: 'Filter', categoryId: FILTERS, priceCents: null }, SaveStockItemDto)).resolves.toBeDefined();
    await expect(check({ name: 'Filter', categoryId: FILTERS, priceCents: -1 }, SaveStockItemDto)).rejects.toBeDefined();
    await expect(check({ name: 'Filter', categoryId: FILTERS, priceCents: 3.5 }, SaveStockItemDto)).rejects.toBeDefined();
    await expect(check({ name: 'Filter', categoryId: FILTERS, onHand: 5 }, SaveStockItemDto)).rejects.toBeDefined();
    await expect(check({ name: 'Filter', category: 'Filters' }, SaveStockItemDto)).rejects.toBeDefined();
    await expect(check({ name: 'Filters', prefix: 'F-1' }, SaveStockCategoryDto)).rejects.toBeDefined();
    await expect(check({ name: 'Filters', prefix: 'F', nextNumber: 900 }, SaveStockCategoryDto)).rejects.toBeDefined();
  });

  it('refuse a quantity typed as on hand, nothing at all, a negative cost and a part of a unit', async () => {
    const balance = { placeId: STOCKROOM, quantity: 18, unitCostCents: 342, requestKey: KEY };
    await expect(check({ ...balance, onHand: 40 }, OpeningBalanceDto)).rejects.toBeDefined();
    await expect(check({ ...balance, quantity: 0 }, OpeningBalanceDto)).rejects.toBeDefined();
    await expect(check({ ...balance, quantity: 1.5 }, OpeningBalanceDto)).rejects.toBeDefined();
    await expect(check({ ...balance, unitCostCents: -1 }, OpeningBalanceDto)).rejects.toBeDefined();
    await expect(check({ ...balance, requestKey: undefined }, OpeningBalanceDto)).rejects.toBeDefined();
    await expect(check({ name: 'Filter', onHand: 40 }, SaveStockItemDto)).rejects.toBeDefined();
    await expect(check({ reason: '' }, ReverseMovementDto)).rejects.toBeDefined();
  });
});

describe('who may do what', () => {
  const permissionsOf = (name: string) => Reflect.getMetadata('permissions', (InventoryController.prototype as unknown as Record<string, object>)[name]!) as string[];

  it('reads with inventory:read and changes with inventory:manage', () => {
    for (const read of ['stock', 'item', 'places', 'vendors']) expect(permissionsOf(read)).toEqual(['inventory:read']);
    for (const write of ['createItem', 'updateItem', 'createCategory', 'updateCategory', 'enterOpeningBalance', 'reverseMovement', 'createPlace', 'updatePlace', 'createVendor', 'updateVendor'])
      expect(permissionsOf(write)).toEqual(['inventory:manage']);
  });

  it('never lets an API key move stock', () => {
    expect(MACHINE_FORBIDDEN_PERMISSIONS).toContain('inventory:manage');
  });
});
