import { Inject, Injectable } from '@nestjs/common';
import { Prisma, StockMovementKind, StockPlaceKind, UserRole } from '@prisma/client';
import {
  STOCK_MOVEMENTS_SHOWN,
  STOCK_PREFIX,
  averageCostCents,
  stockCode,
  STOCK_CODE,
  normalizeStockCode,
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
  normalizePurchasingCode,
  purchasingCodeProblem,
  suggestedPlaceCode,
} from '@texasrenters/shared';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { businessDate, dayWords } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { assertStockNotFrozen } from './stock-freeze';
import { defaultLineTypeId, lineTypeOf } from './purchasing-codes.service';
import { nextDocumentCode } from './purchasing-settings';

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
/** Which unique index refused it: a place's name and its code are both unique. */
const takenOn = (error: unknown, column: string) => taken(error) && JSON.stringify((error as Prisma.PrismaClientKnownRequestError).meta?.target ?? '').includes(column);

const ITEM_SELECT = {
  id: true,
  code: true,
  name: true,
  unit: true,
  category: { select: { id: true, name: true } },
  xeroTenantId: true,
  reorderLevel: true,
  reorderQuantity: true,
  priceCents: true,
  active: true,
  usualVendor: { select: { id: true, name: true } },
  lineType: { select: { id: true, code: true, name: true, keepsStock: true } },
} satisfies Prisma.StockItemSelect;
type ItemRecord = Prisma.StockItemGetPayload<{ select: typeof ITEM_SELECT }>;

const PLACE_SELECT = {
  id: true,
  name: true,
  code: true,
  kind: true,
  technicianId: true,
  active: true,
  technician: { select: { displayName: true } },
} satisfies Prisma.StockPlaceSelect;
type PlaceRecord = Prisma.StockPlaceGetPayload<{ select: typeof PLACE_SELECT }>;

const VENDOR_SELECT = { id: true, number: true, name: true, contactName: true, email: true, phone: true, terms: true, notes: true, active: true } satisfies Prisma.VendorSelect;

interface Level {
  itemId: string;
  placeId: string;
  quantity: number;
  valueCents: number;
}

