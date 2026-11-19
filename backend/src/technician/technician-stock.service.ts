import { Inject, Injectable } from '@nestjs/common';
import { InspectionStatus, StockPlaceKind, StockSlipKind } from '@prisma/client';
import { jobStockProblem, jobStockTaken, type JobStock, type JobStockSlip, type PhoneSlipKind, type RecordJobStockInput } from '@texasrenters/shared';

import { StockSlipsService } from '../admin/stock-slips.service';
import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

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
 * The phone keeps a slip until the server answers and may send it twice: its
 * key makes the second one record nothing. Nothing here calls anything
 * billed.
 */

/** A job's slips never come near this; it bounds the read. */
const MOST_SLIPS = 60;

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
    const [levels, slips] = await Promise.all([
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
    };
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
