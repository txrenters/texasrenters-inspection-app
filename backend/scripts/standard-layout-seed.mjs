/**
 * Writing the standard room template onto a property, in one place.
 *
 * Two scripts need this and must not drift: `backfill-standard-layout.mjs`
 * seeds the properties behind inspections that are already scheduled and hold
 * no rooms, and `seed-property-layouts.mjs` sweeps the whole portfolio so the
 * question never arises. A second copy of "what a seeded layout is" is how one
 * of them ends up writing areas the other's lookup does not find.
 *
 * The rows themselves are `source: STANDARD_TEMPLATE` and say so in their
 * notes, so an administrator correcting a layout can tell a generated guess
 * from a plan somebody read — and `standardLayoutSuperseded` stands them aside
 * the moment a real layout arrives. Nothing here overwrites anything.
 */
import {
  STANDARD_LAYOUT_NOTE,
  STANDARD_LAYOUT_SOURCE,
  STANDARD_PROPERTY_LAYOUT,
  checklistTemplateFor,
  keywordsFromLabel,
  layoutAreasFor,
} from '@texasrenters/shared';

/** Everything a seed needs to know about the building it is writing to. */
const BUILDING_SELECT = {
  id: true,
  organizationId: true,
  name: true,
  addressLine1: true,
  city: true,
  state: true,
  postalCode: true,
};

/**
 * The layout an inspection at this scope would be built from today.
 *
 * Mirrors `resolveInspectionPlan`: a unit's own approved layout wins, and a
 * unit without one falls back to the building's. Reading it any other way
 * would seed at a level the creation path does not look at.
 */
export async function approvedLayout(prisma, buildingId, unitId) {
  const where = { propertyId: buildingId, status: 'APPROVED', archivedAt: null };
  const select = { id: true, source: true };
  const unitAreas = unitId
    ? await prisma.propertyArea.findMany({
        where: { ...where, unitId },
        orderBy: { inspectionOrder: 'asc' },
        select,
      })
    : [];
  const areas = unitAreas.length
    ? unitAreas
    : await prisma.propertyArea.findMany({
        where: { ...where, unitId: null },
        orderBy: { inspectionOrder: 'asc' },
        select,
      });
  return layoutAreasFor(areas);
}

/**
 * Writes the standard rooms for one scope, and their room checklists.
 *
 * Returns the scope's full approved layout afterwards, which is what an
 * inspection's snapshot is taken from. Idempotent: both `createMany` calls
 * skip duplicates against unique indexes, so a second run writes nothing and
 * still returns the same answer.
 */
export async function seedStandardLayout(prisma, buildingId, unitId = null) {
  const building = await prisma.propertywareBuilding.findUnique({
    where: { id: buildingId },
    select: BUILDING_SELECT,
  });
  if (!building) return [];

  // `PropertyArea.propertyId` carries a building id but keys to `Property`, a
  // separate lazily-populated table. Creating an area first violates the
  // foreign key — the same trap `hvacSystemArea` documents.
  await prisma.property.upsert({
    where: { id: building.id },
    update: {},
    create: {
      id: building.id,
      organizationId: building.organizationId,
      name: building.name,
      addressLine1: building.addressLine1 || 'Address not provided',
      city: building.city || 'Not provided',
      state: building.state || 'TX',
      postalCode: building.postalCode || 'Not provided',
    },
  });

  await prisma.propertyArea.createMany({
    data: STANDARD_PROPERTY_LAYOUT.map((area, index) => ({
      propertyId: building.id,
      unitId: unitId ?? null,
      floorId: null,
      name: area.name,
      inspectionOrder: index,
      isRequired: area.isRequired,
      status: 'APPROVED',
      source: STANDARD_LAYOUT_SOURCE,
      environment: area.environment,
      category: area.category ?? null,
      notes: STANDARD_LAYOUT_NOTE,
    })),
    // The unique index on (propertyId, unitId, floorId, name) is NULLS NOT
    // DISTINCT, so a second run over the same scope writes nothing.
    skipDuplicates: true,
  });

  // `archivedAt: null` because the creation path reads it that way. An
  // archived room keeps `status: APPROVED`, so leaving it out would count
  // rooms an inspection built from this layout would never be given.
  const written = await prisma.propertyArea.findMany({
    where: {
      propertyId: building.id,
      unitId: unitId ?? null,
      status: 'APPROVED',
      archivedAt: null,
    },
    orderBy: { inspectionOrder: 'asc' },
    select: { id: true, name: true, category: true, environment: true, source: true },
  });

  // Deterministic, never the AI generator: this runs over hundreds of
  // properties unattended, and a provider call per room is both a cost and a
  // way for the run to die halfway.
  await prisma.areaChecklistItem.createMany({
    data: written.flatMap((area) =>
      checklistTemplateFor({
        name: area.name,
        category: area.category,
        environment: area.environment,
      }).map((label, index) => ({
        organizationId: building.organizationId,
        propertyAreaId: area.id,
        kind: 'ROOM',
        label,
        keywords: keywordsFromLabel(label),
        sortOrder: index,
      })),
    ),
    skipDuplicates: true,
  });

  return layoutAreasFor(written);
}
