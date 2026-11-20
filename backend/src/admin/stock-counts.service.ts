import { Inject, Injectable } from '@nestjs/common';
import { Prisma, StockCountKind, StockCountStatus, StockMovementKind, StockPlaceKind } from '@prisma/client';
import {
  MOST_COUNT_LINES,
  STOCK_COUNTS_SHOWN,
  STOCK_COUNT_KINDS,
  STOCK_COUNT_REASON_LABEL,
  startStockCountProblem,
  stockCountCoversPeriod,
  stockCountDifference,
  stockCountDue,
  stockCountReasonsFor,
  stockCountTitle,
  type CancelStockCountInput,
  type PostStockCountInput,
  type SaveStockCountInput,
  type StartStockCountInput,
  type StockCountChoices,
  type StockCountDetail,
  type StockCountLineRow,
  type StockCountList,
  type StockCountSummary,
} from '@texasrenters/shared';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { nextDocumentCode } from './purchasing-settings';
import { OPEN_COUNT } from './stock-freeze';

/**
 * Inventory counts (2026-11-19, phase 6 of the inventory and purchasing
 * plan): monthly, quarterly and yearly.
 *
 * One person counts, and is never shown what the console expects while the
 * count is open. What was expected is written the moment the count is handed
 * in, in the same transaction, so a difference is what the shelf differed by
 * at that moment whatever moves afterwards. A difference worth more than the
 * recount limit goes back to be counted a second time before anybody sees it
 * for approval. Somebody else reviews, gives each difference a reason, and
 * posts: one COUNT_ADJUSTMENT movement a line that differed, at what the item
 * cost when it was counted. The counter never approves (here and in the
 * database), and no API key holds either permission.
 *
 * A place is in one unfinished count at a time, and while a yearly count is
 * open no other stock moves (stock-freeze.ts). Every step is audited.
 * Nothing here calls anything billed, and nothing is polled.
 */

const ENTITY = 'StockCount';
const COUNT = 'inventory:count';
const APPROVE = 'inventory:count-approve';
/** A yearly count writes thousands of lines in a handful of statements; the pooler is remote. */
const LONG = { maxWait: 10_000, timeout: 30_000 } as const;
const FAST_MOVER_DAYS = 90;

type Db = Prisma.TransactionClient;
const text = (value: string | null | undefined) => value?.trim().replace(/\s+/g, ' ') || null;
const dateOf = (day: string) => new Date(`${day}T00:00:00.000Z`);
const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const taken = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
const outOfStock = (error: unknown) => String((error as { message?: unknown } | null)?.message ?? error).includes('StockLevel_never_below_nothing');
const may = (user: AuthenticatedUser, permission: string) => (user.permissions as readonly string[]).includes(permission);
const personId = (user: AuthenticatedUser) => (user.principalType === 'API_KEY' ? null : user.id);

const SUMMARY = {
  id: true,
  number: true,
  kind: true,
  status: true,
  day: true,
  countedById: true,
  countedByName: true,
  netValueCents: true,
  place: { select: { id: true, name: true } },
} satisfies Prisma.StockCountSelect;
type Summary = Prisma.StockCountGetPayload<{ select: typeof SUMMARY }>;

const DETAIL = {
  ...SUMMARY,
  note: true,
  startedById: true,
  startedByName: true,
  createdAt: true,
  submittedAt: true,
  approvedByName: true,
  postedAt: true,
  cancelledAt: true,
  cancelledByName: true,
  cancelReason: true,
  lines: {
    select: {
      id: true,
      itemId: true,
      countedQuantity: true,
      recount: true,
      expectedQuantity: true,
      unitCostCents: true,
      reason: true,
      item: { select: { code: true, name: true, unit: true } },
      place: { select: { id: true, name: true } },
    },
    orderBy: [{ place: { nameKey: 'asc' } }, { item: { codeKey: 'asc' } }],
  },
} satisfies Prisma.StockCountSelect;
type Detail = Prisma.StockCountGetPayload<{ select: typeof DETAIL }>;

function summary(count: Summary, lines: number, counted: number): StockCountSummary {
  const day = dayOf(count.day);
  return {
    id: count.id,
    number: count.number,
    kind: count.kind,
    title: stockCountTitle(count.kind, day),
    status: count.status,
    place: count.place,
    day,
    lines,
    counted,
    countedBy: count.countedByName,
    netValueCents: count.netValueCents,
  };
}

