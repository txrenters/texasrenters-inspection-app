import type { AreaChecklistItemKind, Prisma } from '@prisma/client';

/**
 * Turns the shared contract's answer into a Prisma filter.
 *
 * `checklistKindFor` can say `'NONE'` — a lockbox is fitted or it is not, and
 * asking whether the floor coverings are clean would be the original HVAC bug
 * in a new costume. Prisma has no enum member for "nothing", so an empty `in`
 * carries it: no rows match, and every caller gets the same empty list back
 * rather than having to branch on a query that did not run.
 */
export function checklistKindWhere(
  kind: 'ROOM' | 'AIR_CONDITIONING' | 'NONE',
): Prisma.AreaChecklistItemWhereInput {
  if (kind === 'NONE') return { kind: { in: [] } };
  return { kind: kind as AreaChecklistItemKind };
}
