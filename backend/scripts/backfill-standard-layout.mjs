/**
 * Gives an occupied inspection holding no rooms the standard layout.
 *
 * `InspectionArea` is a snapshot taken when an inspection is created, from the
 * property's *approved* layout. Nothing back-fills it, by design — an
 * inspection is a record of a walkthrough, not a live view of a floor plan. So
 * seeding the layout at creation time, which is what inspection-creation now
 * does, reaches every occupied inspection made from here on and **none** of the
 * ones already scheduled. Those still arrive at the technician empty, and the
 * technician still types the rooms in by hand.
 *
 * This is the catch-up, meant to be run once when the release is cut.
 *
 * ── HOW IT DIFFERS FROM `share-inspection-areas.mjs` ─────────────────────────
 *
 * That script copies rooms from a **sibling inspection** at the same address —
 * the right source when one exists, because an import drops rooms a report did
 * not mention and a property's raw layout can carry junk. This one is for the
 * case it cannot help with: no sibling has rooms either, because nobody has
 * ever walked the property in this system.
 *
 * Both skip an inspection that already holds rooms, so running them in either
 * order is safe.
 *
 * ── WHAT IT WILL NOT TOUCH ───────────────────────────────────────────────────
 *
 * - An inspection that already holds rooms. It has a snapshot, and a snapshot
 *   is not ours to extend.
 * - A finalized one, which stays as it was signed off.
 * - A cancelled one, which is not going to be walked.
 * - **Anything already walked.** Only SCHEDULED and IN_PROGRESS are touched.
 *   A completed or submitted inspection is a record of work somebody did, and
 *   giving it rooms after the fact claims coverage of rooms nobody entered —
 *   it would also reopen its progress count, so a finished job would start
 *   reading as unfinished. The first draft of this script filtered only on
 *   `finalizedAt` and `CANCELLED`, which on the dev database would have
 *   rewritten a completed back-to-market.
 * - A move-in or move-out. Their type overrides `isRequired`, so every guessed
 *   room becomes mandatory, and a move-out is compared to its move-in area by
 *   area — seeding both ends from a guess produces a comparison against rooms
 *   nobody has seen. They inherit the layout later, because it is the
 *   property's and it is permanent.
 * - A property that already has an approved layout from a report or a floor
 *   plan. The standard rooms stand aside for a real layout; see
 *   `standardLayoutSuperseded`.
 *
 * Dry run unless `--apply` is passed. Prints the same plan either way, so the
 * run that changes data is the one already reviewed.
 *
 *   node scripts/backfill-standard-layout.mjs            # plan only
 *   node scripts/backfill-standard-layout.mjs --apply    # write
 */
import {
  STANDARD_LAYOUT_NOTE,
  STANDARD_LAYOUT_SOURCE,
  STANDARD_PROPERTY_LAYOUT,
  areaScopeFor,
  checklistTemplateFor,
  keywordsFromLabel,
  layoutAreasFor,
} from '@texasrenters/shared';

import { ownerPrismaClient } from './owner-prisma.mjs';

const APPLY = process.argv.includes('--apply');
// The owner connection, not DATABASE_URL. The application role is subject to
// the tenant-isolation policies, so this script would see zero rows and report
// "nothing to do" — which is indistinguishable from genuinely being finished.
const prisma = ownerPrismaClient();

/** Building and unit together, because a unit's layout is its own. */
const scopeKey = (inspection) =>
  `${inspection.propertywareBuildingId}:${inspection.propertywareUnitId ?? 'whole'}`;

/** The layout an inspection at this scope would be built from today. */
async function approvedLayout(buildingId, unitId) {
  const where = { propertyId: buildingId, status: 'APPROVED', archivedAt: null };
  const unitAreas = unitId
    ? await prisma.propertyArea.findMany({
        where: { ...where, unitId },
        orderBy: { inspectionOrder: 'asc' },
        select: { id: true, source: true },
      })
    : [];
  const areas = unitAreas.length
    ? unitAreas
    : await prisma.propertyArea.findMany({
        where: { ...where, unitId: null },
        orderBy: { inspectionOrder: 'asc' },
        select: { id: true, source: true },
      });
  return layoutAreasFor(areas);
}

/** Writes the standard rooms for a scope, and their room checklists. */
async function seedLayout(inspection) {
  const { propertywareBuildingId: buildingId, propertywareUnitId: unitId } = inspection;
  const building = await prisma.propertywareBuilding.findUnique({
    where: { id: buildingId },
    select: {
      id: true,
      organizationId: true,
      name: true,
      addressLine1: true,
      city: true,
      state: true,
      postalCode: true,
    },
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

  const written = await prisma.propertyArea.findMany({
    where: { propertyId: building.id, unitId: unitId ?? null, status: 'APPROVED' },
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

async function main() {
  const inspections = await prisma.inspection.findMany({
    where: {
      finalizedAt: null,
      // Work still to be walked, and nothing else. See the header.
      status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
      propertywareBuildingId: { not: null },
      areas: { none: {} },
    },
    select: {
      id: true,
      inspectionType: true,
      status: true,
      scheduledAt: true,
      organizationId: true,
      propertywareBuildingId: true,
      propertywareUnitId: true,
      propertywareBuilding: { select: { name: true, addressLine1: true } },
    },
    orderBy: { scheduledAt: 'asc' },
  });

  // The same rule inspection creation applies, read from the same function: a
  // visit that walks whichever rooms the office picked. Move-in and move-out
  // are excluded here for the reasons in the header.
  const candidates = inspections.filter(
    (inspection) => areaScopeFor(inspection.inspectionType) === 'CHOSEN',
  );

  console.log(
    `${inspections.length} inspection(s) hold no rooms; ${candidates.length} are a chosen-scope visit this can seed.`,
  );
  if (!candidates.length) return;

  // Cached per scope: several inspections at one address must not each write a
  // layout, and must not each re-read one.
  const layouts = new Map();
  let seededScopes = 0;
  let attached = 0;

  for (const inspection of candidates) {
    const key = scopeKey(inspection);
    if (!layouts.has(key)) {
      let areas = await approvedLayout(
        inspection.propertywareBuildingId,
        inspection.propertywareUnitId,
      );
      if (!areas.length) {
        console.log(`  seed layout  ${key}  ${inspection.propertywareBuilding?.addressLine1 ?? ''}`);
        seededScopes += 1;
        areas = APPLY ? await seedLayout(inspection) : STANDARD_PROPERTY_LAYOUT.map(() => null);
      }
      layouts.set(key, areas);
    }
    const areas = layouts.get(key);
    console.log(
      `  ${inspection.inspectionType.padEnd(16)} ${inspection.id}  <- ${areas.length} area(s)`,
    );
    attached += 1;
    if (!APPLY) continue;

    await prisma.inspectionArea.createMany({
      data: areas.map((area) => ({ inspectionId: inspection.id, propertyAreaId: area.id })),
      // The unique index on (inspectionId, propertyAreaId) makes a re-run free.
      skipDuplicates: true,
    });
  }

  console.log(
    `\n${APPLY ? 'Applied' : 'Dry run'}: ${seededScopes} layout(s) seeded, ${attached} inspection(s) given rooms.`,
  );
  if (!APPLY) console.log('Re-run with --apply to write.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