/**
 * The count as this person may see it. The expected numbers, and so the
 * differences, are left out for whoever counted until it is posted, and for
 * anybody who may not approve.
 */
function detail(count: Detail, user: AuthenticatedUser): StockCountDetail {
  const open = OPEN_COUNT.includes(count.status);
  const counter = count.countedById !== null && count.countedById === personId(user);
  const approver = may(user, APPROVE) && personId(user) !== null && !counter;
  const reviewing = count.status === StockCountStatus.POSTED || approver;
  let matched = 0;
  let different = 0;
  const rows: StockCountLineRow[] = count.lines.map((line) => {
    const known = reviewing && line.expectedQuantity !== null && line.countedQuantity !== null && line.unitCostCents !== null;
    const found = known ? stockCountDifference(line.expectedQuantity!, line.countedQuantity!, line.unitCostCents!) : null;
    if (found?.difference === 0) matched += 1;
    else if (found) different += 1;
    return {
      id: line.id,
      itemId: line.itemId,
      itemCode: line.item.code,
      itemName: line.item.name,
      unit: line.item.unit,
      place: line.place,
      counted: line.countedQuantity,
      waiting: open && line.expectedQuantity === null,
      recount: line.recount,
      expected: known ? line.expectedQuantity : null,
      difference: found?.difference ?? null,
      valueCents: found?.valueCents ?? null,
      reason: reviewing ? line.reason : null,
    };
  });
  const counting = count.status === StockCountStatus.OPEN || count.status === StockCountStatus.COUNTING;
  return {
    ...summary(count, count.lines.length, count.lines.filter((line) => line.countedQuantity !== null).length),
    note: count.note,
    startedBy: count.startedByName,
    startedAt: count.createdAt.toISOString(),
    submittedAt: count.submittedAt?.toISOString() ?? null,
    approvedBy: count.approvedByName,
    postedAt: count.postedAt?.toISOString() ?? null,
    cancelled: count.cancelledAt ? { by: count.cancelledByName ?? 'Somebody', at: count.cancelledAt.toISOString(), reason: count.cancelReason ?? '' } : null,
    reviewing,
    matched: reviewing ? matched : null,
    different: reviewing ? different : null,
    rows,
    can: {
      count: counting && may(user, COUNT) && personId(user) !== null && (count.countedById === null || counter),
      recount: approver && count.status === StockCountStatus.REVIEW,
      post: approver && count.status === StockCountStatus.REVIEW,
      // Anybody who may approve stops an unfinished count; whoever started one nobody has counted yet takes it back.
      cancel: open && ((may(user, APPROVE) && personId(user) !== null) || (count.status === StockCountStatus.OPEN && may(user, COUNT) && count.startedById === personId(user))),
    },
  };
}

