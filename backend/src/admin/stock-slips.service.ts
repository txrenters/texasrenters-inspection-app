import { Inject, Injectable } from '@nestjs/common';
import { InspectionStatus, Prisma, StockMovementKind, StockSlipKind, UserRole } from '@prisma/client';
import {
  STOCK_SLIPS_SHOWN,
  stockSlipProblem,
  stockSlipSeries,
  type PostStockSlipInput,
  type ReverseStockSlipInput,
  type StockSlipChoices,
  type StockSlipList,
  type StockSlipRow,
} from '@texasrenters/shared';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { nextDocumentCode } from './purchasing-settings';
import { assertStockNotFrozen } from './stock-freeze';

/**
 * Withdrawals, returns and moves (2026-11-19, phase 5 of the inventory and
 * purchasing plan). The office records what a technician took for a visit or
 * a van, what came back, and stock moved between places.
 *
 * A slip is posted whole or not at all, once a press (its request key), and
 * writes the stock movements itself: out of the place it leaves, into the
 * place it goes. Stock moves at what the item cost on average at that moment,
 * so a withdrawal has a cost and a move changes no value. A slip is never
 * edited: a wrong one is reversed, with a reason.
 *
 * Nobody takes out more than is there. That is said here in the office's
 * words, and held by the ledger's own check when two slips race for the same
 * stock. A visit a withdrawal names is one of the technician's own.
 *
 * Every slip and reversal is audited. Nothing here calls anything billed:
 * the tab reads when it opens and after its own saves.
 */

const ENTITY = 'StockSlip';
/** A technician's visits for one day never come near this; it bounds the read. */
const MOST_VISITS = 60;

const text = (value: string | null | undefined) => value?.trim().replace(/\s+/g, ' ') || null;
const dateOf = (day: string) => new Date(`${day}T00:00:00.000Z`);
const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const taken = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
/** The ledger's own refusal of a level below nothing: two slips reached for the same stock at once. */
const outOfStock = (error: unknown) => String((error as { message?: unknown } | null)?.message ?? error).includes('StockLevel_never_below_nothing');
/** "MOVE_OUT" as "Move out": a visit's kind, when Jobber gave it no title. */
const humanize = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');

const VISIT = { id: true, jobberVisitTitle: true, inspectionType: true, propertywareBuilding: { select: { addressLine1: true } }, property: { select: { addressLine1: true } } } satisfies Prisma.InspectionSelect;
type Visit = Prisma.InspectionGetPayload<{ select: typeof VISIT }>;
const visitRow = (visit: Visit) => ({
  id: visit.id,
  title: visit.jobberVisitTitle?.trim() || humanize(visit.inspectionType),
  address: visit.propertywareBuilding?.addressLine1 ?? visit.property?.addressLine1 ?? null,
});

const SLIP = {
  id: true,
  number: true,
  kind: true,
  day: true,
  note: true,
  createdByName: true,
  createdAt: true,
  reversedAt: true,
  reversedByName: true,
  reverseReason: true,
  technician: { select: { id: true, displayName: true } },
  fromPlace: { select: { id: true, name: true } },
  toPlace: { select: { id: true, name: true } },
  inspection: { select: VISIT },
  lines: { select: { quantity: true, unitCostCents: true, item: { select: { code: true, name: true } } }, orderBy: { item: { codeKey: 'asc' } } },
} satisfies Prisma.StockSlipSelect;
type Slip = Prisma.StockSlipGetPayload<{ select: typeof SLIP }>;

function row(slip: Slip): StockSlipRow {
  return {
    id: slip.id,
    number: slip.number,
    kind: slip.kind,
    day: dayOf(slip.day),
    technician: slip.technician ? { id: slip.technician.id, name: slip.technician.displayName } : null,
    from: slip.fromPlace,
    to: slip.toPlace,
    visit: slip.inspection ? visitRow(slip.inspection) : null,
    note: slip.note,
    lines: slip.lines.map((line) => ({ itemCode: line.item.code, itemName: line.item.name, quantity: line.quantity, unitCostCents: line.unitCostCents })),
    costCents: slip.lines.reduce((sum, line) => sum + line.quantity * line.unitCostCents, 0),
    by: slip.createdByName,
    at: slip.createdAt.toISOString(),
    reversed: slip.reversedAt ? { by: slip.reversedByName ?? 'Somebody', at: slip.reversedAt.toISOString(), reason: slip.reverseReason ?? '' } : null,
  };
}

