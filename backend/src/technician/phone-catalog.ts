import { MOST_PHONE_CATALOG, type PhoneCatalogItem } from '@texasrenters/shared';

import type { PrismaService } from '../common/prisma.service';

/**
 * Every item in use that keeps stock, for the phone (2026-11-24): a search
 * finds one with none on the truck, a scan tells a code that is no item from
 * one that is not on the truck, and a count adds one found that it did not
 * list. One read; an office's own list never comes near the cap.
 */
export async function phoneCatalog(db: Pick<PrismaService, 'stockItem'>, organizationId: string): Promise<PhoneCatalogItem[]> {
  const items = await db.stockItem.findMany({
    where: { organizationId, active: true, OR: [{ lineTypeId: null }, { lineType: { keepsStock: true } }] },
    select: { id: true, code: true, name: true, unit: true },
    orderBy: { codeKey: 'asc' },
    take: MOST_PHONE_CATALOG,
  });
  return items.map((item) => ({ itemId: item.id, code: item.code, name: item.name, unit: item.unit }));
}
