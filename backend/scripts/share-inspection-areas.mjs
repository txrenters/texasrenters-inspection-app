/**
 * Gives an inspection holding no rooms the rooms its siblings at the same
 * property already have.
 *
 * Why they need it: `InspectionArea` is a snapshot taken when an inspection is
 * created, from the property's *approved* layout. A property nobody had walked
 * yet has no approved layout, so every inspection scheduled against it was born
 * with zero rooms — and nothing that happens to the layout afterwards reaches
 * them, by design. An inspection is a record of a walkthrough, not a live view
 * of a floor plan.
 *
 * 21223 Harbor Shore Dr is the report this came from: a move-in imported twelve
 * rooms, and the occupied inspection at the same address still read "0 areas",
 * with an Add area button and nothing to add. Move-in, occupied and move-out
 * walk the same rooms — the office's own rule — so the layout one of them
 * establishes is the layout for all of them. The import now shares it as it
 * writes; this is for the inspections that predate that.
 *
 * The rooms come from a **sibling inspection**, not from the property's
 * approved layout. Those differ, deliberately: an import drops rooms the report
 * does not mention, and 10051 Spotted Horse Dr had two invented test rooms on
 * its layout that must not come back one inspection over.
 *
 * Untouched on purpose:
 *
 * - an inspection that already holds rooms — it has a snapshot, and a snapshot
 *   is not ours to extend;
 * - a finalized one, which stays as it was signed off;
 * - a cancelled one, which is not going to be walked.
 *
 * Dry run unless `--apply` is passed. Prints the same plan either way, so the
 * run that changes data is the one already reviewed.
 *
 *   node scripts/share-inspection-areas.mjs            # plan only
 *   node scripts/share-inspection-areas.mjs --apply    # write
 */
import { ownerPrismaClient } from './owner-prisma.mjs';

const APPLY = process.argv.includes('--apply');
// The owner connection, not DATABASE_URL. The application role is subject to
// the tenant-isolation policies, so this script would see zero rows and report
// "nothing to do" — which is indistinguishable from genuinely being finished.
const prisma = ownerPrismaClient();

/** Building and unit together, because a unit's layout is its own. */
const scopeKey = (inspection) =>
  `${inspection.propertywareBuildingId ?? 'none'}:${inspection.propertywareUnitId ?? 'whole'}`;

async function main() {
  const inspections = await prisma.inspection.findMany({
    where: {
      finalizedAt: null,
      status: { not: 'CANCELLED' },
      propertywareBuildingId: { not: null },
    },
    select: {
      id: true,
      inspectionType: true,
      status: true,
      propertywareBuildingId: true,
      propertywareUnitId: true,
      propertywareBuilding: { select: { addressLine1: true } },
      areas: { select: { propertyAreaId: true } },
    },
    orderBy: { scheduledAt: 'asc' },
  });

  /** Every inspection at one property/unit, so a donor is found without a second query. */
  const byScope = new Map();
  for (const inspection of inspections) {
    const key = scopeKey(inspection);
    if (!byScope.has(key)) byScope.set(key, []);
    byScope.get(key).push(inspection);
  }

  const plan = [];
  for (const group of byScope.values()) {
    const empty = group.filter((inspection) => !inspection.areas.length);
    if (!empty.length) continue;
    /**
     * The richest sibling, not the first.
     *
     * Two inspections at one property can both hold rooms and hold different
     * numbers of them — one created before a room was added to the layout, one
     * after. Taking the fullest is the only choice that never hands over less
     * than some other record already proves the property has.
     */
    const donor = group
      .filter((inspection) => inspection.areas.length)
      .sort((left, right) => right.areas.length - left.areas.length)[0];
    if (!donor) continue;

    const rooms = [...new Set(donor.areas.map((area) => area.propertyAreaId))];
    for (const inspection of empty)
      plan.push({
        inspectionId: inspection.id,
        address: inspection.propertywareBuilding?.addressLine1 ?? 'unknown',
        type: inspection.inspectionType,
        status: inspection.status,
        from: donor.id,
        rooms,
      });
  }

  console.log(`inspections with no rooms that a sibling can fill: ${plan.length}`);
  for (const entry of plan)
    console.log(
      `  ${entry.address} · ${entry.type} · ${entry.status} · ${entry.rooms.length} rooms from ${entry.from.slice(0, 8)}`,
    );

  if (!plan.length) return;
  if (!APPLY) {
    console.log('\ndry run — pass --apply to write');
    return;
  }

  let created = 0;
  for (const entry of plan) {
    // skipDuplicates because the unique pair is the real guard: a room added by
    // hand between the plan and the write should not fail the whole run.
    const result = await prisma.inspectionArea.createMany({
      data: entry.rooms.map((propertyAreaId) => ({
        inspectionId: entry.inspectionId,
        propertyAreaId,
      })),
      skipDuplicates: true,
    });
    created += result.count;
  }
  console.log(`\nattached ${created} rooms across ${plan.length} inspections`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
