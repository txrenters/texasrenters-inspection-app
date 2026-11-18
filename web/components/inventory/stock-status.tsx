import type { StockItemRow } from '@texasrenters/shared';

import { Badge } from '@/components/ui/badge';

/** Enough, Low or Out, by the item's own reorder level; an item no longer stocked says so instead. */
export function StockStatusBadge({ item }: { item: Pick<StockItemRow, 'active' | 'status'> }) {
  if (!item.active) return <Badge variant="secondary">Switched off</Badge>;
  if (item.status === 'OUT') return <Badge variant="destructive">Out</Badge>;
  if (item.status === 'LOW') return <Badge variant="warning">Low</Badge>;
  return <Badge variant="success">Enough</Badge>;
}

/** In use, or switched off: for a place or a vendor. */
export function InUseBadge({ active }: { active: boolean }) {
  return active ? <Badge variant="success">In use</Badge> : <Badge variant="secondary">Switched off</Badge>;
}