const placeRow = (place: PlaceRecord, itemsHeld = 0): StockPlaceRow => ({
  id: place.id,
  name: place.name,
  code: place.code,
  kind: place.kind,
  technicianId: place.technicianId,
  technicianName: place.technician?.displayName ?? null,
  itemsHeld,
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
  // Stock leaves at a rounded average, which can leave a cent or two behind once the last unit has gone.
  if (onHand <= 0) valueCents = 0;
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
    lineType: item.lineType,
    priceCents: item.priceCents,
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

  /** Every item with what is on hand: seven reads, whatever the number of items. */
  async stock(user: AuthenticatedUser): Promise<StockList> {
    const organizationId = user.organizationId;
    const [items, levels, places, organisations, vendors, categories, lineTypes] = await Promise.all([
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
      this.prisma.purchasingCode.findMany({ where: { organizationId, kind: 'LINE_TYPE' }, select: { id: true, code: true, name: true, keepsStock: true, active: true }, orderBy: [{ active: 'desc' }, { code: 'asc' }] }),
    ]);
    const kinds = new Map(places.map((place) => [place.id, place.kind]));
    const names = new Map(organisations.map((row) => [row.xeroTenantId, row.name]));
    const byItem = new Map<string, Level[]>();
    for (const level of levels) byItem.set(level.itemId, [...(byItem.get(level.itemId) ?? []), level]);
    return {
      items: items.map((item) => itemRow(item, byItem.get(item.id) ?? [], kinds, names)),
      places: places.map((place) => placeRow(place, levels.filter((level) => level.placeId === place.id && level.quantity > 0).length)),
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
      lineTypes,
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
    const typed = sent(input, 'code') ? this.typedCode(input.code) : null;
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const category = await tx.stockCategory.findFirst({ where: { id: categoryId, organizationId, active: true }, select: { prefix: true } });
        if (!category) throw new ApplicationError(400, 'STOCK_CATEGORY_NOT_FOUND', 'That category is not in use.');
        // Typed by the stock keeper, or the category's next number.
        const code = typed ?? (await this.nextCode(tx, organizationId, categoryId, category.prefix));
        if (typed) await this.codeIsFree(tx, organizationId, typed);
        // An Item unless the stock keeper chose another type.
        const lineTypeId = input.lineTypeId ? (await lineTypeOf(tx, organizationId, input.lineTypeId)).id : await defaultLineTypeId(tx, organizationId);
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
            priceCents: input.priceCents ?? null,
            lineTypeId,
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
      // Two people adding the same code in the same moment: the database lets one in.
      if (taken(error)) throw new ApplicationError(409, 'STOCK_ITEM_CODE_TAKEN', typed ? `${typed} was just taken. Choose another code.` : 'That code was just taken. Add the item again.');
      throw error;
    }
  }

  /** A code as the stock keeper typed it, in capitals, or the reason it will not do. */
  private typedCode(value: string | undefined): string {
    const code = normalizeStockCode(value ?? '');
    if (!STOCK_CODE.test(code)) throw new ApplicationError(400, 'STOCK_ITEM_CODE_INVALID', 'An item code is 2 to 24 capitals, digits and dashes, like FLT-16251.');
    return code;
  }

  /** Refuses a code another item of this office has, naming that item. */
  private async codeIsFree(db: Prisma.TransactionClient, organizationId: string, code: string, exceptItemId?: string): Promise<void> {
    const other = await db.stockItem.findFirst({ where: { organizationId, codeKey: stockKey(code), ...(exceptItemId ? { id: { not: exceptItemId } } : {}) }, select: { code: true, name: true } });
    if (other) throw new ApplicationError(409, 'STOCK_ITEM_CODE_TAKEN', `${other.code} is already ${other.name}. Choose another code.`);
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
    if (sent(input, 'priceCents')) data.priceCents = input.priceCents ?? null;
    if (sent(input, 'active')) data.active = input.active;
    if (sent(input, 'lineTypeId') && input.lineTypeId) {
      const type = await lineTypeOf(this.prisma, organizationId, input.lineTypeId);
      // An item on a shelf stays a type that keeps stock: the console would stop counting what is there.
      if (!type.keepsStock) {
        const held = await this.prisma.stockLevel.findFirst({ where: { organizationId, itemId, quantity: { not: 0 } }, select: { quantity: true } });
        if (held) throw new ApplicationError(409, 'LINE_TYPE_HAS_STOCK', `That item has stock on hand, so it stays a type that keeps stock. ${type.code} keeps none.`);
      }
      data.lineTypeId = type.id;
    }
    const typed = sent(input, 'code') ? this.typedCode(input.code) : null;
    await this.prisma.$transaction(async (tx) => {
      const item = await tx.stockItem.findFirst({ where: { id: itemId, organizationId }, select: { id: true, code: true, xeroTenantId: true, active: true, categoryId: true } });
      if (!item) throw new ApplicationError(404, 'STOCK_ITEM_NOT_FOUND', 'That item is not in the inventory.');
      // A code people have already asked for, ordered or counted by stays: papers that name it would no longer find it.
      if (typed && typed !== item.code) {
        const [moved, requested, ordered] = await Promise.all([
          tx.stockMovement.count({ where: { organizationId, itemId } }),
          tx.purchaseRequisitionLine.count({ where: { organizationId, itemId } }),
          tx.purchaseOrderLine.count({ where: { organizationId, itemId } }),
        ]);
        if (moved + requested + ordered > 0) throw new ApplicationError(409, 'STOCK_ITEM_CODE_FIXED', `${item.code} has been requested, ordered or stocked, so its code stays.`);
        await this.codeIsFree(tx, organizationId, typed, itemId);
        data.code = typed;
        data.codeKey = stockKey(typed);
      }
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
    if (day > today) throw new ApplicationError(400, 'STOCK_DAY_AHEAD', `An opening balance cannot be dated after today. It is ${dayWords(today)} in Texas.`);
    const write = () =>
      this.prisma.$transaction(async (tx) => {
        const already = await tx.stockMovement.findFirst({ where: { organizationId, requestKey: input.requestKey }, select: { itemId: true } });
        if (already) {
          if (already.itemId !== itemId) throw new ApplicationError(409, 'STOCK_REQUEST_REUSED', 'That entry was already made for another item.');
          return;
        }
        await assertStockNotFrozen(tx, organizationId);
        const [item, place] = await Promise.all([
          tx.stockItem.findFirst({ where: { id: itemId, organizationId }, select: { code: true, active: true } }),
          tx.stockPlace.findFirst({ where: { id: input.placeId, organizationId }, select: { name: true, active: true } }),
        ]);
        if (!item) throw new ApplicationError(404, 'STOCK_ITEM_NOT_FOUND', 'That item is not in the inventory.');
        if (!place) throw new ApplicationError(404, 'STOCK_PLACE_NOT_FOUND', 'That place is not on the list.');
        if (!item.active || !place.active) throw new ApplicationError(409, 'STOCK_SWITCHED_OFF', 'Stock cannot be entered for an item or a place that is switched off.');
        // Two people entering the same item and place at once: the second waits here, then sees the first.
        // Cast to text: the lock answers `void`, which Prisma cannot read back, and every entry failed with a 500 (2026-11-19).
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`stock-opening:${itemId}:${input.placeId}`}, 0))::text AS locked`;
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
        await assertStockNotFrozen(tx, organizationId);
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
    const [places, held, members] = await Promise.all([
      this.prisma.stockPlace.findMany({ where: { organizationId }, select: PLACE_SELECT, orderBy: [{ active: 'desc' }, { kind: 'asc' }, { nameKey: 'asc' }] }),
      // How many different items each place has any of: one grouped read, whatever the number of places.
      this.prisma.stockLevel.groupBy({ by: ['placeId'], where: { organizationId, quantity: { gt: 0 } }, _count: { _all: true } }),
      this.prisma.organizationMember.findMany({
        where: { organizationId, role: UserRole.INSPECTION_TECHNICIAN, userProfile: { isActive: true } },
        select: { userProfile: { select: { id: true, displayName: true } } },
      }),
    ]);
    const technicians = new Map(members.map(({ userProfile }) => [userProfile.id, userProfile.displayName]));
    const itemsHeld = new Map(held.map((row) => [row.placeId, row._count._all]));
    return {
      places: places.map((place) => placeRow(place, itemsHeld.get(place.id) ?? 0)),
      technicians: [...technicians].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  async createPlace(user: AuthenticatedUser, input: SaveStockPlaceInput): Promise<StockPlaces> {
    const organizationId = user.organizationId;
    const name = text(input.name);
    if (!name) throw new ApplicationError(400, 'STOCK_PLACE_INCOMPLETE', 'A place needs a name.');
    const kind = input.kind ?? StockPlaceKind.STOCKROOM;
    const technicianId = await this.vanTechnician(organizationId, kind, input.technicianId ?? null);
    const typed = input.code !== undefined ? this.placeCode(input.code) : null;
    try {
      await this.prisma.$transaction(async (tx) => {
        // Typed by the stock keeper, or made from the name and numbered past any already taken.
        const code = typed ?? (await this.freePlaceCode(tx, organizationId, suggestedPlaceCode(name)));
        const place = await tx.stockPlace.create({ data: { organizationId, name, nameKey: stockKey(name), code, kind, technicianId }, select: { id: true } });
        await tx.auditLog.create({
          data: { organizationId, ...auditActor(user), action: 'STOCK_PLACE_CREATED', entityType: 'StockPlace', entityId: place.id, metadata: { name, code, kind } },
        });
      });
    } catch (error) {
      if (takenOn(error, 'code')) throw new ApplicationError(409, 'STOCK_PLACE_CODE_TAKEN', `${typed ?? 'That code'} is already another place's location code.`);
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
        if (sent(input, 'code')) data.code = this.placeCode(input.code);
        // A place keeps its kind: a storeroom is where deliveries land and a truck is what a technician takes from.
        if (sent(input, 'kind') && input.kind !== place.kind) throw new ApplicationError(409, 'STOCK_PLACE_KIND_FIXED', `${place.name} keeps its kind. Make another place instead.`);
        const kind = place.kind;
        if (sent(input, 'technicianId')) data.technicianId = await this.vanTechnician(organizationId, kind, input.technicianId ?? null);
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
      if (takenOn(error, 'code')) throw new ApplicationError(409, 'STOCK_PLACE_CODE_TAKEN', 'That is already another place\'s location code.');
      if (taken(error)) throw new ApplicationError(409, 'STOCK_PLACE_NAME_TAKEN', 'There is already a place with that name.');
      throw error;
    }
    return this.places(user);
  }

  /** A location code as typed, in capitals, or the reason it will not do. */
  private placeCode(value: string | undefined): string {
    const problem = purchasingCodeProblem(value ?? '');
    if (problem) throw new ApplicationError(400, 'STOCK_PLACE_CODE_INVALID', problem);
    return normalizePurchasingCode(value ?? '');
  }

  /** The suggested code, or the same with -2, -3... where another place has it. */
  private async freePlaceCode(db: Prisma.TransactionClient, organizationId: string, stem: string): Promise<string> {
    const taken = new Set((await db.stockPlace.findMany({ where: { organizationId, code: { startsWith: stem } }, select: { code: true } })).map((place) => place.code));
    if (!taken.has(stem)) return stem;
    for (let n = 2; n < 1000; n += 1) {
      const code = `${stem.slice(0, 16)}-${n}`;
      if (!taken.has(code)) return code;
    }
    throw new ApplicationError(409, 'STOCK_PLACE_CODE_TAKEN', 'Give the place a location code of its own.');
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
        // Numbered by the console, under the series row's lock: two vendors added at once never share one.
        const number = await nextDocumentCode(tx, organizationId, 'V');
        const vendor = await tx.vendor.create({
          data: { organizationId, number, name, nameKey: stockKey(name), contactName: text(input.contactName), email: text(input.email), phone: text(input.phone), terms: text(input.terms), notes: input.notes?.trim() || null },
          select: { id: true },
        });
        await tx.auditLog.create({ data: { organizationId, ...auditActor(user), action: 'VENDOR_CREATED', entityType: 'Vendor', entityId: vendor.id, metadata: { name, number } } });
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
