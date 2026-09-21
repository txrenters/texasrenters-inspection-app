/**
 * Gives every property with no recorded rooms the standard layout.
 *
 * ── THE BLOCKER THIS REMOVES ─────────────────────────────────────────────────
 *
 * `resolveInspectionPlan` refuses to create an inspection at a property with
 * no approved areas — NO_APPROVED_AREAS, "Upload or define the property floor
 * plan and approve its areas before creating an inspection." Every path around
 * it is a decision somebody has to take one property at a time: the console
 * offers a checkbox delegating the survey to the technician, and the Jobber
 * sync ticks it automatically for the five types it imports.
 *
 * The office (2026-09-22) asked for the other answer, which is the one this
 * script is: "let's create a template first since we have the move in
 * inspections from other property, we will just create/seed the template to
 * all properties that has no record yet so this blocker will be fixed".
 *
 * 147 active properties of 588 have no room recorded against them at all.
 *
 * ── HOW IT DIFFERS FROM `backfill-standard-layout.mjs` ───────────────────────
 *
 * That script is driven by *inspections already scheduled* and holding no
 * rooms: it seeds their properties and then attaches the rooms to those
 * inspections, because an inspection's areas are a snapshot and nothing
 * back-fills them. This one is driven by *properties*, attaches nothing, and
 * exists so the refusal never happens in the first place. Run this one first
 * and that one has less to do; run them in either order and neither repeats
 * the other's work.
 *
 * ── WHAT IT WILL NOT TOUCH ───────────────────────────────────────────────────
 *
 * - A property with any approved room already — from a report import, a floor
 *   plan, a technician's on-site survey, or an earlier run of this. Its layout
 *   is somebody's answer and this one is a guess.
 * - The synthetic "HVAC System" area, which is equipment rather than a room.
 *   A property carrying only that one still counts as having no layout, which
 *   is the case `NON_ROOM_SOURCES` exists for.
 * - An inactive property. It is not going to be inspected, and seeding it
 *   would put a guess on a record nobody will ever correct.
 * - Any inspection. Areas are snapshotted at creation and a snapshot is not
 *   ours to extend — that is `backfill-standard-layout.mjs`, deliberately
 *   separate and deliberately narrower about which inspections it will touch.
 *
 * Dry run unless `--apply` is passed. Prints the same plan either way, so the
 * run that changes data is the one already reviewed.
 *
 *   node scripts/seed-property-layouts.mjs            # plan only
 *   node scripts/seed-property-layouts.mjs --apply    # write
 */
import { NON_ROOM_SOURCES, STANDARD_PROPERTY_LAYOUT } from '@texasrenters/shared';

import { ownerPrismaClient } from './owner-prisma.mjs';
import { seedStandardLayout } from './standard-layout-seed.mjs';

const APPLY = process.argv.includes('--apply');
// The owner connection, not DATABASE_URL. The application role is subject to
// the tenant-isolation policies, so this script would see zero rows and report
// "nothing to do" — which is indistinguishable from genuinely being finished.
const prisma = ownerPrismaClient();

async function main() {
  /**
   * Every property that already has a room, read as its own query.
   *
   * `PropertyArea.propertyId` carries a building id but keys to `Property`, a
   * separate lazily-populated table, so `PropertywareBuilding` has no relation
   * to walk and no `areas: { none: … }` to filter on. The set comes back first
   * and excludes the buildings by id.
   *
   * `source: { notIn: NON_ROOM_SOURCES }` is what makes this about *rooms*
   * rather than areas. `hvacSystemArea` attaches one synthetic approved area —
   * "HVAC System", `source: SYSTEM` — the first time an HVAC visit is
   * scheduled, and it never goes away; a property carrying only that has no
   * layout in every sense that matters here.
   *
   * Unit-level rooms count too, hence no `unitId` filter: this seeds at the
   * building, and the creation path prefers a unit's own layout over the
   * building's, so a property whose rooms are recorded on its unit already has
   * an answer and must not be given a second one.
   */
  const laidOut = await prisma.propertyArea.findMany({
    where: { status: 'APPROVED', archivedAt: null, source: { notIn: NON_ROOM_SOURCES } },
    distinct: ['propertyId'],
    select: { propertyId: true },
  });

  const properties = await prisma.propertywareBuilding.findMany({
    where: {
      // Inactive properties are left alone: they are not going to be
      // inspected, and a guess on a record nobody will correct is just wrong
      // data with nobody to notice.
      isActive: true,
      id: { notIn: laidOut.map((area) => area.propertyId) },
    },
    select: { id: true, name: true, addressLine1: true, city: true },
    orderBy: [{ city: 'asc' }, { addressLine1: 'asc' }],
  });

  console.log(
    `${properties.length} active propert${properties.length === 1 ? 'y has' : 'ies have'} no room recorded; ` +
      `each would be given the ${STANDARD_PROPERTY_LAYOUT.length}-area standard layout.`,
  );
  if (!properties.length) return;

  let seeded = 0;
  let areasWritten = 0;
  for (const property of properties) {
    const where = `${property.addressLine1 ?? property.name}, ${property.city ?? ''}`.trim();
    if (!APPLY) {
      console.log(`  would seed  ${property.id}  ${where}`);
      seeded += 1;
      continue;
    }
    // Building level, `unitId: null`. A unit with no layout of its own falls
    // back to the building's, so this reaches the four units as well.
    const areas = await seedStandardLayout(prisma, property.id, null);
    console.log(`  seeded ${String(areas.length).padStart(2)} area(s)  ${property.id}  ${where}`);
    seeded += 1;
    areasWritten += areas.length;
  }

  console.log(
    `\n${APPLY ? 'Applied' : 'Dry run'}: ${seeded} propert${seeded === 1 ? 'y' : 'ies'}` +
      (APPLY ? `, ${areasWritten} area(s) now approved.` : ' would be seeded.'),
  );
  if (!APPLY) console.log('Re-run with --apply to write.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
