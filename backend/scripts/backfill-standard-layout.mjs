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
 * ── HOW IT DIFFERS FROM `seed-property-layouts.mjs` ──────────────────────────
 *
 * That one sweeps every *property* with no rooms so the refusal at creation
 * never happens again. This one is about the inspections already scheduled,
 * whose areas were snapshotted empty and which no property-level seed can
 * reach. They share `seedStandardLayout`, so the rows they write are identical.
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
import { STANDARD_PROPERTY_LAYOUT, NON_ROOM_SOURCES, areaScopeFor } from '@texasrenters/shared';

import { ownerPrismaClient } from './owner-prisma.mjs';
// Shared with `seed-property-layouts.mjs`, which sweeps the whole portfolio.
// Two definitions of what a seeded layout is would be one too many: the
// lookup here and the write there have to agree about level and provenance.
import { approvedLayout, seedStandardLayout } from './standard-layout-seed.mjs';

const APPLY = process.argv.includes('--apply');
// The owner connection, not DATABASE_URL. The application role is subject to
// the tenant-isolation policies, so this script would see zero rows and report
// "nothing to do" — which is indistinguishable from genuinely being finished.
const prisma = ownerPrismaClient();

/** Building and unit together, because a unit's layout is its own. */
const scopeKey = (inspection) =>
  `${inspection.propertywareBuildingId}:${inspection.propertywareUnitId ?? 'whole'}`;

async function main() {
  const inspections = await prisma.inspection.findMany({
    where: {
      finalizedAt: null,
      // Work still to be walked, and nothing else. See the header.
      status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
      propertywareBuildingId: { not: null },
      /**
       * No *room* areas, rather than no areas.
       *
       * `hvacSystemArea` attaches one synthetic approved area — "HVAC System",
       * `source: SYSTEM` — to a property the first time an HVAC visit is
       * scheduled, and it never goes away. An occupied inspection created at
       * such a property before that was understood holds exactly that one area
       * and no rooms, so `none: {}` would walk straight past it and leave the
       * technician looking at a piece of equipment.
       */
      areas: { none: { propertyArea: { source: { notIn: NON_ROOM_SOURCES } } } },
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
        prisma,
        inspection.propertywareBuildingId,
        inspection.propertywareUnitId,
      );
      if (!areas.length) {
        console.log(`  seed layout  ${key}  ${inspection.propertywareBuilding?.addressLine1 ?? ''}`);
        seededScopes += 1;
        areas = APPLY
          ? await seedStandardLayout(
              prisma,
              inspection.propertywareBuildingId,
              inspection.propertywareUnitId,
            )
          : STANDARD_PROPERTY_LAYOUT.map(() => null);
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
