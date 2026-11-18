import { Inject, Injectable } from '@nestjs/common';
import { Prisma, StockMovementKind, StockPlaceKind, UserRole } from '@prisma/client';
import {
  STOCK_MOVEMENTS_SHOWN,
  STOCK_PREFIX,
  averageCostCents,
  stockCode,
  stockKey,
  stockStatus,
  type OpeningBalanceInput,
  type ReverseMovementInput,
  type SaveStockCategoryInput,
  type SaveStockItemInput,
  type SaveStockPlaceInput,
  type SaveVendorInput,
  type StockCompany,
  type StockItemDetail,
  type StockItemRow,
  type StockList,
  type StockPlaceRow,
  type StockPlaces,
  type VendorRow,
  type Vendors,
} from '@texasrenters/shared';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

/**
 * Inventory (2026-11-19, phase 1 of the inventory and purchasing plan): the
 * items the office stocks, the places they are kept, the vendors, and the
 * stock ledger.
 *
 * On hand is never written here. A change to stock is one StockMovement row,
 * inserted once; the database adds it to StockLevel (a trigger), refuses a
 * movement that would take a place below nothing (a check), and refuses any
 * change to a movement already written (a trigger). This service only decides
 * whether a movement may be made, and says why not in the office's words.
 *
 * Every read is scoped to the caller's office, every write is audited, and
 * nothing here calls anything billed: the page reads when it opens and after
 * its own saves, never on a poll.
 */

/** One the client sent: a value, or null to clear. The validation pipe hands over every field the DTO names, `undefined` where none came. */
const sent = (input: object, field: string) => (input as Record<string, unknown>)[field] !== undefined;
const text = (value: string | null | undefined) => value?.trim().replace(/\s+/g, ' ') || null;
const dateOf = (day: string) => new Date(`${day}T00:00:00.000Z`);
const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const taken = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const ITEM_SELECT = {
  id: true,
  code: true,
  name: true,
  unit: true,
  category: { select: { id: true, name: true } },
  xeroTenantId: true,
  reorderLevel: true,
  reorderQuantity: true,
  active: true,
  usualVendor: { select: { id: true, name: true } },
} satisfies Prisma.StockItemSelect;
type ItemRecord = Prisma.StockItemGetPayload<{ select: typeof ITEM_SELECT }>;

const PLACE_SELECT = {
  id: true,
  name: true,
  kind: true,
  technicianId: true,
  active: true,
  technician: { select: { displayName: true } },
} satisfies Prisma.StockPlaceSelect;
type PlaceRecord = Prisma.StockPlaceGetPayload<{ select: typeof PLACE_SELECT }>;

const VENDOR_SELECT = { id: true, name: true, contactName: true, email: true, phone: true, terms: true, notes: true, active: true } satisfies Prisma.VendorSelect;

interface Level {
  itemId: string;
  placeId: string;
  quantity: number;
  valueCents: number;
}

const placeRow = (place: PlaceRecord): StockPlaceRow => ({
  id: place.id,
  name: place.name,
  kind: place.kind,
  technicianId: place.technicianId,
  technicianName: place.technician?.displayName ?? null,
  active: place.active,
});

function itemRow(item: ItemRecord, levels: readonly Level[], kinds: ReadonlyMap<string, StockPlaceKind>, companies: ReadonlyMap<string, string>): StockItemRow {
  let inStockrooms = 0;
  let inVans = 0;
  let valueCents = 0;
  for (const level of levels) {
    if (kinds.get(level.placeId) === StockPlaceKind.VAN) inVans += level.quantity;
    else inStockrooms += level.quantity;
    valueCents += level.valueCents;
  }
  const onHand = inStockrooms + inVans;
  const company: StockCompany | null = item.xeroTenantId ? { tenantId: item.xeroTenantId, name: companies.get(item.xeroTenantId) ?? 'A company' } : null;
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    unit: item.unit,
    category: item.category,
    company,
    reorderLevel: item.reorderLevel,
    reorderQuantity: item.reorderQuantity,
    usualVendor: item.usualVendor,
    active: item.active,
    onHand,
    inStockrooms,
    inVans,
    valueCents,
    status: stockStatus(onHand, item.reorderLevel),
  };
}

