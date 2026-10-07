import type { Prisma } from '@prisma/client';
import {
  BTM_LOCKBOX_AREA_NAME,
  HVAC_FILTERS_SECTION,
  inspectionWalksRooms,
  isInspectedArea,
  NON_ROOM_SOURCES,
  SERVICE_PHOTO_AREA_NAMES,
} from '@texasrenters/shared';

/**
 * `isInspectedArea` as a filter on `InspectionArea`, for a query that counts or
 * lists an inspection's areas in the database.
 *
 * The office, 2026-09-29: "inspection is purely for inspection". A job's
 * "AC filters" photo area is attached to the inspection because a photograph
 * needs an area, and it was listed with the rooms, counted as one, printed in
 * the report, and -- on a move-in or move-out -- refused completion. Every
 * reader of an inspection's areas asks this, so the two forms of the rule are
 * kept side by side and tested against each other.
 */
export function inspectedAreaWhere(inspectionType: string): Prisma.InspectionAreaWhereInput {
  const equipment = { source: { in: [...NON_ROOM_SOURCES] } };
  // A back-to-market visit's sign, supra and lockbox is the one system area a
  // room walk inspects (Moses, 2026-10-08).
  if (inspectionType === 'BACK_TO_MARKET')
    return { NOT: { propertyArea: { ...equipment, name: { not: BTM_LOCKBOX_AREA_NAME } } } };
  if (inspectionWalksRooms(inspectionType)) return { NOT: { propertyArea: equipment } };
  const excluded: Prisma.InspectionAreaWhereInput[] = [
    { propertyArea: { ...equipment, name: { in: [...SERVICE_PHOTO_AREA_NAMES] } } },
  ];
  // An HVAC inspection's Filters section unless submitted: scored on the AC
  // filter change now (Moses, 2026-10-01).
  if (inspectionType === 'HVAC')
    excluded.push({
      propertyArea: { ...equipment, name: HVAC_FILTERS_SECTION },
      completionStatus: { not: 'COMPLETED' },
    });
  return { NOT: excluded };
}

/** The same rule over areas already loaded, each with its property area's name and source. */
export function inspectedAreas<
  Area extends { propertyArea: { name: string; source: string }; completionStatus?: string | null },
>(inspectionType: string, areas: readonly Area[]): Area[] {
  return areas.filter((area) =>
    isInspectedArea(inspectionType, { ...area.propertyArea, completionStatus: area.completionStatus }),
  );
}
