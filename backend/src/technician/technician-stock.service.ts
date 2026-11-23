import { Inject, Injectable } from '@nestjs/common';
import { InspectionStatus, Prisma, StockCountStatus, StockPlaceKind, StockSlipKind, TruckStockAskStatus } from '@prisma/client';
import {
  MOST_OPEN_ASKS,
  MY_TRUCK_SLIPS,
  jobStockProblem,
  jobStockTaken,
  truckAskProblem,
  type AskForTruckStockInput,
  type JobStock,
  type JobStockSlip,
  type MyTruckItem,
  type MyTrucks,
  type PhoneSlipKind,
  type RecordJobStockInput,
} from '@texasrenters/shared';

import { StockSlipsService } from '../admin/stock-slips.service';
import { ASK_SELECT, askRow } from '../admin/truck-stock.service';
import { auditActor, type AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { phoneCatalog } from './phone-catalog';

/**
 * A job's materials on the phone (2026-11-19, phase 7 of the inventory and
 * purchasing plan). The office moves stock from the storeroom to a truck on
 * the console; a technician records, for one of their own jobs, what they
 * took from the truck and what they are putting back in it.
 *
 * What the phone may and may not do, all decided here and not by what it
 * sends:
 * - The technician is whoever is signed in, and the job is one assigned to
 *   them now and not cancelled.
 * - The place is a truck: their own, or one nobody is named on. Never a
 *   storeroom: moving stock out of the storeroom stays with the office.
 * - No more comes out than is in the truck (the ledger's own check holds it
 *   when two phones reach for the same stock), and no more goes back than
 *   they took for that job.
 * - It never reverses a slip, moves stock between places, or sees what
 *   anything cost: those stay on the console.
 *
 * The posting is the office's own (`StockSlipsService.write`), so a slip from
 * the phone is the same slip, in the same ledger, with the same audit entry.
 *
 * My truck (the office, 2026-11-24): the technician also sees what is on
 * their trucks, what the office keeps on them and what has run low, their
 * latest slips across jobs, and asks the office for more. An ask moves no
 * stock: the office fills it with a move from the Storeroom on the console.
 * The phone keeps a slip until the server answers and may send it twice: its
 * key makes the second one record nothing. Nothing here calls anything
 * billed.
 */

/** A job's slips never come near this; it bounds the read. */
const MOST_SLIPS = 60;
/** The filled asks My truck still lists: a month's. */
const FILLED_ASKS_DAYS = 30;
const dayOf = (date: Date) => date.toISOString().slice(0, 10);
/** A unique key taken by a second send at the same moment. */
const taken = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

@Injectable()
export class TechnicianStockService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StockSlipsService) private readonly slips: StockSlipsService,
  ) {}

  /** The job's materials: the trucks, what is in them, and what this technician recorded for it. Four reads. */
  async forJob(user: AuthenticatedUser, inspectionId: string): Promise<JobStock> {
    await this.assigned(user, inspectionId);
    return this.read(user, inspectionId);
  }

  private async read(user: AuthenticatedUser, inspectionId: string): Promise<JobStock> {
    const { organizationId } = user;
    const places = await this.trucks(user);
    const [levels, slips, catalog] = await Promise.all([
      places.length
        ? this.prisma.stockLevel.findMany({
            where: { organizationId, placeId: { in: places.map((place) => place.id) }, quantity: { gt: 0 }, item: { active: true } },
            select: { placeId: true, quantity: true, item: { select: { id: true, code: true, name: true, unit: true } } },
            orderBy: { item: { codeKey: 'asc' } },
          })
        : [],
      this.prisma.stockSlip.findMany({
        where: { organizationId, inspectionId, technicianId: user.id, kind: { in: [StockSlipKind.WITHDRAWAL, StockSlipKind.RETURN] } },
        select: {
          id: true,
          number: true,
          kind: true,
          createdAt: true,
          reversedAt: true,
          fromPlace: { select: { name: true } },
          toPlace: { select: { name: true } },
          lines: { select: { quantity: true, item: { select: { id: true, code: true, name: true, unit: true } } }, orderBy: { item: { codeKey: 'asc' } } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MOST_SLIPS,
      }),
      phoneCatalog(this.prisma, organizationId),
    ]);
    const rows: JobStockSlip[] = slips.map((slip) => ({
      id: slip.id,
      number: slip.number,
      kind: slip.kind as PhoneSlipKind,
      at: slip.createdAt.toISOString(),
      place: (slip.fromPlace ?? slip.toPlace)?.name ?? 'A truck',
      reversed: slip.reversedAt !== null,
      lines: slip.lines.map((line) => ({ itemId: line.item.id, code: line.item.code, name: line.item.name, unit: line.item.unit, quantity: line.quantity })),
    }));
    return {
      places,
      stock: levels.map((level) => ({ placeId: level.placeId, itemId: level.item.id, code: level.item.code, name: level.item.name, unit: level.item.unit, quantity: level.quantity })),
      slips: rows,
      taken: jobStockTaken(rows),
      catalog,
    };
  }

  /** My truck: the trucks this technician may use, what is on them and kept on them, their asks, their latest slips, and every item in use. Seven reads. */
  async myTrucks(user: AuthenticatedUser): Promise<MyTrucks> {
    const { organizationId } = user;
    const places = await this.prisma.stockPlace.findMany({
      where: { organizationId, active: true, kind: StockPlaceKind.VAN, OR: [{ technicianId: user.id }, { technicianId: null }] },
      select: { id: true, name: true, technicianId: true },
      orderBy: [{ technicianId: { sort: 'asc', nulls: 'last' } }, { nameKey: 'asc' }],
    });
    const placeIds = places.map((place) => place.id);
    const item = { select: { id: true, code: true, name: true, unit: true } } as const;
    const since = new Date(Date.now() - FILLED_ASKS_DAYS * 86_400_000);
    const [levels, keeps, counted, asks, slips, catalog] = await Promise.all([
      placeIds.length
        ? this.prisma.stockLevel.findMany({ where: { organizationId, placeId: { in: placeIds }, quantity: { gt: 0 }, item: { active: true } }, select: { placeId: true, quantity: true, item } })
        : [],
      placeIds.length ? this.prisma.stockKeepLevel.findMany({ where: { organizationId, placeId: { in: placeIds }, item: { active: true } }, select: { placeId: true, keepAtLeast: true, item } }) : [],
      placeIds.length
        ? this.prisma.stockCount.groupBy({ by: ['placeId'], where: { organizationId, placeId: { in: placeIds }, status: StockCountStatus.POSTED }, _max: { day: true } })
        : [],
      placeIds.length
        ? this.prisma.truckStockAsk.findMany({
            where: { organizationId, askedById: user.id, placeId: { in: placeIds }, OR: [{ status: TruckStockAskStatus.ASKED }, { status: TruckStockAskStatus.FILLED, filledAt: { gte: since } }] },
            select: ASK_SELECT,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 20,
          })
        : [],
      this.prisma.stockSlip.findMany({
        where: { organizationId, technicianId: user.id, kind: { in: [StockSlipKind.WITHDRAWAL, StockSlipKind.RETURN] } },
        select: {
          id: true,
          number: true,
          kind: true,
          createdAt: true,
          reversedAt: true,
          fromPlace: { select: { name: true } },
          toPlace: { select: { name: true } },
          inspection: { select: { id: true, propertywareBuilding: { select: { addressLine1: true } }, property: { select: { addressLine1: true } } } },
          lines: { select: { quantity: true, item: { select: { code: true, name: true } } }, orderBy: { item: { codeKey: 'asc' } } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MY_TRUCK_SLIPS,
      }),
      phoneCatalog(this.prisma, organizationId),
    ]);
    const countedOn = new Map(counted.map((row) => [row.placeId, row._max.day]));
    return {
      trucks: places.map((place) => {
        const items = new Map<string, MyTruckItem>();
        for (const level of levels.filter((one) => one.placeId === place.id))
          items.set(level.item.id, { itemId: level.item.id, code: level.item.code, name: level.item.name, unit: level.item.unit, onHand: level.quantity, keepAtLeast: null });
        for (const keep of keeps.filter((one) => one.placeId === place.id)) {
          const held = items.get(keep.item.id);
          if (held) held.keepAtLeast = keep.keepAtLeast;
          // Kept on the truck and run out: listed with none, so it is asked for.
          else items.set(keep.item.id, { itemId: keep.item.id, code: keep.item.code, name: keep.item.name, unit: keep.item.unit, onHand: 0, keepAtLeast: keep.keepAtLeast });
        }
        const last = countedOn.get(place.id);
        const theirs = asks.filter((ask) => ask.place.id === place.id).map(askRow);
        return {
          id: place.id,
          name: place.name,
          mine: place.technicianId === user.id,
          lastCountedOn: last ? dayOf(last) : null,
          items: [...items.values()].sort((left, right) => left.code.localeCompare(right.code)),
          // Waiting ones first, newest first; then the latest filled.
          asks: [...theirs.filter((ask) => ask.status === 'ASKED'), ...theirs.filter((ask) => ask.status === 'FILLED')],
        };
      }),
      slips: slips.map((slip) => ({
        id: slip.id,
        number: slip.number,
        kind: slip.kind as 'WITHDRAWAL' | 'RETURN',
        at: slip.createdAt.toISOString(),
        place: (slip.fromPlace ?? slip.toPlace)?.name ?? 'A truck',
        job: slip.inspection ? { id: slip.inspection.id, address: slip.inspection.propertywareBuilding?.addressLine1 ?? slip.inspection.property?.addressLine1 ?? null } : null,
        lines: slip.lines.map((line) => ({ code: line.item.code, name: line.item.name, quantity: line.quantity })),
        reversed: slip.reversedAt !== null,
      })),
      catalog,
    };
  }

  /** Asks the office for more for one of their trucks. Sent twice with the same key it asks once. It moves no stock. */
  async ask(user: AuthenticatedUser, input: AskForTruckStockInput): Promise<MyTrucks> {
    const { organizationId } = user;
    const requestKey = `phone:${user.id}:${input.clientRequestId}`;
    if (await this.prisma.truckStockAsk.findFirst({ where: { organizationId, requestKey }, select: { id: true } })) return this.myTrucks(user);

    const places = await this.trucks(user);
    const place = places.find((one) => one.id === input.placeId);
    if (!place) throw new ApplicationError(400, 'STOCK_PLACE_NOT_YOURS', 'That is not a truck you can ask for. Ask the office to put you on it.');
    const lines = input.lines.filter((line) => line.quantity > 0);
    const problem = truckAskProblem(lines);
    if (problem) throw new ApplicationError(400, 'TRUCK_ASK_NOT_READY', problem);
    const itemIds = lines.map((line) => line.itemId);
    if (new Set(itemIds).size !== itemIds.length) throw new ApplicationError(400, 'TRUCK_ASK_ITEM_TWICE', 'An item is on the ask twice. Put it on one line.');
    const items = await this.prisma.stockItem.findMany({ where: { organizationId, id: { in: itemIds }, active: true }, select: { id: true, code: true } });
    if (items.length !== itemIds.length) throw new ApplicationError(400, 'STOCK_ITEM_NOT_FOUND', 'One of the items is not in the inventory, or is switched off.');
    const open = await this.prisma.truckStockAsk.count({ where: { organizationId, placeId: place.id, status: TruckStockAskStatus.ASKED } });
    if (open >= MOST_OPEN_ASKS) throw new ApplicationError(409, 'TRUCK_ASKS_WAITING', `${place.name} has ${open} asks waiting already. The office fills those first.`);

    const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;
    try {
      await this.prisma.$transaction(async (tx) => {
        const ask = await tx.truckStockAsk.create({ data: { organizationId, placeId: place.id, askedById: user.id, note, requestKey }, select: { id: true } });
        await tx.truckStockAskLine.createMany({ data: lines.map((line, position) => ({ organizationId, askId: ask.id, position, itemId: line.itemId, quantity: line.quantity })) });
        await tx.auditLog.create({ data: { organizationId, ...auditActor(user), action: 'TRUCK_STOCK_ASKED', entityType: 'TruckStockAsk', entityId: ask.id, metadata: { place: place.name, lines: lines.length } } });
      });
    } catch (error) {
      // The same ask, sent at the same moment by a retry: the other one wrote it.
      if (!taken(error)) throw error;
    }
    return this.myTrucks(user);
  }

  /** Records what was taken, or what is going back. Sent twice with the same key it records once. */
  async record(user: AuthenticatedUser, inspectionId: string, input: RecordJobStockInput): Promise<JobStock> {
    const { organizationId } = user;
    // The technician's own key: another's with the same letters is another slip.
    const requestKey = `phone:${user.id}:${input.clientRequestId}`;
    const prior = await this.prisma.stockSlip.findFirst({ where: { organizationId, requestKey }, select: { inspectionId: true } });
    if (prior) {
      if (prior.inspectionId !== inspectionId) throw new ApplicationError(409, 'CLIENT_REQUEST_ID_REUSED', 'That was already recorded for another job.');
      return this.read(user, inspectionId);
    }

    await this.assigned(user, inspectionId);
    const lines = input.lines.filter((line) => line.quantity > 0);
    const places = await this.trucks(user);
    if (!places.some((place) => place.id === input.placeId)) throw new ApplicationError(400, 'STOCK_PLACE_NOT_YOURS', 'That is not a truck you can take from. Ask the office to put you on it.');

    if (input.kind === 'RETURN') {
      // No more goes back than was taken for this job: a truck is not filled from the phone.
      const taken = (await this.read(user, inspectionId)).taken;
      const problem = jobStockProblem('RETURN', lines, new Map(taken.map((item) => [item.itemId, item.quantity])), (itemId) => taken.find((item) => item.itemId === itemId)?.code ?? 'that item');
      if (problem) throw new ApplicationError(409, 'STOCK_SLIP_NOT_READY', problem);
    } else if (!lines.length) throw new ApplicationError(409, 'STOCK_SLIP_NOT_READY', 'Choose what you took.');

    try {
      await this.slips.write(user, {
        kind: input.kind,
        technicianId: user.id,
        fromPlaceId: input.kind === 'WITHDRAWAL' ? input.placeId : null,
        toPlaceId: input.kind === 'RETURN' ? input.placeId : null,
        inspectionId,
        note: null,
        requestKey,
        lines,
        askId: null,
      });
    } catch (error) {
      // The office's sentence points at its own page: the phone's points at the truck.
      if (error instanceof ApplicationError && error.code === 'STOCK_NOT_ENOUGH') throw new ApplicationError(409, 'STOCK_NOT_ENOUGH', 'Somebody has just taken some of that from the truck. Look again at what is there.');
      throw error;
    }
    return this.read(user, inspectionId);
  }

  /** The trucks this technician may use: in use, a truck, and theirs or nobody's. */
  private trucks(user: AuthenticatedUser) {
    return this.prisma.stockPlace.findMany({
      where: { organizationId: user.organizationId, active: true, kind: StockPlaceKind.VAN, OR: [{ technicianId: user.id }, { technicianId: null }] },
      select: { id: true, name: true },
      // Their own first.
      orderBy: [{ technicianId: { sort: 'asc', nulls: 'last' } }, { nameKey: 'asc' }],
    });
  }

  /** The job, when it is this technician's now and has not been cancelled: the phone knows this refusal by its code. */
  private async assigned(user: AuthenticatedUser, inspectionId: string): Promise<void> {
    const job = await this.prisma.inspection.findFirst({
      where: { id: inspectionId, organizationId: user.organizationId, status: { not: InspectionStatus.CANCELLED }, assignments: { some: { technicianId: user.id, isCurrent: true } } },
      select: { id: true },
    });
    if (!job) throw new ApplicationError(404, 'ASSIGNED_INSPECTION_NOT_FOUND', 'Assigned inspection was not found.');
  }
}
