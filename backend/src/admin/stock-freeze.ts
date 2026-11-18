import { StockCountKind, StockCountStatus, type Prisma } from '@prisma/client';

import { ApplicationError } from '../common/errors';

/** A count that is not finished. */
export const OPEN_COUNT: StockCountStatus[] = [StockCountStatus.OPEN, StockCountStatus.COUNTING, StockCountStatus.REVIEW];

/**
 * While a yearly count is open nothing moves (2026-11-19, phase 6): what was
 * counted must still be there when the count is posted. Everything that
 * writes a stock movement asks this first, inside its own transaction, so the
 * office is told why in its own words. The ledger's trigger
 * (`StockMovement_stock_is_frozen`) holds the same rule when two requests
 * race. One indexed read; nothing billed.
 */
export async function assertStockNotFrozen(db: Pick<Prisma.TransactionClient, 'stockCount'>, organizationId: string): Promise<void> {
  const yearly = await db.stockCount.findFirst({ where: { organizationId, kind: StockCountKind.YEARLY, status: { in: OPEN_COUNT } }, select: { number: true } });
  if (yearly) throw new ApplicationError(409, 'STOCK_FROZEN', `The yearly count ${yearly.number} is open, so stock cannot move until it is posted or cancelled.`);
}
