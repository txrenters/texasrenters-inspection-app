import type { AreaChecklistItemKind, Prisma } from '@prisma/client';

/** What `checklistKindFor` can answer. Widened here so both helpers agree. */
export type ChecklistKind = 'ROOM' | 'AIR_CONDITIONING' | 'OCCUPIED' | 'NONE';

/**
 * Turns the shared contract's answer into a Prisma filter.
 *
 * `checklistKindFor` can say `'NONE'` — a lockbox is fitted or it is not, and
 * asking whether the floor coverings are clean would be the original HVAC bug
 * in a new costume. Prisma has no enum member for "nothing", so an empty `in`
 * carries it: no rows match, and every caller gets the same empty list back
 * rather than having to branch on a query that did not run.
 */
export function checklistKindWhere(kind: ChecklistKind): Prisma.AreaChecklistItemWhereInput {
  if (kind === 'NONE') return { kind: { in: [] } };
  return { kind: kind as AreaChecklistItemKind };
}

/**
 * Whether this kind's items belong to the organization rather than to an area.
 *
 * The two are stored differently and so have to be *queried* differently: a
 * room list is found by `propertyAreaId`, an organization-wide list by
 * `organizationId` with the area id null. Getting it wrong returns an empty
 * checklist, which on a handset is indistinguishable from an area nobody
 * configured.
 *
 * Asked as a question about the kind rather than written inline as
 * `=== 'AIR_CONDITIONING'`, which is what the two call sites did. That spelling
 * is not wrong so much as unfinished: it silently answers "per area" for any
 * kind added later, and the occupied list — added 2026-09-09 and organization-
 * wide for the same reason HVAC is — would have queried a property area that
 * holds none of its rows and shown the technician nothing.
 */
export function checklistItemsAreOrganizationWide(kind: ChecklistKind): boolean {
  return kind === 'AIR_CONDITIONING' || kind === 'OCCUPIED';
}
