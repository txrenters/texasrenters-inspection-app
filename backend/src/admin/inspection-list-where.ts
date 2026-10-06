import type { InspectionStatus, Prisma } from '@prisma/client';
import { VISIT_STATES, type VisitState } from '@texasrenters/shared';

import { visitStateWhere } from '../common/inspection-done';
import { searchTerms } from '../common/search-terms';

/**
 * How the inspections list narrows by status and by what was typed. Apart from
 * the service so each rule is testable as the query it builds.
 */

const STATES = new Set<string>(VISIT_STATES.map((state) => state.value));

/**
 * The list's status filter. A visit state (`VisitState`) is what the console
 * sends; a raw status is still honoured for a link written before.
 */
export function inspectionStatusWhere(status: string): Prisma.InspectionWhereInput {
  if (STATES.has(status)) return visitStateWhere(status as VisitState);
  return { status: status as InspectionStatus };
}

const insensitive = (value: string) => ({ contains: value, mode: 'insensitive' as const });

/**
 * One word of a search, found in any of the places an inspection is known by:
 * its property's name, street, city and ZIP (Propertyware's building, or the
 * property it was created against), its unit, the Jobber visit's title, and
 * the technician it is assigned to.
 *
 * The technician is the one that was missing outright (the office, 2026-10-07:
 * "if I filter the technician... it won't show also, because I think there's
 * no logic for the search bar to search for the technician").
 */
function anyFieldContains(word: string): Prisma.InspectionWhereInput[] {
  const match = insensitive(word);
  return [
    { propertywareBuilding: { name: match } },
    { propertywareBuilding: { addressLine1: match } },
    { propertywareBuilding: { city: match } },
    { propertywareBuilding: { postalCode: match } },
    { propertywareUnit: { name: match } },
    { property: { name: match } },
    { property: { addressLine1: match } },
    { jobberVisitTitle: match },
    { assignments: { some: { isCurrent: true, technician: { displayName: match } } } },
  ];
}

/**
 * Every word of the search found somewhere, in any order (`searchTerms`). One
 * AND clause per word, each an OR of the fields and of the word's spellings.
 */
export function inspectionSearchWhere(search: string | undefined): Prisma.InspectionWhereInput[] {
  return searchTerms(search).map((spellings) => ({
    OR: spellings.flatMap((spelling) => anyFieldContains(spelling)),
  }));
}
