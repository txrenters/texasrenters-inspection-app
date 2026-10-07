import type { AreaChecklistItemKind, Prisma } from '@prisma/client';
import { BTM_LOCKBOX_SECTION, hvacSectionOf, isBtmLockboxArea } from '@texasrenters/shared';

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

/**
 * The part of an organization-wide list that one area asks.
 *
 * An HVAC inspection is walked in the office report's sections, one area each
 * -- Attic, Filters, A/C unit, Thermostat -- and each area asks its own
 * section's items, found by the area's name. Any other HVAC area asks the
 * whole list: the single "HVAC System" area of an inspection created before
 * the sections were areas.
 *
 * The occupied list is split strictly instead. Its sign, supra and lockbox
 * area asks only its own section (Moses, 2026-10-08), and every other room
 * asks only the items with no section -- the two condition questions. Asking
 * "the whole list" there would put "Key functioning?" in every bedroom.
 */
export function checklistSectionWhere(
  kind: ChecklistKind,
  areaName: string | null | undefined,
): Prisma.AreaChecklistItemWhereInput {
  const section = checklistSectionFor(kind, areaName);
  if (kind === 'OCCUPIED') return { section };
  return section ? { section } : {};
}

/** `checklistSectionWhere` over an item already loaded, for a summary that reads every area's items at once. */
export function checklistItemAsked(
  kind: ChecklistKind,
  areaName: string | null | undefined,
  itemSection: string | null,
): boolean {
  const section = checklistSectionFor(kind, areaName);
  if (kind === 'OCCUPIED') return itemSection === section;
  return !section || itemSection === section;
}

/**
 * The section `checklistSectionWhere` filters on, or null for the whole list.
 *
 * Exported for the area summary, which reads every area's items in one query
 * and has to narrow them in memory exactly as this narrows a single area's.
 */
export function checklistSectionFor(
  kind: ChecklistKind,
  areaName: string | null | undefined,
): string | null {
  if (kind === 'AIR_CONDITIONING') return hvacSectionOf(areaName);
  if (kind === 'OCCUPIED') return isBtmLockboxArea(areaName) ? BTM_LOCKBOX_SECTION : null;
  return null;
}
