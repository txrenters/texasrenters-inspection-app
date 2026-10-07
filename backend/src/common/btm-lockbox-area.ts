import {
  AreaCategory,
  AreaChecklistItemKind,
  AreaEnvironment,
  PropertyAreaStatus,
  type Prisma,
} from '@prisma/client';
import {
  BTM_LOCKBOX_AREA_NAME,
  BTM_LOCKBOX_CHECKLIST,
  BTM_LOCKBOX_SECTION,
  isBtmLockboxArea,
} from '@texasrenters/shared';

import type { PrismaService } from './prisma.service';

/**
 * The sign, supra and lockbox area of a back-to-market visit, and its questions.
 *
 * Moses, 2026-10-08; see `btm-lockbox` in shared for what is asked and why.
 * Written in two places: when a back-to-market inspection is created, and --
 * for the ones already booked -- when the technician's phone first opens one
 * still to be done (`TechnicianService.rooms`). Both go through here.
 */

type Client = Prisma.TransactionClient | PrismaService;

/** After every room of the walk: the sign and the lockbox are the last thing done on the way out. */
export const BTM_LOCKBOX_INSPECTION_ORDER = 10_000;

/** After the condition questions, which share the organization's occupied list. */
const BTM_LOCKBOX_FIRST_SORT_ORDER = 100;

/**
 * The organization's sign, supra and lockbox rows, written once.
 *
 * Organization-wide occupied rows with their own section, like an HVAC
 * section's: `checklistSectionWhere` gives them to this area alone. No
 * keywords, as for the condition questions -- a transcript cannot say whether
 * the key turned.
 */
export async function ensureBtmLockboxChecklist(client: Client, organizationId: string) {
  await client.areaChecklistItem.createMany({
    data: BTM_LOCKBOX_CHECKLIST.map((item, index) => ({
      organizationId,
      propertyAreaId: null,
      kind: AreaChecklistItemKind.OCCUPIED,
      label: item.label,
      section: BTM_LOCKBOX_SECTION,
      responseType: item.responseType,
      unit: null,
      choices: item.choices,
      keywords: [],
      sortOrder: BTM_LOCKBOX_FIRST_SORT_ORDER + index,
    })),
    skipDuplicates: true,
  });
}

/**
 * Finds or creates the property's sign, supra and lockbox area.
 *
 * `SYSTEM`, like the HVAC sections and the roof: nobody drew it, it has no
 * floor, and `layoutAreasFor` keeps it out of every other visit to the
 * property -- a move-out there must not be asked whether the lockbox key
 * works. `isInspectedArea` lets a back-to-market visit see it.
 *
 * The property row must exist already (`ensureAreaProperty`, or the
 * inspection's own building for one already booked).
 */
export async function btmLockboxPropertyArea(
  client: Client,
  place: { propertyId: string; unitId: string | null },
): Promise<string> {
  const where = {
    propertyId: place.propertyId,
    unitId: place.unitId,
    floorId: null,
    name: BTM_LOCKBOX_AREA_NAME,
  };
  const existing = await client.propertyArea.findFirst({ where, select: { id: true } });
  if (existing) return existing.id;
  const created = await client.propertyArea.create({
    data: {
      ...where,
      inspectionOrder: BTM_LOCKBOX_INSPECTION_ORDER,
      isRequired: true,
      status: PropertyAreaStatus.APPROVED,
      source: 'SYSTEM',
      environment: AreaEnvironment.OUTDOOR,
      category: AreaCategory.OTHER_OUTDOOR,
      notes: 'Created automatically for back-to-market inspections. Not part of the floor plan.',
    },
    select: { id: true },
  });
  return created.id;
}

/** Whether any of these areas already is one -- a technician may have added it by hand. */
export function includesLockboxArea(areas: readonly { name: string }[]) {
  return areas.some((area) => isBtmLockboxArea(area.name));
}
