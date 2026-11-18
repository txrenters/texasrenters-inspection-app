import { Inject, Injectable } from '@nestjs/common';
import { PurchaseOrderStatus } from '@prisma/client';
import { daysOfStock, stockStatus, suggestedOrder, usagePeriodSpan, type InventoryMonitoring, type UsagePeriod } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';
import { businessDate, businessInstant } from '../common/business-day';
import { PrismaService } from '../common/prisma.service';

/**
 * Reorder and usage (2026-11-19, phase 7 of the inventory and purchasing
 * plan). Read-only: what has reached its reorder level, with what is already
 * on order and how long it will last, and what the materials came to over a
 * period, by technician and by kind of job.
 *
 * Everything is added up by the database from the stock ledger and the
 * slips: nine reads at most, whatever the number of items or movements, and
 * each scoped to the caller's office. A movement that was reversed counts
 * against the kind it reversed, so a withdrawal entered by mistake and
 * reversed is not "used". Nothing is written, nothing is polled, and nothing
 * here calls anything billed.
 */

/** Ordered from a vendor and still to arrive. */
const ON_ORDER: PurchaseOrderStatus[] = [PurchaseOrderStatus.APPROVED, PurchaseOrderStatus.SENT, PurchaseOrderStatus.PARTLY_RECEIVED];
/** "MOVE_OUT" as "Move out". */
const humanize = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');

interface MovedRow {
  kind: string;
  itemId: string;
  quantity: number;
  value: bigint | number;
}
interface TechnicianRow {
  technicianId: string;
  slips: number;
  value: bigint | number;
}
interface JobRow {
  job: string | null;
  visits: number;
  value: bigint | number;
}

@Injectable()
export class InventoryMonitoringService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async report(user: AuthenticatedUser, period: UsagePeriod = '30d'): Promise<InventoryMonitoring> {
    const organizationId = user.organizationId;
    const today = businessDate();
    const { from, days } = usagePeriodSpan(period, today);
    // The first moment of the first Texas day counted.
    const since = businessInstant(from, '00:00:00');

    const [items, levels, moved, technicians, jobs, organisations] = await Promise.all([
      this.prisma.stockItem.findMany({
        where: { organizationId, active: true, reorderLevel: { gt: 0 } },
        select: { id: true, code: true, name: true, unit: true, xeroTenantId: true, reorderLevel: true, reorderQuantity: true, usualVendor: { select: { id: true, name: true } } },
        orderBy: { codeKey: 'asc' },
      }),
      this.prisma.stockLevel.groupBy({ by: ['itemId'], where: { organizationId }, _sum: { quantity: true } }),
      // What moved, by item and by the kind it is, or the kind it reversed.
      this.prisma.$queryRaw<MovedRow[]>`
        SELECT COALESCE(first."kind", moved."kind")::text AS "kind", moved."itemId", SUM(moved."quantity")::int AS "quantity",
               SUM(moved."quantity"::bigint * moved."unitCostCents")::bigint AS "value"
        FROM "StockMovement" moved LEFT JOIN "StockMovement" first ON first."id" = moved."reversesId"
        WHERE moved."organizationId" = ${organizationId}::uuid AND moved."createdAt" >= ${since}
        GROUP BY 1, 2`,
      // What each technician took, less what they brought back, on slips still standing.
      this.prisma.$queryRaw<TechnicianRow[]>`
        SELECT slip."technicianId", COUNT(DISTINCT slip."id")::int AS "slips",
               SUM((CASE WHEN slip."kind" = 'RETURN' THEN -1 ELSE 1 END) * line."quantity"::bigint * line."unitCostCents")::bigint AS "value"
        FROM "StockSlip" slip JOIN "StockSlipLine" line ON line."slipId" = slip."id" AND line."organizationId" = slip."organizationId"
        WHERE slip."organizationId" = ${organizationId}::uuid AND slip."kind" IN ('WITHDRAWAL', 'RETURN') AND slip."technicianId" IS NOT NULL
          AND slip."reversedAt" IS NULL AND slip."createdAt" >= ${since}
        GROUP BY 1`,
      // The same, by the kind of visit it was for.
      this.prisma.$queryRaw<JobRow[]>`
        SELECT visit."inspectionType"::text AS "job", COUNT(DISTINCT slip."inspectionId")::int AS "visits",
               SUM((CASE WHEN slip."kind" = 'RETURN' THEN -1 ELSE 1 END) * line."quantity"::bigint * line."unitCostCents")::bigint AS "value"
        FROM "StockSlip" slip JOIN "StockSlipLine" line ON line."slipId" = slip."id" AND line."organizationId" = slip."organizationId"
          LEFT JOIN "Inspection" visit ON visit."id" = slip."inspectionId" AND visit."organizationId" = slip."organizationId"
        WHERE slip."organizationId" = ${organizationId}::uuid AND slip."kind" IN ('WITHDRAWAL', 'RETURN')
          AND slip."reversedAt" IS NULL AND slip."createdAt" >= ${since}
        GROUP BY 1`,
      this.prisma.xeroOrganisation.findMany({ where: { organizationId }, select: { xeroTenantId: true, name: true } }),
    ]);

