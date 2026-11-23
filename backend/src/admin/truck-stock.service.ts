import { Inject, Injectable } from '@nestjs/common';
import { StockPlaceKind, TruckStockAskStatus, type Prisma } from '@prisma/client';
import { MOST_KEEP_LEVELS, type SaveTruckKeepLevelsInput, type TruckAsk, type TruckAskList, type TruckKeepLevels } from '@texasrenters/shared';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

/**
 * The trucks on the console (the office, 2026-11-24, approved on the
 * Inventory Screens canvas): what the office keeps on each truck of an item
 * ("keep at least", set on Places), and the asks technicians send from the
 * phone for more. An ask is only an ask: the office fills it with a move from
 * the Storeroom on the Withdrawals tab, and posting that move marks it filled
 * (`markFilled`, in the move's own transaction). Nothing here calls anything
 * billed.
 */

type Db = Prisma.TransactionClient | PrismaService;

/** The filled asks the console lists after the waiting ones. */
const FILLED_SHOWN = 20;
/** The items a truck's keep levels list: every item in use, which an office keeps few of. */
const MOST_ITEMS_LISTED = 2000;

export const ASK_SELECT = {
  id: true,
  note: true,
  status: true,
  createdAt: true,
  filledAt: true,
  filledByName: true,
  place: { select: { id: true, name: true } },
  askedBy: { select: { id: true, displayName: true } },
  filledSlip: { select: { number: true } },
  lines: { orderBy: { position: 'asc' }, select: { quantity: true, item: { select: { id: true, code: true, name: true, unit: true } } } },
} satisfies Prisma.TruckStockAskSelect;

export function askRow(ask: Prisma.TruckStockAskGetPayload<{ select: typeof ASK_SELECT }>): TruckAsk {
  return {
    id: ask.id,
    place: ask.place,
    askedBy: { id: ask.askedBy.id, name: ask.askedBy.displayName },
    at: ask.createdAt.toISOString(),
    note: ask.note,
    status: ask.status,
    lines: ask.lines.map((line) => ({ itemId: line.item.id, code: line.item.code, name: line.item.name, unit: line.item.unit, quantity: line.quantity })),
    filled: ask.status === TruckStockAskStatus.FILLED && ask.filledSlip && ask.filledAt ? { slipNumber: ask.filledSlip.number, at: ask.filledAt.toISOString(), by: ask.filledByName ?? 'The office' } : null,
  };
}