@Injectable()
export class StockCountsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** The latest counts, and when each kind is next due: three reads. */
  async list(user: AuthenticatedUser): Promise<StockCountList> {
    const organizationId = user.organizationId;
    const today = businessDate();
    const [counts, posted] = await Promise.all([
      this.prisma.stockCount.findMany({ where: { organizationId }, select: { ...SUMMARY, _count: { select: { lines: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: STOCK_COUNTS_SHOWN }),
      this.prisma.stockCount.findMany({ where: { organizationId, status: StockCountStatus.POSTED }, select: { kind: true, number: true, day: true }, orderBy: { postedAt: 'desc' }, distinct: ['kind'] }),
    ]);
    const done = counts.length
      ? await this.prisma.stockCountLine.groupBy({ by: ['countId'], where: { organizationId, countId: { in: counts.map((count) => count.id) }, countedQuantity: { not: null } }, _count: { _all: true } })
      : [];
    const counted = new Map(done.map((row) => [row.countId, row._count._all]));
    return {
      counts: counts.map((count) => summary(count, count._count.lines, counted.get(count.id) ?? 0)),
      schedule: STOCK_COUNT_KINDS.map((kind) => {
        // This period's count: the newest of its kind that was not cancelled.
        const current = counts.find((count) => count.kind === kind && count.status !== StockCountStatus.CANCELLED && stockCountCoversPeriod(kind, dayOf(count.day), today));
        const last = posted.find((count) => count.kind === kind);
        return {
          kind,
          due: stockCountDue(kind, today),
          current: current ? { id: current.id, number: current.number, status: current.status } : null,
          lastPosted: last ? { number: last.number, day: dayOf(last.day) } : null,
        };
      }),
    };
  }

  /** What the "Start a count" form chooses from: three reads. */
  async choices(user: AuthenticatedUser): Promise<StockCountChoices> {
    const organizationId = user.organizationId;
    const since = new Date(Date.now() - FAST_MOVER_DAYS * 86_400_000);
    const [places, items, moved] = await Promise.all([
      this.prisma.stockPlace.findMany({ where: { organizationId, active: true }, select: { id: true, name: true }, orderBy: [{ kind: 'asc' }, { nameKey: 'asc' }] }),
      this.prisma.stockItem.findMany({ where: { organizationId, active: true }, select: { id: true, code: true, name: true }, orderBy: { codeKey: 'asc' } }),
      this.prisma.stockMovement.groupBy({
        by: ['placeId', 'itemId'],
        where: { organizationId, kind: StockMovementKind.WITHDRAWAL, createdAt: { gte: since } },
        _sum: { quantity: true },
        // Withdrawals are negative: the most taken first.
        orderBy: { _sum: { quantity: 'asc' } },
        take: 500,
      }),
    ]);
    return { places, items, fastMovers: moved.map(({ placeId, itemId }) => ({ placeId, itemId })) };
  }

  async get(user: AuthenticatedUser, countId: string): Promise<StockCountDetail> {
    return detail(await this.read(this.prisma, user.organizationId, countId), user);
  }

  private async read(db: Pick<Db, 'stockCount'>, organizationId: string, countId: string): Promise<Detail> {
    const count = await db.stockCount.findFirst({ where: { id: countId, organizationId }, select: DETAIL });
    if (!count) throw new ApplicationError(404, 'STOCK_COUNT_NOT_FOUND', 'That count is not on the list.');
    return count;
  }

  /** Starts a count and lists what is to be counted. Sent twice with the same key it starts one. */
  async start(user: AuthenticatedUser, input: StartStockCountInput): Promise<StockCountDetail> {
    const organizationId = user.organizationId;
    const kind = input.kind;
    const placeId = kind === StockCountKind.YEARLY ? null : input.placeId;
    const itemIds = kind === StockCountKind.MONTHLY ? [...new Set(input.itemIds)] : [];
    const problem = startStockCountProblem({ kind, placeId, itemIds });
    if (problem) throw new ApplicationError(400, 'STOCK_COUNT_NOT_READY', problem);

    let countId = '';
    try {
      await this.prisma.$transaction(async (tx) => {
        // One count is started at a time in an office, so two cannot both find the place free.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`stock-count:${organizationId}`}, 0))::text AS locked`;
        const prior = await tx.stockCount.findFirst({ where: { organizationId, requestKey: input.requestKey }, select: { id: true } });
        if (prior) {
          countId = prior.id;
          return;
        }
        const open = await tx.stockCount.findMany({ where: { organizationId, status: { in: OPEN_COUNT } }, select: { number: true, kind: true, placeId: true } });
        const yearly = open.find((count) => count.kind === StockCountKind.YEARLY);
        if (yearly) throw new ApplicationError(409, 'STOCK_COUNT_OVERLAPS', `The yearly count ${yearly.number} is open. Post or cancel it before starting another.`);
        if (kind === StockCountKind.YEARLY && open.length) throw new ApplicationError(409, 'STOCK_COUNT_OVERLAPS', `${open[0]!.number} is still open. Post or cancel it before starting the yearly count.`);
        const same = open.find((count) => count.placeId === placeId);
        if (same) throw new ApplicationError(409, 'STOCK_COUNT_OVERLAPS', `${same.number} is already counting that place. Post or cancel it first.`);

        const places = await tx.stockPlace.findMany({ where: { organizationId, active: true, ...(placeId ? { id: placeId } : {}) }, select: { id: true, kind: true } });
        if (!places.length) throw new ApplicationError(400, 'STOCK_PLACE_NOT_FOUND', placeId ? 'That place is not in use.' : 'There is no place to count yet.');
        const placeIds = places.map((place) => place.id);
        const [items, held] = await Promise.all([
          tx.stockItem.findMany({ where: { organizationId, active: true, ...(kind === StockCountKind.MONTHLY ? { id: { in: itemIds } } : {}) }, select: { id: true } }),
          // Whatever the ledger has ever put in the place is counted there, switched off or not.
          kind === StockCountKind.MONTHLY ? [] : tx.stockLevel.findMany({ where: { organizationId, placeId: { in: placeIds }, ...(kind === StockCountKind.QUARTERLY ? { quantity: { gt: 0 } } : {}) }, select: { itemId: true, placeId: true } }),
        ]);
        if (kind === StockCountKind.MONTHLY && items.length !== itemIds.length) throw new ApplicationError(400, 'STOCK_ITEM_NOT_FOUND', 'One of the items is not in the inventory, or is switched off.');

        const pairs = new Map<string, { itemId: string; placeId: string }>();
        const add = (itemId: string, at: string) => pairs.set(`${itemId}|${at}`, { itemId, placeId: at });
        for (const place of places) {
          // A van is counted for what it has carried; a stockroom, and a place counted alone, for every item in use.
          if (kind !== StockCountKind.YEARLY || place.kind === StockPlaceKind.STOCKROOM) for (const item of items) add(item.id, place.id);
        }
        for (const level of held) add(level.itemId, level.placeId);
        if (!pairs.size) throw new ApplicationError(409, 'STOCK_COUNT_NOTHING', 'There is nothing to count there yet.');
        if (pairs.size > MOST_COUNT_LINES) throw new ApplicationError(409, 'STOCK_COUNT_TOO_LARGE', `That is ${pairs.size} lines, more than one count holds. Count a place at a time.`);

        const today = businessDate();
        const number = await nextDocumentCode(tx, organizationId, 'CNT');
        const count = await tx.stockCount.create({
          data: { organizationId, number, kind, day: dateOf(today), placeId, note: text(input.note), requestKey: input.requestKey, startedById: personId(user), startedByName: user.displayName },
          select: { id: true },
        });
        await tx.stockCountLine.createMany({ data: [...pairs.values()].map((pair) => ({ organizationId, countId: count.id, ...pair })) });
        await tx.auditLog.create({ data: { organizationId, ...auditActor(user), action: 'STOCK_COUNT_STARTED', entityType: ENTITY, entityId: count.id, metadata: { number, kind, lines: pairs.size } } });
        countId = count.id;
      }, LONG);
    } catch (error) {
      // The unique indexes: the same press twice, or a place another count took in the same moment.
      if (!taken(error)) throw error;
      const prior = await this.prisma.stockCount.findFirst({ where: { organizationId, requestKey: input.requestKey }, select: { id: true } });
      if (!prior) throw new ApplicationError(409, 'STOCK_COUNT_OVERLAPS', 'Another count has just been started there. Open the Counts tab again.');
      countId = prior.id;
    }
    return this.get(user, countId);
  }

  /**
   * Keeps what has been counted so far; with `handIn`, hands the count in.
   * Handing in writes what the console expected of each line at that moment,
   * sends the differences over the recount limit back for a second count,
   * and puts the rest up for review.
   */
  async save(user: AuthenticatedUser, countId: string, input: SaveStockCountInput, handIn: boolean): Promise<StockCountDetail & { recounts: number }> {
    const organizationId = user.organizationId;
    const me = personId(user);
    if (!me) throw new ApplicationError(403, 'STOCK_COUNT_NEEDS_A_PERSON', 'A count is entered by a person at the screen.');
    const ids = input.lines.map((line) => line.lineId);
    if (new Set(ids).size !== ids.length) throw new ApplicationError(400, 'STOCK_COUNT_LINE_TWICE', 'A line is in the count twice.');
    let recounts = 0;

    await this.prisma.$transaction(async (tx) => {
      const count = await tx.stockCount.findFirst({ where: { id: countId, organizationId }, select: { number: true, status: true, countedById: true } });
      if (!count) throw new ApplicationError(404, 'STOCK_COUNT_NOT_FOUND', 'That count is not on the list.');
      if (count.status !== StockCountStatus.OPEN && count.status !== StockCountStatus.COUNTING) throw new ApplicationError(409, 'STOCK_COUNT_NOT_COUNTING', 'That count has been handed in. It can be counted again only where a second count is asked for.');
      if (count.countedById && count.countedById !== me) throw new ApplicationError(403, 'STOCK_COUNT_SOMEBODY_ELSE', 'Somebody else is counting this one.');
      // The first to enter a number is the counter, and stays so.
      const mine = await tx.stockCount.updateMany({
        where: { id: countId, organizationId, status: { in: [StockCountStatus.OPEN, StockCountStatus.COUNTING] }, OR: [{ countedById: null }, { countedById: me }] },
        data: { status: StockCountStatus.COUNTING, countedById: me, countedByName: user.displayName },
      });
      if (mine.count !== 1) throw new ApplicationError(409, 'STOCK_COUNT_NOT_COUNTING', 'That count has just changed. Open it again.');

      // A line already handed in is not counted over: only those still waiting.
      const waiting = await tx.stockCountLine.findMany({ where: { organizationId, countId, expectedQuantity: null }, select: { id: true, itemId: true, placeId: true, countedQuantity: true, recount: true } });
      const waitingOf = new Map(waiting.map((line) => [line.id, line]));
      if (ids.some((lineId) => !waitingOf.has(lineId))) throw new ApplicationError(400, 'STOCK_COUNT_LINE_NOT_OPEN', 'One of the lines is not waiting to be counted.');

      // Lines that share a number are written together: a few statements however long the count.
      const byNumber = new Map<number | null, string[]>();
      for (const line of input.lines) {
        if (waitingOf.get(line.lineId)!.countedQuantity === line.counted) continue;
        byNumber.set(line.counted, [...(byNumber.get(line.counted) ?? []), line.lineId]);
        waitingOf.get(line.lineId)!.countedQuantity = line.counted;
      }
      for (const [countedQuantity, lineIds] of byNumber) await tx.stockCountLine.updateMany({ where: { organizationId, countId, id: { in: lineIds }, expectedQuantity: null }, data: { countedQuantity } });
      if (!handIn) return;

      const left = waiting.filter((line) => line.countedQuantity === null).length;
      if (left) throw new ApplicationError(409, 'STOCK_COUNT_NOT_FINISHED', left === 1 ? '1 item is not counted yet.' : `${left} items are not counted yet.`);

      const itemIds = [...new Set(waiting.map((line) => line.itemId))];
      const [levels, lastCosts] = await Promise.all([
        tx.stockLevel.findMany({ where: { organizationId, itemId: { in: itemIds } }, select: { itemId: true, placeId: true, quantity: true, valueCents: true } }),
        // What one cost last, for an item with none on hand to average.
        tx.stockMovement.findMany({ where: { organizationId, itemId: { in: itemIds } }, orderBy: { createdAt: 'desc' }, distinct: ['itemId'], select: { itemId: true, unitCostCents: true } }),
      ]);
      const there = new Map(levels.map((level) => [`${level.itemId}|${level.placeId}`, level.quantity]));
      const cost = new Map(lastCosts.map((movement) => [movement.itemId, movement.unitCostCents]));
      for (const itemId of itemIds) {
        const held = levels.filter((level) => level.itemId === itemId);
        const quantity = held.reduce((sum, level) => sum + level.quantity, 0);
        if (quantity > 0) cost.set(itemId, Math.max(0, Math.round(held.reduce((sum, level) => sum + level.valueCents, 0) / quantity)));
      }

      const again: string[] = [];
      const settled: { id: string; expected: number; cost: number }[] = [];
      for (const line of waiting) {
        const expected = Math.max(0, there.get(`${line.itemId}|${line.placeId}`) ?? 0);
        const unitCostCents = cost.get(line.itemId) ?? 0;
        // Counted once and far out: counted a second time before anybody reviews it.
        if (!line.recount && stockCountDifference(expected, line.countedQuantity!, unitCostCents).needsRecount) again.push(line.id);
        else settled.push({ id: line.id, expected, cost: unitCostCents });
      }
      if (settled.length) await this.writeExpected(tx, organizationId, settled);
      if (again.length) {
        // The first count is kept beside the line, and the line waits again.
        await tx.$executeRaw`UPDATE "StockCountLine" SET "firstCountedQuantity" = "countedQuantity", "countedQuantity" = NULL, "recount" = true WHERE "organizationId" = ${organizationId}::uuid AND "id" = ANY(${again}::uuid[])`;
        recounts = again.length;
      } else {
        await tx.stockCount.updateMany({ where: { id: countId, organizationId, status: StockCountStatus.COUNTING }, data: { status: StockCountStatus.REVIEW, submittedAt: new Date() } });
      }
      await tx.auditLog.create({ data: { organizationId, ...auditActor(user), action: 'STOCK_COUNT_HANDED_IN', entityType: ENTITY, entityId: countId, metadata: { number: count.number, lines: waiting.length, recounts } } });
    }, LONG);
    return { ...(await this.get(user, countId)), recounts };
  }

  /** What was expected and what one cost, written for many lines in one statement. */
  private async writeExpected(tx: Db, organizationId: string, rows: { id: string; expected: number; cost: number }[]): Promise<void> {
    await tx.$executeRaw`
      UPDATE "StockCountLine" AS line SET "expectedQuantity" = given.expected, "unitCostCents" = given.cost
      FROM unnest(${rows.map((row) => row.id)}::uuid[], ${rows.map((row) => row.expected)}::int[], ${rows.map((row) => row.cost)}::int[]) AS given(id, expected, cost)
      WHERE line."id" = given.id AND line."organizationId" = ${organizationId}::uuid`;
  }

  /** A reviewer asks for one line to be counted a second time: the count goes back to whoever counted. */
  async recount(user: AuthenticatedUser, countId: string, lineId: string): Promise<StockCountDetail> {
    const organizationId = user.organizationId;
    await this.prisma.$transaction(async (tx) => {
      const count = await this.reviewable(tx, user, countId);
      const line = await tx.stockCountLine.findFirst({ where: { id: lineId, organizationId, countId }, select: { countedQuantity: true, firstCountedQuantity: true, item: { select: { code: true } } } });
      if (!line) throw new ApplicationError(404, 'STOCK_COUNT_LINE_NOT_FOUND', 'That line is not on this count.');
      const back = await tx.stockCount.updateMany({ where: { id: countId, organizationId, status: StockCountStatus.REVIEW }, data: { status: StockCountStatus.COUNTING } });
      if (back.count !== 1) throw new ApplicationError(409, 'STOCK_COUNT_NOT_IN_REVIEW', 'That count has just changed. Open it again.');
      await tx.stockCountLine.updateMany({
        where: { id: lineId, organizationId, countId },
        data: { firstCountedQuantity: line.firstCountedQuantity ?? line.countedQuantity, countedQuantity: null, expectedQuantity: null, unitCostCents: null, reason: null, recount: true },
      });
      await tx.auditLog.create({ data: { organizationId, ...auditActor(user), action: 'STOCK_COUNT_RECOUNT_ASKED', entityType: ENTITY, entityId: countId, metadata: { number: count.number, item: line.item.code } } });
    });
    return this.get(user, countId);
  }

  /** Approves the count and posts it: one adjustment a line that differed, each with its reason. */
  async post(user: AuthenticatedUser, countId: string, input: PostStockCountInput): Promise<StockCountDetail> {
    const organizationId = user.organizationId;
    const reasonOf = new Map(input.reasons.map((given) => [given.lineId, given.reason]));
    try {
      await this.prisma.$transaction(async (tx) => {
        const count = await this.reviewable(tx, user, countId);
        const lines = await tx.stockCountLine.findMany({
          where: { organizationId, countId },
          select: { id: true, itemId: true, placeId: true, countedQuantity: true, expectedQuantity: true, unitCostCents: true, item: { select: { code: true } } },
        });
        if (lines.some((line) => line.countedQuantity === null || line.expectedQuantity === null || line.unitCostCents === null)) throw new ApplicationError(409, 'STOCK_COUNT_NOT_FINISHED', 'A line is still waiting to be counted.');
        const differing = lines.filter((line) => line.countedQuantity !== line.expectedQuantity);
        for (const line of differing) {
          const reason = reasonOf.get(line.id);
          if (!reason || !stockCountReasonsFor(line.countedQuantity! - line.expectedQuantity!).includes(reason)) throw new ApplicationError(409, 'STOCK_COUNT_NEEDS_REASONS', `Say why ${line.item.code} differs.`);
        }

        const day = dateOf(businessDate());
        const who = { createdById: user.id, createdByName: user.displayName };
        let netValueCents = 0;
        for (const line of differing) {
          const reason = reasonOf.get(line.id)!;
          const quantity = line.countedQuantity! - line.expectedQuantity!;
          const movement = await tx.stockMovement.create({
            data: { organizationId, itemId: line.itemId, placeId: line.placeId, kind: StockMovementKind.COUNT_ADJUSTMENT, quantity, unitCostCents: line.unitCostCents!, day, note: `${count.number}: ${STOCK_COUNT_REASON_LABEL[reason].toLowerCase()}`, ...who },
            select: { id: true },
          });
          await tx.stockCountLine.updateMany({ where: { id: line.id, organizationId, countId }, data: { reason, movementId: movement.id } });
          netValueCents += quantity * line.unitCostCents!;
        }
        const posted = await tx.stockCount.updateMany({
          where: { id: countId, organizationId, status: StockCountStatus.REVIEW },
          data: { status: StockCountStatus.POSTED, approvedById: user.id, approvedByName: user.displayName, postedAt: new Date(), netValueCents },
        });
        if (posted.count !== 1) throw new ApplicationError(409, 'STOCK_COUNT_NOT_IN_REVIEW', 'That count has just changed. Open it again.');
        await tx.auditLog.create({
          data: { organizationId, ...auditActor(user), action: 'STOCK_COUNT_POSTED', entityType: ENTITY, entityId: countId, metadata: { number: count.number, lines: lines.length, adjusted: differing.length, netValueCents } },
        });
      }, LONG);
    } catch (error) {
      // Stock left the place after the count was handed in, and the shelf cannot go below nothing.
      if (outOfStock(error)) throw new ApplicationError(409, 'STOCK_COUNT_STOCK_MOVED', 'Stock has moved since this was counted, and one adjustment would take a place below nothing. Ask for a second count of that item.');
      throw error;
    }
    return this.get(user, countId);
  }

  /** Stops an unfinished count, with why. Nothing it counted is posted. */
  async cancel(user: AuthenticatedUser, countId: string, input: CancelStockCountInput): Promise<StockCountDetail> {
    const organizationId = user.organizationId;
    const reason = text(input.reason);
    if (!reason) throw new ApplicationError(400, 'STOCK_COUNT_CANCEL_NEEDS_REASON', 'Say why it is being cancelled.');
    await this.prisma.$transaction(async (tx) => {
      const count = await this.read(tx, organizationId, countId);
      if (!OPEN_COUNT.includes(count.status)) throw new ApplicationError(409, 'STOCK_COUNT_FINISHED', 'That count is already finished.');
      if (!detail(count, user).can.cancel) throw new ApplicationError(403, 'STOCK_COUNT_NOT_YOURS', 'Somebody who approves counts cancels one that is under way.');
      const stopped = await tx.stockCount.updateMany({ where: { id: countId, organizationId, status: count.status }, data: { status: StockCountStatus.CANCELLED, cancelledAt: new Date(), cancelledByName: user.displayName, cancelReason: reason } });
      if (stopped.count !== 1) throw new ApplicationError(409, 'STOCK_COUNT_FINISHED', 'That count has just changed. Open it again.');
      await tx.auditLog.create({ data: { organizationId, ...auditActor(user), action: 'STOCK_COUNT_CANCELLED', entityType: ENTITY, entityId: countId, metadata: { number: count.number, reason } } });
    });
    return this.get(user, countId);
  }

  /** The count, when it is up for review and this person is not the one who counted it. */
  private async reviewable(tx: Db, user: AuthenticatedUser, countId: string): Promise<{ number: string }> {
    const me = personId(user);
    if (!me) throw new ApplicationError(403, 'STOCK_COUNT_NEEDS_A_PERSON', 'A count is approved by a person at the screen.');
    const count = await tx.stockCount.findFirst({ where: { id: countId, organizationId: user.organizationId }, select: { number: true, status: true, countedById: true } });
    if (!count) throw new ApplicationError(404, 'STOCK_COUNT_NOT_FOUND', 'That count is not on the list.');
    if (count.countedById === me) throw new ApplicationError(403, 'STOCK_COUNT_OWN', 'The person who counted cannot approve the count.');
    if (count.status !== StockCountStatus.REVIEW) throw new ApplicationError(409, 'STOCK_COUNT_NOT_IN_REVIEW', 'That count is not up for review.');
    return count;
  }
}
