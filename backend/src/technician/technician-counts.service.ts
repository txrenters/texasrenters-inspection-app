import { Inject, Injectable } from '@nestjs/common';
import { StockCountStatus, StockPlaceKind } from '@prisma/client';
import { stockCountTitle, type PhoneCount, type PhoneCounts, type SavePhoneCountInput, type SavePhoneCountResult } from '@texasrenters/shared';

import { StockCountsService } from '../admin/stock-counts.service';
import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

/**
 * Counting a truck from the phone (2026-11-19). The office starts the count
 * on the console; the technician counts it by scanning.
 *
 * What the phone may and may not do, all decided here and not by what it
 * sends:
 * - The count is of one truck, and the truck is this technician's own or one
 *   nobody is named on. Never a storeroom, never the yearly count of every
 *   place: those are counted at the console.
 * - It is open, and nobody else has begun counting it. The first to save a
 *   number is the counter, and stays so (the office's own rule).
 * - It is blind. Nothing read here carries what the console expects, a
 *   difference or a cost.
 * - It never starts, reviews, posts or cancels a count. Whoever counts is
 *   never the approver: that is held by the count itself and by the database.
 *
 * The writing is the office's own (`StockCountsService.save`), so a count
 * from the phone is the same count, with the same recount rule and the same
 * audit entry. The phone keeps what it counted until the server answers and
 * may send it twice: each line says whether it is the first or the second
 * count of that line, and a send that no longer matches the line is
 * recognised as one already received, and writes nothing. Nothing here calls
 * anything billed.
 */

const COUNTING: StockCountStatus[] = [StockCountStatus.OPEN, StockCountStatus.COUNTING];
/** A technician has a truck or two; this bounds the read. */
const MOST_COUNTS = 10;
const dayOf = (date: Date) => date.toISOString().slice(0, 10);

@Injectable()
export class TechnicianCountsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StockCountsService) private readonly counts: StockCountsService,
  ) {}

  /** The counts this technician may count now, with the lines still to count. Two reads. */
  async mine(user: AuthenticatedUser): Promise<PhoneCounts> {
    const { organizationId } = user;
    const trucks = await this.trucks(user);
    if (!trucks.length) return { counts: [] };
    const counts = await this.prisma.stockCount.findMany({
      where: { organizationId, status: { in: COUNTING }, placeId: { in: trucks.map((truck) => truck.id) }, OR: [{ countedById: null }, { countedById: user.id }] },
      select: {
        id: true,
        number: true,
        kind: true,
        day: true,
        place: { select: { id: true, name: true } },
        // Only what is still waiting: a line handed in is not counted over, and what was expected of it is never read.
        lines: {
          where: { expectedQuantity: null },
          select: { id: true, itemId: true, countedQuantity: true, recount: true, item: { select: { code: true, name: true, unit: true } } },
          orderBy: { item: { codeKey: 'asc' } },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MOST_COUNTS,
    });
    return {
      counts: counts.flatMap((count): PhoneCount[] =>
        count.place
          ? [
              {
                id: count.id,
                number: count.number,
                title: stockCountTitle(count.kind, dayOf(count.day)),
                place: count.place,
                lines: count.lines.map((line) => ({ lineId: line.id, itemId: line.itemId, code: line.item.code, name: line.item.name, unit: line.item.unit, counted: line.countedQuantity, second: line.recount })),
              },
            ]
          : [],
      ),
    };
  }

  /** Keeps what was counted, or hands the count in. Sent twice it records once. */
  async save(user: AuthenticatedUser, countId: string, input: SavePhoneCountInput): Promise<SavePhoneCountResult> {
    const { organizationId } = user;
    const ids = input.lines.map((line) => line.lineId);
    if (new Set(ids).size !== ids.length) throw new ApplicationError(400, 'STOCK_COUNT_LINE_TWICE', 'A line is in the count twice.');

    const count = await this.prisma.stockCount.findFirst({ where: { id: countId, organizationId }, select: { status: true, placeId: true, countedById: true } });
    const trucks = await this.trucks(user);
    // A count that is not of one of their trucks is not there at all, as far as the phone is told.
    if (!count || !count.placeId || !trucks.some((truck) => truck.id === count.placeId)) throw new ApplicationError(404, 'STOCK_COUNT_NOT_FOUND', 'That count is not one you can count.');
    if (count.countedById && count.countedById !== user.id) throw new ApplicationError(403, 'STOCK_COUNT_SOMEBODY_ELSE', 'Somebody else is counting this one.');

    const already = async (): Promise<SavePhoneCountResult> => ({ ...(await this.mine(user)), outcome: 'already', recounts: 0 });
    if (!COUNTING.includes(count.status)) {
      // Handed in by this technician already: the phone is sending again what the server has. Cancelled or never theirs is a refusal.
      if (count.countedById === user.id && count.status !== StockCountStatus.CANCELLED) return already();
      throw new ApplicationError(409, 'STOCK_COUNT_NOT_COUNTING', count.status === StockCountStatus.CANCELLED ? 'The office cancelled that count.' : 'That count has been handed in already.');
    }

    const waiting = await this.prisma.stockCountLine.findMany({ where: { organizationId, countId, expectedQuantity: null }, select: { id: true, recount: true } });
    const secondOf = new Map(waiting.map((line) => [line.id, line.recount]));
    // A line that is no longer waiting, or is on another count of itself than the phone saw: this was received before.
    if (input.lines.some((line) => secondOf.get(line.lineId) !== line.second)) return already();

    const saved = await this.counts.save(user, countId, { lines: input.lines.map((line) => ({ lineId: line.lineId, counted: line.counted })) }, input.handIn);
    return { ...(await this.mine(user)), outcome: !input.handIn ? 'saved' : saved.recounts ? 'recount' : 'handed-in', recounts: saved.recounts };
  }

  /** The trucks this technician may count: in use, a truck, and theirs or nobody's. */
  private trucks(user: AuthenticatedUser) {
    return this.prisma.stockPlace.findMany({
      where: { organizationId: user.organizationId, active: true, kind: StockPlaceKind.VAN, OR: [{ technicianId: user.id }, { technicianId: null }] },
      select: { id: true },
    });
  }
}