@Injectable()
export class TruckStockService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** The asks from the trucks: waiting ones oldest first, then the latest filled. Two reads. */
  async asks(user: AuthenticatedUser): Promise<TruckAskList> {
    const organizationId = user.organizationId;
    const [waiting, filled] = await Promise.all([
      this.prisma.truckStockAsk.findMany({ where: { organizationId, status: TruckStockAskStatus.ASKED }, select: ASK_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      this.prisma.truckStockAsk.findMany({ where: { organizationId, status: TruckStockAskStatus.FILLED }, select: ASK_SELECT, orderBy: [{ filledAt: 'desc' }, { id: 'desc' }], take: FILLED_SHOWN }),
    ]);
    return { asks: [...waiting, ...filled].map(askRow) };
  }

  /** A truck's keep levels: every item in use, those kept or held there first. Three reads. */
  async keepLevels(user: AuthenticatedUser, placeId: string): Promise<TruckKeepLevels> {
    const organizationId = user.organizationId;
    const place = await this.truck(this.prisma, organizationId, placeId);
    const [items, keeps, levels] = await Promise.all([
      this.prisma.stockItem.findMany({
        where: { organizationId, active: true, OR: [{ lineTypeId: null }, { lineType: { keepsStock: true } }] },
        select: { id: true, code: true, name: true, unit: true },
        orderBy: { codeKey: 'asc' },
        take: MOST_ITEMS_LISTED,
      }),
      this.prisma.stockKeepLevel.findMany({ where: { organizationId, placeId }, select: { itemId: true, keepAtLeast: true } }),
      this.prisma.stockLevel.findMany({ where: { organizationId, placeId }, select: { itemId: true, quantity: true } }),
    ]);
    const keepOf = new Map(keeps.map((keep) => [keep.itemId, keep.keepAtLeast]));
    const onHandOf = new Map(levels.map((level) => [level.itemId, level.quantity]));
    const rows = items.map((item) => ({ itemId: item.id, code: item.code, name: item.name, unit: item.unit, keepAtLeast: keepOf.get(item.id) ?? null, onHand: onHandOf.get(item.id) ?? 0 }));
    const there = (row: (typeof rows)[number]) => row.keepAtLeast !== null || row.onHand > 0;
    return { place, levels: [...rows.filter(there), ...rows.filter((row) => !there(row))] };
  }

  /** Sets what the office keeps on the truck: each item sent, a level or none. Audited once. */
  async saveKeepLevels(user: AuthenticatedUser, placeId: string, input: SaveTruckKeepLevelsInput): Promise<TruckKeepLevels> {
    const organizationId = user.organizationId;
    const ids = input.levels.map((level) => level.itemId);
    if (new Set(ids).size !== ids.length) throw new ApplicationError(400, 'STOCK_KEEP_ITEM_TWICE', 'An item is in the list twice.');
    if (ids.length > MOST_KEEP_LEVELS) throw new ApplicationError(400, 'STOCK_KEEP_TOO_MANY', `One save sets at most ${MOST_KEEP_LEVELS} items.`);
    await this.prisma.$transaction(async (tx) => {
      const place = await this.truck(tx, organizationId, placeId);
      const items = ids.length ? await tx.stockItem.findMany({ where: { organizationId, id: { in: ids }, active: true }, select: { id: true } }) : [];
      if (items.length !== ids.length) throw new ApplicationError(400, 'STOCK_ITEM_NOT_FOUND', 'One of the items is not in the inventory, or is switched off.');
      const none = input.levels.filter((level) => !level.keepAtLeast).map((level) => level.itemId);
      const keep = input.levels.filter((level) => level.keepAtLeast);
      if (none.length) await tx.stockKeepLevel.deleteMany({ where: { organizationId, placeId, itemId: { in: none } } });
      for (const level of keep)
        await tx.stockKeepLevel.upsert({
          where: { placeId_itemId: { placeId, itemId: level.itemId } },
          create: { organizationId, placeId, itemId: level.itemId, keepAtLeast: level.keepAtLeast!, updatedById: user.principalType === 'API_KEY' ? null : user.id },
          update: { keepAtLeast: level.keepAtLeast!, updatedById: user.principalType === 'API_KEY' ? null : user.id },
        });
      await tx.auditLog.create({ data: { organizationId, ...auditActor(user), action: 'STOCK_KEEP_LEVELS_SET', entityType: 'StockPlace', entityId: placeId, metadata: { place: place.name, set: keep.length, cleared: none.length } } });
    });
    return this.keepLevels(user, placeId);
  }

  /**
   * Marks an ask filled by the move just posted, in that move's transaction:
   * the move goes into the ask's own truck, and an ask is filled once.
   */
  async markFilled(tx: Prisma.TransactionClient, user: AuthenticatedUser, askId: string, slipId: string, toPlaceId: string | null): Promise<void> {
    const organizationId = user.organizationId;
    const ask = await tx.truckStockAsk.findFirst({ where: { id: askId, organizationId }, select: { placeId: true, status: true, place: { select: { name: true } } } });
    if (!ask) throw new ApplicationError(404, 'TRUCK_ASK_NOT_FOUND', 'That ask is not on the list.');
    if (ask.placeId !== toPlaceId) throw new ApplicationError(400, 'TRUCK_ASK_OTHER_TRUCK', `That ask is for ${ask.place.name}: move the stock into it.`);
    const filled = await tx.truckStockAsk.updateMany({
      where: { id: askId, organizationId, status: TruckStockAskStatus.ASKED },
      data: { status: TruckStockAskStatus.FILLED, filledSlipId: slipId, filledAt: new Date(), filledById: user.principalType === 'API_KEY' ? null : user.id, filledByName: user.displayName },
    });
    if (filled.count !== 1) throw new ApplicationError(409, 'TRUCK_ASK_FILLED', 'That ask has been filled already.');
    await tx.auditLog.create({ data: { organizationId, ...auditActor(user), action: 'TRUCK_STOCK_ASK_FILLED', entityType: 'TruckStockAsk', entityId: askId, metadata: { place: ask.place.name } } });
  }

  /** A truck of this office, in use: keep levels are a truck's alone. */
  private async truck(db: Db, organizationId: string, placeId: string) {
    const place = await db.stockPlace.findFirst({ where: { id: placeId, organizationId }, select: { id: true, name: true, code: true, kind: true, active: true } });
    if (!place) throw new ApplicationError(404, 'STOCK_PLACE_NOT_FOUND', 'That place is not on the list.');
    if (place.kind !== StockPlaceKind.VAN) throw new ApplicationError(400, 'STOCK_PLACE_NOT_A_TRUCK', 'What is kept at least is set for a truck. The Storeroom is filled by ordering.');
    return { id: place.id, name: place.name, code: place.code };
  }
}