    const onHand = new Map(levels.map((level) => [level.itemId, level._sum.quantity ?? 0]));
    const low = items.filter((item) => (onHand.get(item.id) ?? 0) <= item.reorderLevel);
    const [ordered, people] = await Promise.all([
      low.length
        ? this.prisma.purchaseOrderLine.findMany({ where: { organizationId, itemId: { in: low.map((item) => item.id) }, order: { status: { in: ON_ORDER } } }, select: { itemId: true, quantity: true, receivedQuantity: true } })
        : [],
      technicians.length ? this.prisma.userProfile.findMany({ where: { id: { in: technicians.map((row) => row.technicianId) } }, select: { id: true, displayName: true } }) : [],
    ]);
    const onOrder = new Map<string, number>();
    for (const line of ordered) onOrder.set(line.itemId, (onOrder.get(line.itemId) ?? 0) + Math.max(0, line.quantity - line.receivedQuantity));

    // Out is negative in the ledger: "used" is what left less what came back.
    const used = new Map<string, number>();
    const value = { WITHDRAWAL: 0, RETURN: 0, RECEIPT: 0, COUNT_ADJUSTMENT: 0 } as Record<string, number>;
    for (const row of moved) {
      value[row.kind] = (value[row.kind] ?? 0) + Number(row.value);
      if (row.kind === 'WITHDRAWAL' || row.kind === 'RETURN') used.set(row.itemId, (used.get(row.itemId) ?? 0) - row.quantity);
    }
    const company = new Map(organisations.map((row) => [row.xeroTenantId, row.name]));
    const nameOf = new Map(people.map((person) => [person.id, person.displayName]));

    return {
      period,
      from,
      to: today,
      usedCents: 0 - (value.WITHDRAWAL! + value.RETURN!),
      boughtCents: value.RECEIPT!,
      lostInCountsCents: 0 - value.COUNT_ADJUSTMENT!,
      reorder: low.map((item) => {
        const have = onHand.get(item.id) ?? 0;
        const gone = Math.max(0, used.get(item.id) ?? 0);
        return {
          itemId: item.id,
          code: item.code,
          name: item.name,
          unit: item.unit,
          company: item.xeroTenantId ? { tenantId: item.xeroTenantId, name: company.get(item.xeroTenantId) ?? 'A company' } : null,
          status: stockStatus(have, item.reorderLevel),
          onHand: have,
          reorderLevel: item.reorderLevel,
          onOrder: onOrder.get(item.id) ?? 0,
          used: gone,
          lastsDays: daysOfStock(have, gone, days),
          suggested: suggestedOrder({ onHand: have, reorderLevel: item.reorderLevel, reorderQuantity: item.reorderQuantity }),
          usualVendor: item.usualVendor,
        };
      }),
      byTechnician: technicians
        .map((row) => ({ technicianId: row.technicianId, name: nameOf.get(row.technicianId) ?? 'Somebody', valueCents: Number(row.value), slips: row.slips }))
        .sort((left, right) => right.valueCents - left.valueCents || left.name.localeCompare(right.name)),
      byJob: jobs
        .map((row) => ({ job: row.job ? humanize(row.job) : null, visits: row.job ? row.visits : 0, valueCents: Number(row.value) }))
        // The kinds of job by what they used, and what no visit was named for last.
        .sort((left, right) => Number(left.job === null) - Number(right.job === null) || right.valueCents - left.valueCents),
    };
  }
}
