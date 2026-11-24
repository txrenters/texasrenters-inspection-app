import { deletedItemName } from '@texasrenters/shared';

/**
 * An item as a document shows it (2026-11-24): a requisition, order or receipt
 * that named an item code keeps its line once the code is deleted, and says
 * so -- "Asus Vivobook (deleted)", and `deleted` for the page's badge. The
 * deletion time itself is not sent.
 */
export function shownItem<Item extends { name: string; deletedAt: Date | null }>(item: Item): Omit<Item, 'deletedAt'> & { deleted: boolean } {
  const { deletedAt, ...rest } = item;
  const deleted = Boolean(deletedAt);
  return { ...rest, name: deleted ? deletedItemName(item.name) : item.name, deleted };
}