@Injectable()
export class InventoryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // ── Items ───────────────────────────────────────────────────────────────

  /** Every item with what is on hand: six reads, whatever the number of items. */
  async stock(user: AuthenticatedUser): Promise<StockList> {
    const organizationId = user.organizationId;
    const [items, levels, places, organisations, vendors, categories] = await Promise.all([
      this.prisma.stockItem.findMany({ where: { organizationId }, select: ITEM_SELECT, orderBy: [{ active: 'desc' }, { codeKey: 'asc' }] }),
      this.prisma.stockLevel.findMany({ where: { organizationId }, select: { itemId: true, placeId: true, quantity: true, valueCents: true } }),
      this.prisma.stockPlace.findMany({ where: { organizationId }, select: PLACE_SELECT, orderBy: [{ active: 'desc' }, { kind: 'asc' }, { nameKey: 'asc' }] }),
      this.prisma.xeroOrganisation.findMany({ where: { organizationId }, select: { xeroTenantId: true, name: true, status: true }, orderBy: { name: 'asc' } }),
      this.prisma.vendor.findMany({ where: { organizationId, active: true }, select: { id: true, name: true }, orderBy: { nameKey: 'asc' } }),
      this.prisma.stockCategory.findMany({
        where: { organizationId },
        select: { id: true, name: true, prefix: true, nextNumber: true, active: true, _count: { select: { items: true } } },
        orderBy: [{ active: 'desc' }, { nameKey: 'asc' }],
      }),
    ]);
    const kinds = new Map(places.map((place) => [place.id, place.kind]));
    const names = new Map(organisations.map((row) => [row.xeroTenantId, row.name]));
    const byItem = new Map<string, Level[]>();
    for (const level of levels) byItem.set(level.itemId, [...(byItem.get(level.itemId) ?? []), level]);
    return {
      items: items.map((item) => itemRow(item, byItem.get(item.id) ?? [], kinds, names)),
      places: places.map(placeRow),
      companies: organisations.filter((row) => row.status === 'CONNECTED').map((row) => ({ tenantId: row.xeroTenantId, name: row.name })),
      vendors,
      categories: categories.map((category) => ({
        id: category.id,
        name: category.name,
        prefix: category.prefix,
        nextCode: stockCode(category.prefix, category.nextNumber),
        itemCount: category._count.items,
        active: category.active,
      })),
    };
  }

  /** One item: where it is, what it cost, and its movements, newest first. */
  async item(user: AuthenticatedUser, itemId: string): Promise<StockItemDetail> {
    const organizationId = user.organizationId;
    const item = await this.prisma.stockItem.findFirst({ where: { id: itemId, organizationId }, select: ITEM_SELECT });
    if (!item) throw new ApplicationError(404, 'STOCK_ITEM_NOT_FOUND', 'That item is not in the inventory.');
    const [levels, places, organisation, movements, movementsTotal] = await Promise.all([
      this.prisma.stockLevel.findMany({ where: { organizationId, itemId }, select: { itemId: true, placeId: true, quantity: true, valueCents: true } }),
      this.prisma.stockPlace.findMany({ where: { organizationId }, select: { id: true, name: true, kind: true } }),
      item.xeroTenantId
        ? this.prisma.xeroOrganisation.findFirst({ where: { organizationId, xeroTenantId: item.xeroTenantId }, select: { xeroTenantId: true, name: true } })
        : null,
      this.prisma.stockMovement.findMany({
        where: { organizationId, itemId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: STOCK_MOVEMENTS_SHOWN,
        select: {
          id: true,
          kind: true,
          day: true,
          placeId: true,
          quantity: true,
          unitCostCents: true,
          note: true,
          createdByName: true,
          createdAt: true,
          reversesId: true,
          reversedBy: { select: { id: true } },
        },
      }),
      this.prisma.stockMovement.count({ where: { organizationId, itemId } }),
    ]);
    const placeOf = new Map(places.map((place) => [place.id, place]));
    const row = itemRow(item, levels, new Map(places.map((place) => [place.id, place.kind])), new Map(organisation ? [[organisation.xeroTenantId, organisation.name]] : []));
    // Newest first, so each row's "on hand after" is the one above it less what that one moved.
    let after = row.onHand;
    return {
      item: row,
      levels: levels
        .filter((level) => level.quantity !== 0)
        .map((level) => ({
          placeId: level.placeId,
          placeName: placeOf.get(level.placeId)?.name ?? 'A place',
          kind: placeOf.get(level.placeId)?.kind ?? StockPlaceKind.STOCKROOM,
          quantity: level.quantity,
        }))
        .sort((left, right) => left.kind.localeCompare(right.kind) || left.placeName.localeCompare(right.placeName)),
      averageCostCents: averageCostCents(row.valueCents, row.onHand),
      movements: movements.map((movement) => {
        const onHandAfter = after;
        after -= movement.quantity;
        return {
          id: movement.id,
          kind: movement.kind,
          day: dayOf(movement.day),
          placeId: movement.placeId,
          placeName: placeOf.get(movement.placeId)?.name ?? 'A place',
          quantity: movement.quantity,
          unitCostCents: movement.unitCostCents,
          onHandAfter,
          note: movement.note,
          by: movement.createdByName,
          createdAt: movement.createdAt.toISOString(),
          reversesId: movement.reversesId,
          reversedById: movement.reversedBy?.id ?? null,
        };
      }),
      movementsTotal,
    };
  }

  async createItem(user: AuthenticatedUser, input: SaveStockItemInput): Promise<StockItemDetail> {
    const organizationId = user.organizationId;
    const name = text(input.name);
    const categoryId = input.categoryId;
    if (!name || !categoryId) throw new ApplicationError(400, 'STOCK_ITEM_INCOMPLETE', 'An item needs a name and a category. The category gives it its code.');
    await this.itemChoicesAreOurs(organizationId, input);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const category = await tx.stockCategory.findFirst({ where: { id: categoryId, organizationId, active: true }, select: { prefix: true } });
        if (!category) throw new ApplicationError(400, 'STOCK_CATEGORY_NOT_FOUND', 'That category is not in use.');
        const code = await this.nextCode(tx, organizationId, categoryId, category.prefix);
        const item = await tx.stockItem.create({
          data: {
            organizationId,
            code,
            codeKey: stockKey(code),
            name,
            unit: text(input.unit) ?? 'each',
            categoryId,
            xeroTenantId: input.xeroTenantId ?? null,
            reorderLevel: input.reorderLevel ?? 0,
            reorderQuantity: input.reorderQuantity ?? 0,
            usualVendorId: input.usualVendorId ?? null,
          },
          select: { id: true },
        });
        await tx.auditLog.create({
          data: { organizationId, ...auditActor(user), action: 'STOCK_ITEM_CREATED', entityType: 'StockItem', entityId: item.id, metadata: { code, name } },
        });
        return item;
      });
      return this.item(user, created.id);
    } catch (error) {
      // The category's lock gives each item its own number, so this is only somebody's typed code from before; adding again takes the next.
      if (taken(error)) throw new ApplicationError(409, 'STOCK_ITEM_CODE_TAKEN', 'That code was just taken. Add the item again.');
      throw error;
    }
  }

  /**
   * The category's next code, taken under its row's lock: two items added at
   * once never share a number. A code somebody typed before the console gave
   * them is stepped over.
   */
  private async nextCode(db: Prisma.TransactionClient, organizationId: string, categoryId: string, prefix: string): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const [row] = await db.$queryRaw<{ taken: number }[]>`
        UPDATE "StockCategory" SET "nextNumber" = "nextNumber" + 1
         WHERE "id" = ${categoryId}::uuid AND "organizationId" = ${organizationId}::uuid
        RETURNING "nextNumber" - 1 AS taken`;
      const code = stockCode(prefix, Number(row!.taken));
      if (!(await db.stockItem.findFirst({ where: { organizationId, codeKey: stockKey(code) }, select: { id: true } }))) return code;
    }
    throw new ApplicationError(409, 'STOCK_ITEM_CODE_TAKEN', 'No free code was found for that category. Give it another prefix.');
  }

  async updateItem(user: AuthenticatedUser, itemId: string, input: SaveStockItemInput): Promise<StockItemDetail> {
    const organizationId = user.organizationId;
    await this.itemChoicesAreOurs(organizationId, input);
    const data: Prisma.StockItemUncheckedUpdateInput = {};
    if (sent(input, 'name')) {
      const name = text(input.name);
      if (!name) throw new ApplicationError(400, 'STOCK_ITEM_INCOMPLETE', 'An item needs a name.');
      data.name = name;
    }
    if (sent(input, 'unit')) data.unit = text(input.unit) ?? 'each';
    if (sent(input, 'xeroTenantId')) data.xeroTenantId = input.xeroTenantId ?? null;
    if (sent(input, 'reorderLevel')) data.reorderLevel = input.reorderLevel;
    if (sent(input, 'reorderQuantity')) data.reorderQuantity = input.reorderQuantity;
    if (sent(input, 'usualVendorId')) data.usualVendorId = input.usualVendorId ?? null;
    if (sent(input, 'active')) data.active = input.active;
    await this.prisma.$transaction(async (tx) => {
      const item = await tx.stockItem.findFirst({ where: { id: itemId, organizationId }, select: { id: true, code: true, xeroTenantId: true, active: true, categoryId: true } });
      if (!item) throw new ApplicationError(404, 'STOCK_ITEM_NOT_FOUND', 'That item is not in the inventory.');
      // Its code came from its category, so the category stays. An item from before categories may be given one; its code stays as it is.
      if (sent(input, 'categoryId') && input.categoryId !== item.categoryId) {
        if (item.categoryId) throw new ApplicationError(409, 'STOCK_ITEM_CATEGORY_FIXED', `${item.code} got its code from its category, so the category cannot be changed.`);
        if (!(await tx.stockCategory.findFirst({ where: { id: input.categoryId, organizationId }, select: { id: true } })))
          throw new ApplicationError(400, 'STOCK_CATEGORY_NOT_FOUND', 'That category is not on the list.');
        data.categoryId = input.categoryId;
      }
      // Its stock is already in one company's books: moving the item would move the value with no entry for it.
      if (sent(input, 'xeroTenantId') && (input.xeroTenantId ?? null) !== item.xeroTenantId && (await tx.stockMovement.count({ where: { organizationId, itemId } })) > 0)
        throw new ApplicationError(409, 'STOCK_ITEM_COMPANY_FIXED', 'This item already has stock movements, so its company cannot be changed.');
      if (input.active === false && item.active) {
        const held = await tx.stockLevel.aggregate({ where: { organizationId, itemId }, _sum: { quantity: true } });
        const onHand = held._sum.quantity ?? 0;
        if (onHand > 0) throw new ApplicationError(409, 'STOCK_ITEM_HAS_STOCK', `This item still has ${onHand} on hand. It can be switched off once that is gone.`);
      }
      if (!Object.keys(data).length) return;
      await tx.stockItem.update({ where: { id: itemId }, data });
      await tx.auditLog.create({
        data: { organizationId, ...auditActor(user), action: 'STOCK_ITEM_CHANGED', entityType: 'StockItem', entityId: itemId, metadata: { code: item.code, changed: Object.keys(data) } },
      });
    });
    return this.item(user, itemId);
  }

  // ── Categories ──────────────────────────────────────────────────────────

  /** A kind of stock and the prefix its items' codes start with. */
  async createCategory(user: AuthenticatedUser, input: SaveStockCategoryInput): Promise<StockList> {
    const organizationId = user.organizationId;
    const name = text(input.name);
    const prefix = input.prefix?.trim().toUpperCase() ?? '';
    if (!name) throw new ApplicationError(400, 'STOCK_CATEGORY_INCOMPLETE', 'A category needs a name.');
    if (!STOCK_PREFIX.test(prefix)) throw new ApplicationError(400, 'STOCK_PREFIX_SHAPE', 'A prefix is a letter and then one to five letters or digits, like FLT.');
    await this.categoryIsFree(organizationId, null, name, prefix);
    try {
      await this.prisma.$transaction(async (tx) => {
        const category = await tx.stockCategory.create({ data: { organizationId, name, nameKey: stockKey(name), prefix }, select: { id: true } });
        await tx.auditLog.create({
          data: { organizationId, ...auditActor(user), action: 'STOCK_CATEGORY_CREATED', entityType: 'StockCategory', entityId: category.id, metadata: { name, prefix } },
        });
      });
    } catch (error) {
      if (taken(error)) throw new ApplicationError(409, 'STOCK_CATEGORY_TAKEN', 'Another category already has that name or prefix.');
      throw error;
    }
    return this.stock(user);
  }

  async updateCategory(user: AuthenticatedUser, categoryId: string, input: SaveStockCategoryInput): Promise<StockList> {
    const organizationId = user.organizationId;
    try {
      await this.prisma.$transaction(async (tx) => {
        const category = await tx.stockCategory.findFirst({ where: { id: categoryId, organizationId }, select: { name: true, prefix: true, nextNumber: true } });
        if (!category) throw new ApplicationError(404, 'STOCK_CATEGORY_NOT_FOUND', 'That category is not on the list.');
        const data: Prisma.StockCategoryUncheckedUpdateInput = {};
        if (sent(input, 'name')) {
          const name = text(input.name);
          if (!name) throw new ApplicationError(400, 'STOCK_CATEGORY_INCOMPLETE', 'A category needs a name.');
          data.name = name;
          data.nameKey = stockKey(name);
        }
        if (sent(input, 'prefix')) {
          const prefix = input.prefix?.trim().toUpperCase() ?? '';
          if (!STOCK_PREFIX.test(prefix)) throw new ApplicationError(400, 'STOCK_PREFIX_SHAPE', 'A prefix is a letter and then one to five letters or digits, like FLT.');
          if (prefix !== category.prefix) {
            // Codes already given keep the prefix they were given with: changing it now would leave one category with two.
            if (category.nextNumber > 1) throw new ApplicationError(409, 'STOCK_PREFIX_FIXED', `${category.name} has already given out codes starting ${category.prefix}, so its prefix stays.`);
            data.prefix = prefix;
          }
        }
        if (sent(input, 'active')) data.active = input.active;
        if (!Object.keys(data).length) return;
        await this.categoryIsFree(organizationId, categoryId, typeof data.name === 'string' ? data.name : null, typeof data.prefix === 'string' ? data.prefix : null);
        await tx.stockCategory.update({ where: { id: categoryId }, data });
        await tx.auditLog.create({
          data: { organizationId, ...auditActor(user), action: 'STOCK_CATEGORY_CHANGED', entityType: 'StockCategory', entityId: categoryId, metadata: { name: category.name, changed: Object.keys(data) } },
        });
      });
    } catch (error) {
      if (taken(error)) throw new ApplicationError(409, 'STOCK_CATEGORY_TAKEN', 'Another category already has that name or prefix.');
      throw error;
    }
    return this.stock(user);
  }

  /** Says which is taken, the name or the prefix. The database's two unique indexes hold both whatever this finds. */
  private async categoryIsFree(organizationId: string, exceptId: string | null, name: string | null, prefix: string | null) {
    const others = await this.prisma.stockCategory.findMany({ where: { organizationId, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { nameKey: true, prefix: true } });
    if (name && others.some((other) => other.nameKey === stockKey(name))) throw new ApplicationError(409, 'STOCK_CATEGORY_TAKEN', `There is already a category called ${name}.`);
    if (prefix && others.some((other) => other.prefix === prefix)) throw new ApplicationError(409, 'STOCK_CATEGORY_TAKEN', `Another category already uses the prefix ${prefix}.`);
  }

  /** The company and the vendor an item names are this office's own. The database refuses any other too; this says so plainly. */
  private async itemChoicesAreOurs(organizationId: string, input: SaveStockItemInput) {
    if (input.xeroTenantId && !(await this.prisma.xeroOrganisation.findFirst({ where: { organizationId, xeroTenantId: input.xeroTenantId, status: 'CONNECTED' }, select: { id: true } })))
      throw new ApplicationError(400, 'STOCK_COMPANY_NOT_FOUND', 'That company is not connected to this office.');
    if (input.usualVendorId && !(await this.prisma.vendor.findFirst({ where: { organizationId, id: input.usualVendorId }, select: { id: true } })))
      throw new ApplicationError(400, 'VENDOR_NOT_FOUND', 'That vendor is not on the list.');
  }

  // ── The ledger ──────────────────────────────────────────────────────────

  /**
   * What is on the shelf the day the console takes stock over: one per item
   * and place. Sent twice -- a second click, a retry -- it is written once,
   * by its request key.
   */
  async enterOpeningBalance(user: AuthenticatedUser, itemId: string, input: OpeningBalanceInput): Promise<StockItemDetail> {
    const organizationId = user.organizationId;
    const today = businessDate();
    const day = input.day ?? today;
    if (day > today) throw new ApplicationError(400, 'STOCK_DAY_AHEAD', 'An opening balance cannot be dated after today.');
    const write = () =>
      this.prisma.$transaction(async (tx) => {
        const already = await tx.stockMovement.findFirst({ where: { organizationId, requestKey: input.requestKey }, select: { itemId: true } });
        if (already) {
          if (already.itemId !== itemId) throw new ApplicationError(409, 'STOCK_REQUEST_REUSED', 'That entry was already made for another item.');
          return;
        }
        const [item, place] = await Promise.all([
          tx.stockItem.findFirst({ where: { id: itemId, organizationId }, select: { code: true, active: true } }),
          tx.stockPlace.findFirst({ where: { id: input.placeId, organizationId }, select: { name: true, active: true } }),
        ]);
        if (!item) throw new ApplicationError(404, 'STOCK_ITEM_NOT_FOUND', 'That item is not in the inventory.');
        if (!place) throw new ApplicationError(404, 'STOCK_PLACE_NOT_FOUND', 'That place is not on the list.');
        if (!item.active || !place.active) throw new ApplicationError(409, 'STOCK_SWITCHED_OFF', 'Stock cannot be entered for an item or a place that is switched off.');
        // Two people entering the same item and place at once: the second waits here, then sees the first.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`stock-opening:${itemId}:${input.placeId}`}))`;
        const standing = await tx.stockMovement.findFirst({
          where: { organizationId, itemId, placeId: input.placeId, kind: StockMovementKind.OPENING_BALANCE, reversedBy: null },
          select: { id: true },
        });
        if (standing)
          throw new ApplicationError(409, 'STOCK_OPENING_BALANCE_EXISTS', `${item.code} already has an opening balance in ${place.name}. Reverse that one first to enter another.`);
        const movement = await tx.stockMovement.create({
          data: {
            organizationId,
            itemId,
            placeId: input.placeId,
            kind: StockMovementKind.OPENING_BALANCE,
            quantity: input.quantity,
            unitCostCents: input.unitCostCents,
            day: dateOf(day),
            note: text(input.note),
            requestKey: input.requestKey,
            createdById: user.principalType === 'API_KEY' ? null : user.id,
            createdByName: user.displayName,
          },
          select: { id: true },
        });
        await tx.auditLog.create({
          data: {
            organizationId,
            ...auditActor(user),
            action: 'STOCK_OPENING_BALANCE_ENTERED',
            entityType: 'StockMovement',
            entityId: movement.id,
            metadata: { item: item.code, place: place.name, quantity: input.quantity, unitCostCents: input.unitCostCents, day },
          },
        });
      });
    try {
      await write();
    } catch (error) {
      // The same entry, sent at the same moment by a retry: the other one wrote it.
      if (!taken(error)) throw error;
    }
    return this.item(user, itemId);
  }

  /**
   * Puts a wrong movement right with a second one, opposite and equal, at the
   * same cost. The first stays as it was written. A movement is reversed once
   * (the database holds that too), and a reversal is never itself reversed.
   */
  async reverseMovement(user: AuthenticatedUser, movementId: string, input: ReverseMovementInput): Promise<StockItemDetail> {
    const organizationId = user.organizationId;
    const reason = text(input.reason);
    if (!reason) throw new ApplicationError(400, 'STOCK_REVERSAL_NEEDS_REASON', 'Say why it is being reversed.');
    let itemId = '';
    try {
      await this.prisma.$transaction(async (tx) => {
        const movement = await tx.stockMovement.findFirst({
          where: { id: movementId, organizationId },
          select: { itemId: true, placeId: true, kind: true, quantity: true, unitCostCents: true, reversedBy: { select: { id: true } }, item: { select: { code: true } }, place: { select: { name: true } } },
        });
        if (!movement) throw new ApplicationError(404, 'STOCK_MOVEMENT_NOT_FOUND', 'That movement is not in the ledger.');
        itemId = movement.itemId;
        if (movement.kind === StockMovementKind.REVERSAL) throw new ApplicationError(409, 'STOCK_REVERSAL_OF_REVERSAL', 'A reversal cannot be reversed. Enter the movement again instead.');
        if (movement.reversedBy) throw new ApplicationError(409, 'STOCK_MOVEMENT_ALREADY_REVERSED', 'That movement has already been reversed.');
        // A movement a document made is put right through its document, which keeps the two in step.
        if (movement.kind !== StockMovementKind.OPENING_BALANCE)
          throw new ApplicationError(409, 'STOCK_MOVEMENT_HAS_DOCUMENT', 'Goods received are reversed from their purchase order, with the receipt.');
        if (movement.quantity > 0) {
          const level = await tx.stockLevel.findUnique({ where: { itemId_placeId: { itemId: movement.itemId, placeId: movement.placeId } }, select: { quantity: true } });
          const there = level?.quantity ?? 0;
          if (there < movement.quantity)
            throw new ApplicationError(409, 'STOCK_NOT_ENOUGH', `Only ${there} of ${movement.item.code} are in ${movement.place.name}, so ${movement.quantity} cannot be taken back out.`);
        }
        const reversal = await tx.stockMovement.create({
          data: {
            organizationId,
            itemId: movement.itemId,
            placeId: movement.placeId,
            kind: StockMovementKind.REVERSAL,
            quantity: -movement.quantity,
            unitCostCents: movement.unitCostCents,
            day: dateOf(businessDate()),
            note: reason,
            reversesId: movementId,
            createdById: user.principalType === 'API_KEY' ? null : user.id,
            createdByName: user.displayName,
          },
          select: { id: true },
        });
        await tx.auditLog.create({
          data: {
            organizationId,
            ...auditActor(user),
            action: 'STOCK_MOVEMENT_REVERSED',
            entityType: 'StockMovement',
            entityId: movementId,
            metadata: { reversal: reversal.id, item: movement.item.code, place: movement.place.name, quantity: movement.quantity, reason },
          },
        });
      });
    } catch (error) {
      if (taken(error)) throw new ApplicationError(409, 'STOCK_MOVEMENT_ALREADY_REVERSED', 'That movement has already been reversed.');
      throw error;
    }
    return this.item(user, itemId);
  }

  // ── Places ──────────────────────────────────────────────────────────────

  async places(user: AuthenticatedUser): Promise<StockPlaces> {
    const organizationId = user.organizationId;
    const [places, members] = await Promise.all([
      this.prisma.stockPlace.findMany({ where: { organizationId }, select: PLACE_SELECT, orderBy: [{ active: 'desc' }, { kind: 'asc' }, { nameKey: 'asc' }] }),
      this.prisma.organizationMember.findMany({
        where: { organizationId, role: UserRole.INSPECTION_TECHNICIAN, userProfile: { isActive: true } },
        select: { userProfile: { select: { id: true, displayName: true } } },
      }),
    ]);
    const technicians = new Map(members.map(({ userProfile }) => [userProfile.id, userProfile.displayName]));
    return {
      places: places.map(placeRow),
      technicians: [...technicians].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  async createPlace(user: AuthenticatedUser, input: SaveStockPlaceInput): Promise<StockPlaces> {
    const organizationId = user.organizationId;
    const name = text(input.name);
    if (!name) throw new ApplicationError(400, 'STOCK_PLACE_INCOMPLETE', 'A place needs a name.');
    const kind = input.kind ?? StockPlaceKind.STOCKROOM;
    const technicianId = await this.vanTechnician(organizationId, kind, input.technicianId ?? null);
    try {
      await this.prisma.$transaction(async (tx) => {
        const place = await tx.stockPlace.create({ data: { organizationId, name, nameKey: stockKey(name), kind, technicianId }, select: { id: true } });
        await tx.auditLog.create({
          data: { organizationId, ...auditActor(user), action: 'STOCK_PLACE_CREATED', entityType: 'StockPlace', entityId: place.id, metadata: { name, kind } },
        });
      });
    } catch (error) {
      if (taken(error)) throw new ApplicationError(409, 'STOCK_PLACE_NAME_TAKEN', `There is already a place called ${name}.`);
      throw error;
    }
    return this.places(user);
  }

  async updatePlace(user: AuthenticatedUser, placeId: string, input: SaveStockPlaceInput): Promise<StockPlaces> {
    const organizationId = user.organizationId;
    try {
      await this.prisma.$transaction(async (tx) => {
        const place = await tx.stockPlace.findFirst({ where: { id: placeId, organizationId }, select: { name: true, kind: true, technicianId: true, active: true } });
        if (!place) throw new ApplicationError(404, 'STOCK_PLACE_NOT_FOUND', 'That place is not on the list.');
        const data: Prisma.StockPlaceUncheckedUpdateInput = {};
        if (sent(input, 'name')) {
          const name = text(input.name);
          if (!name) throw new ApplicationError(400, 'STOCK_PLACE_INCOMPLETE', 'A place needs a name.');
          data.name = name;
          data.nameKey = stockKey(name);
        }
        const kind = input.kind ?? place.kind;
        if (sent(input, 'kind')) data.kind = kind;
        if (sent(input, 'kind') || sent(input, 'technicianId'))
          data.technicianId = await this.vanTechnician(organizationId, kind, sent(input, 'technicianId') ? (input.technicianId ?? null) : place.technicianId);
        if (sent(input, 'active')) {
          if (input.active === false && place.active) {
            const held = await tx.stockLevel.aggregate({ where: { organizationId, placeId }, _sum: { quantity: true } });
            if ((held._sum.quantity ?? 0) > 0) throw new ApplicationError(409, 'STOCK_PLACE_HAS_STOCK', `${place.name} still holds stock. It can be switched off once it is empty.`);
          }
          data.active = input.active;
        }
        if (!Object.keys(data).length) return;
        await tx.stockPlace.update({ where: { id: placeId }, data });
        await tx.auditLog.create({
          data: { organizationId, ...auditActor(user), action: 'STOCK_PLACE_CHANGED', entityType: 'StockPlace', entityId: placeId, metadata: { name: place.name, changed: Object.keys(data) } },
        });
      });
    } catch (error) {
      if (taken(error)) throw new ApplicationError(409, 'STOCK_PLACE_NAME_TAKEN', 'There is already a place with that name.');
      throw error;
    }
    return this.places(user);
  }

  /** A van's technician is one of this office's technicians; a stockroom has none. */
  private async vanTechnician(organizationId: string, kind: StockPlaceKind, technicianId: string | null): Promise<string | null> {
    if (kind !== StockPlaceKind.VAN || !technicianId) return null;
    const member = await this.prisma.organizationMember.findFirst({ where: { organizationId, userProfileId: technicianId, role: UserRole.INSPECTION_TECHNICIAN }, select: { id: true } });
    if (!member) throw new ApplicationError(400, 'STOCK_TECHNICIAN_NOT_FOUND', 'That person is not one of this office\'s technicians.');
    return technicianId;
  }

  // ── Vendors ─────────────────────────────────────────────────────────────

  async vendors(user: AuthenticatedUser): Promise<Vendors> {
    const vendors: VendorRow[] = await this.prisma.vendor.findMany({ where: { organizationId: user.organizationId }, select: VENDOR_SELECT, orderBy: [{ active: 'desc' }, { nameKey: 'asc' }] });
    return { vendors };
  }

  async createVendor(user: AuthenticatedUser, input: SaveVendorInput): Promise<Vendors> {
    const organizationId = user.organizationId;
    const name = text(input.name);
    if (!name) throw new ApplicationError(400, 'VENDOR_INCOMPLETE', 'A vendor needs a name.');
    try {
      await this.prisma.$transaction(async (tx) => {
        const vendor = await tx.vendor.create({
          data: { organizationId, name, nameKey: stockKey(name), contactName: text(input.contactName), email: text(input.email), phone: text(input.phone), terms: text(input.terms), notes: input.notes?.trim() || null },
          select: { id: true },
        });
        await tx.auditLog.create({ data: { organizationId, ...auditActor(user), action: 'VENDOR_CREATED', entityType: 'Vendor', entityId: vendor.id, metadata: { name } } });
      });
    } catch (error) {
      if (taken(error)) throw new ApplicationError(409, 'VENDOR_NAME_TAKEN', `There is already a vendor called ${name}.`);
      throw error;
    }
    return this.vendors(user);
  }

  async updateVendor(user: AuthenticatedUser, vendorId: string, input: SaveVendorInput): Promise<Vendors> {
    const organizationId = user.organizationId;
    const data: Prisma.VendorUncheckedUpdateInput = {};
    if (sent(input, 'name')) {
      const name = text(input.name);
      if (!name) throw new ApplicationError(400, 'VENDOR_INCOMPLETE', 'A vendor needs a name.');
      data.name = name;
      data.nameKey = stockKey(name);
    }
    for (const field of ['contactName', 'email', 'phone', 'terms'] as const) if (sent(input, field)) data[field] = text(input[field]);
    if (sent(input, 'notes')) data.notes = input.notes?.trim() || null;
    if (sent(input, 'active')) data.active = input.active;
    try {
      await this.prisma.$transaction(async (tx) => {
        const vendor = await tx.vendor.findFirst({ where: { id: vendorId, organizationId }, select: { name: true } });
        if (!vendor) throw new ApplicationError(404, 'VENDOR_NOT_FOUND', 'That vendor is not on the list.');
        if (!Object.keys(data).length) return;
        await tx.vendor.update({ where: { id: vendorId }, data });
        await tx.auditLog.create({
          data: { organizationId, ...auditActor(user), action: 'VENDOR_CHANGED', entityType: 'Vendor', entityId: vendorId, metadata: { name: vendor.name, changed: Object.keys(data) } },
        });
      });
    } catch (error) {
      if (taken(error)) throw new ApplicationError(409, 'VENDOR_NAME_TAKEN', 'There is already a vendor with that name.');
      throw error;
    }
    return this.vendors(user);
  }
}