@Injectable()
export class StockSlipsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** The latest slips, newest first; one technician's when asked. */
  async list(user: AuthenticatedUser, technicianId?: string): Promise<StockSlipList> {
    const slips = await this.prisma.stockSlip.findMany({
      where: { organizationId: user.organizationId, ...(technicianId ? { technicianId } : {}) },
      select: SLIP,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: STOCK_SLIPS_SHOWN,
    });
    return { slips: slips.map(row) };
  }

  /** What the form chooses from, what is where, and the chosen technician's visits for the day: five reads at most. */
  async choices(user: AuthenticatedUser, technicianId?: string, day: string = businessDate()): Promise<StockSlipChoices> {
    const organizationId = user.organizationId;
    const [members, places, items, levels, visits] = await Promise.all([
      this.prisma.organizationMember.findMany({
        where: { organizationId, role: UserRole.INSPECTION_TECHNICIAN, userProfile: { isActive: true } },
        select: { userProfile: { select: { id: true, displayName: true } } },
      }),
      this.prisma.stockPlace.findMany({ where: { organizationId, active: true }, select: { id: true, name: true, kind: true, technicianId: true }, orderBy: [{ kind: 'asc' }, { nameKey: 'asc' }] }),
      this.prisma.stockItem.findMany({ where: { organizationId, active: true }, select: { id: true, code: true, name: true, unit: true }, orderBy: { codeKey: 'asc' } }),
      this.prisma.stockLevel.findMany({ where: { organizationId, quantity: { gt: 0 } }, select: { itemId: true, placeId: true, quantity: true } }),
      technicianId
        ? this.prisma.inspection.findMany({
            where: { organizationId, status: { not: InspectionStatus.CANCELLED }, scheduledAt: dateOf(day), assignments: { some: { isCurrent: true, technicianId } } },
            select: VISIT,
            orderBy: { createdAt: 'asc' },
            take: MOST_VISITS,
          })
        : [],
    ]);
    const technicians = new Map(members.map(({ userProfile }) => [userProfile.id, userProfile.displayName]));
    return {
      technicians: [...technicians].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name)),
      places,
      items,
      levels,
      visits: visits.map(visitRow),
      day,
    };
  }

  /** Posts a withdrawal, a return or a move: all of its lines or none. Sent twice with the same key it posts once. */
  async post(user: AuthenticatedUser, input: PostStockSlipInput): Promise<StockSlipList> {
    await this.write(user, input);
    return this.list(user);
  }

  /**
   * The posting itself, answering nothing: the office's page then reads its
   * list, and the phone (2026-11-19, phase 7) reads the technician's own job.
   */
  async write(user: AuthenticatedUser, input: PostStockSlipInput): Promise<void> {
    const organizationId = user.organizationId;
    const kind = input.kind;
    const move = kind === StockSlipKind.TRANSFER;
    // A move has nobody and no visit; a withdrawal has no place it goes to, a return none it leaves.
    const technicianId = move ? null : input.technicianId;
    const fromPlaceId = kind === StockSlipKind.RETURN ? null : input.fromPlaceId;
    const toPlaceId = kind === StockSlipKind.WITHDRAWAL ? null : input.toPlaceId;
    const inspectionId = move ? null : input.inspectionId;
    const itemIds = input.lines.map((line) => line.itemId);
    if (new Set(itemIds).size !== itemIds.length) throw new ApplicationError(400, 'STOCK_SLIP_ITEM_TWICE', 'An item is on the slip twice. Put it on one line.');

    try {
      await this.prisma.$transaction(async (tx) => {
        if (await tx.stockSlip.findFirst({ where: { organizationId, requestKey: input.requestKey }, select: { id: true } })) return;
        await assertStockNotFrozen(tx, organizationId);

        const placeIds = [fromPlaceId, toPlaceId].filter((placeId): placeId is string => Boolean(placeId));
        const [items, places, levels] = await Promise.all([
          tx.stockItem.findMany({ where: { organizationId, id: { in: itemIds } }, select: { id: true, code: true, active: true } }),
          tx.stockPlace.findMany({ where: { organizationId, id: { in: placeIds }, active: true }, select: { id: true, name: true } }),
          tx.stockLevel.findMany({ where: { organizationId, itemId: { in: itemIds } }, select: { itemId: true, placeId: true, quantity: true, valueCents: true } }),
        ]);
        const itemOf = new Map(items.map((item) => [item.id, item]));
        if (itemIds.some((itemId) => !itemOf.get(itemId)?.active)) throw new ApplicationError(400, 'STOCK_ITEM_NOT_FOUND', 'One of the items is not in the inventory, or is switched off.');
        if (places.length !== new Set(placeIds).size) throw new ApplicationError(400, 'STOCK_PLACE_NOT_FOUND', 'One of the places is not in use.');

        const there = new Map(levels.filter((level) => level.placeId === fromPlaceId).map((level) => [level.itemId, level.quantity]));
        const problem = stockSlipProblem({ kind, technicianId, fromPlaceId, toPlaceId, lines: input.lines }, there, (itemId) => itemOf.get(itemId)?.code ?? 'that item');
        if (problem) throw new ApplicationError(409, 'STOCK_SLIP_NOT_READY', problem);

        let technicianName: string | null = null;
        if (technicianId) {
          const member = await tx.organizationMember.findFirst({ where: { organizationId, userProfileId: technicianId, role: UserRole.INSPECTION_TECHNICIAN }, select: { userProfile: { select: { displayName: true } } } });
          if (!member) throw new ApplicationError(400, 'STOCK_TECHNICIAN_NOT_FOUND', "That person is not one of this office's technicians.");
          technicianName = member.userProfile.displayName;
        }
        // A visit of this office, and this technician's own: materials are not put on somebody else's job.
        if (inspectionId && !(await tx.inspection.findFirst({ where: { id: inspectionId, organizationId, assignments: { some: { isCurrent: true, technicianId: technicianId! } } }, select: { id: true } })))
          throw new ApplicationError(400, 'STOCK_VISIT_NOT_FOUND', "That visit is not one of this technician's.");

        // What one costs on average now, across every place: what leaves at, and what a move carries.
        const cost = new Map<string, number>();
        for (const itemId of itemIds) {
          const held = levels.filter((level) => level.itemId === itemId);
          const quantity = held.reduce((sum, level) => sum + level.quantity, 0);
          if (quantity > 0) cost.set(itemId, Math.max(0, Math.round(held.reduce((sum, level) => sum + level.valueCents, 0) / quantity)));
          else {
            // A return with none on hand comes back at what the last of it left at.
            const last = await tx.stockMovement.findFirst({ where: { organizationId, itemId, kind: StockMovementKind.WITHDRAWAL }, orderBy: { createdAt: 'desc' }, select: { unitCostCents: true } });
            cost.set(itemId, last?.unitCostCents ?? 0);
          }
        }

        const day = dateOf(businessDate());
        const number = await nextDocumentCode(tx, organizationId, stockSlipSeries(kind));
        const who = { createdById: user.principalType === 'API_KEY' ? null : user.id, createdByName: user.displayName };
        const slip = await tx.stockSlip.create({
          data: { organizationId, number, kind, day, technicianId, fromPlaceId, toPlaceId, inspectionId, note: text(input.note), requestKey: input.requestKey, ...who },
          select: { id: true },
        });
        const note = technicianName ? `${number}, ${technicianName}` : number;
        const movement = (itemId: string, placeId: string, movementKind: StockMovementKind, quantity: number) =>
          tx.stockMovement.create({ data: { organizationId, itemId, placeId, kind: movementKind, quantity, unitCostCents: cost.get(itemId)!, day, note, ...who }, select: { id: true } });
        let costCents = 0;
        for (const line of input.lines) {
          const out = fromPlaceId ? await movement(line.itemId, fromPlaceId, move ? StockMovementKind.TRANSFER : StockMovementKind.WITHDRAWAL, -line.quantity) : null;
          const back = toPlaceId ? await movement(line.itemId, toPlaceId, move ? StockMovementKind.TRANSFER : StockMovementKind.RETURN, line.quantity) : null;
          await tx.stockSlipLine.create({
            data: { organizationId, slipId: slip.id, itemId: line.itemId, quantity: line.quantity, unitCostCents: cost.get(line.itemId)!, movementId: (out ?? back)!.id, movementInId: out && back ? back.id : null },
          });
          costCents += line.quantity * cost.get(line.itemId)!;
        }
        await tx.auditLog.create({
          data: { organizationId, ...auditActor(user), action: 'STOCK_SLIP_POSTED', entityType: ENTITY, entityId: slip.id, metadata: { number, kind, technician: technicianName, lines: input.lines.length, costCents } },
        });
      });
    } catch (error) {
      if (outOfStock(error)) throw new ApplicationError(409, 'STOCK_NOT_ENOUGH', 'Somebody has just taken some of that stock. Open the tab again to see what is there.');
      // The same slip, sent at the same moment by a retry: the other one posted it.
      if (!taken(error)) throw error;
    }
  }

  /**
   * Puts a wrong slip right: each of its movements is reversed, at the same
   * cost. What it brought in can be taken back out only while it is still
   * there. The slip stays, marked reversed.
   */
  async reverse(user: AuthenticatedUser, slipId: string, input: ReverseStockSlipInput): Promise<StockSlipList> {
    const organizationId = user.organizationId;
    const reason = text(input.reason);
    if (!reason) throw new ApplicationError(400, 'STOCK_SLIP_REVERSAL_NEEDS_REASON', 'Say why it is being reversed.');
    try {
      await this.prisma.$transaction(async (tx) => {
        const slip = await tx.stockSlip.findFirst({
          where: { id: slipId, organizationId },
          select: {
            number: true,
            reversedAt: true,
            lines: {
              select: {
                item: { select: { code: true } },
                movement: { select: { id: true, itemId: true, placeId: true, quantity: true, unitCostCents: true, place: { select: { name: true } } } },
                movementIn: { select: { id: true, itemId: true, placeId: true, quantity: true, unitCostCents: true, place: { select: { name: true } } } },
              },
            },
          },
        });
        if (!slip) throw new ApplicationError(404, 'STOCK_SLIP_NOT_FOUND', 'That slip is not on the list.');
        if (slip.reversedAt) throw new ApplicationError(409, 'STOCK_SLIP_ALREADY_REVERSED', 'That slip has already been reversed.');
        await assertStockNotFrozen(tx, organizationId);

        const who = { createdById: user.principalType === 'API_KEY' ? null : user.id, createdByName: user.displayName };
        const day = dateOf(businessDate());
        for (const line of slip.lines) {
          // What came in first, so a move's stock is checked where it now is.
          for (const original of [line.movementIn, line.movement]) {
            if (!original) continue;
            if (original.quantity > 0) {
              const level = await tx.stockLevel.findUnique({ where: { itemId_placeId: { itemId: original.itemId, placeId: original.placeId } }, select: { quantity: true } });
              const there = level?.quantity ?? 0;
              if (there < original.quantity)
                throw new ApplicationError(409, 'STOCK_NOT_ENOUGH', `Only ${there} of ${line.item.code} ${there === 1 ? 'is' : 'are'} still in ${original.place.name}, so ${original.quantity} cannot be taken back out.`);
            }
            await tx.stockMovement.create({
              data: { organizationId, itemId: original.itemId, placeId: original.placeId, kind: StockMovementKind.REVERSAL, quantity: -original.quantity, unitCostCents: original.unitCostCents, day, note: `${slip.number} reversed: ${reason}`, reversesId: original.id, ...who },
            });
          }
        }
        const marked = await tx.stockSlip.updateMany({ where: { id: slipId, organizationId, reversedAt: null }, data: { reversedAt: new Date(), reversedById: who.createdById, reversedByName: user.displayName, reverseReason: reason } });
        if (marked.count !== 1) throw new ApplicationError(409, 'STOCK_SLIP_ALREADY_REVERSED', 'That slip has already been reversed.');
        await tx.auditLog.create({ data: { organizationId, ...auditActor(user), action: 'STOCK_SLIP_REVERSED', entityType: ENTITY, entityId: slipId, metadata: { number: slip.number, reason } } });
      });
    } catch (error) {
      // Two reversals at once: the ledger lets a movement be reversed once.
      if (taken(error)) throw new ApplicationError(409, 'STOCK_SLIP_ALREADY_REVERSED', 'That slip has already been reversed.');
      if (outOfStock(error)) throw new ApplicationError(409, 'STOCK_NOT_ENOUGH', 'That stock has just been taken, so the slip cannot be reversed.');
      throw error;
    }
    return this.list(user);
  }
}
