/**
 * Removes the non-room areas that leaked into room-by-room inspections.
 *
 *   node scripts/remove-leaked-system-areas.mjs            # report only
 *   node scripts/remove-leaked-system-areas.mjs --apply    # delete them
 *
 * ── What leaked, and why a script rather than a migration ────────────────────
 *
 * An HVAC visit's subjects live on the property as ordinary approved areas —
 * "A/C unit", "AC filters", "Attic", "Filters", "Thermostat" — with
 * `source = 'SYSTEM'`. `layoutAreasFor` has always kept them out of an
 * inspection's scope, but until v2.5.111 only inspection *creation* applied
 * it, so the console's add-areas route let them onto occupied inspections.
 * They reached the technician's inspection screen next to the app's own AC
 * Filter Change screen, which is what the office reported.
 *
 * The code fix stops new ones. It cannot reach the inspections that already
 * have them: an inspection's area list is a snapshot taken when it was
 * created, and that is deliberate — see `inspection-areas-are-a-snapshot`.
 * Hence a script somebody runs deliberately, rather than a migration that
 * deletes rows from live inspections the moment a release lands.
 *
 * ── What it refuses to touch ─────────────────────────────────────────────────
 *
 * **A finalized inspection.** Its report is issued and may already have been
 * charged against a deposit; `finalizedAt` freezes the evidence and nothing
 * here is worth rewriting a settled record for. 5 of the 6 leaked "AC filters"
 * rows found in production were on finalized inspections, and they stay.
 *
 * **Anything with work recorded against it.** Six tables reference an
 * `InspectionArea`, and an earlier reading of this checked only one of them —
 * which reported "nothing was ever photographed" while one area held a
 * photograph and two checklist answers. All six are checked here, by name, so
 * that mistake cannot be repeated quietly.
 *
 * **An HVAC or roof visit.** Those are what a SYSTEM area is *for*.
 */
import { ownerPrismaClient } from './owner-prisma.mjs';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');

/** The types that walk rooms. An HVAC or roof visit's subject IS a SYSTEM area. */
const ROOM_WALKS = ['OCCUPIED', 'MOVE_IN', 'MOVE_OUT', 'BACK_TO_MARKET'];

/**
 * Every table that points at an `InspectionArea`, and the word for what it
 * holds. Listed rather than discovered so that a new one added later fails
 * this script's own check below instead of silently widening what it deletes.
 */
const DEPENDENTS = [
  ['inspectionPhoto', 'a photograph'],
  ['inspectionMedia', 'a recording'],
  ['inspectionAreaChecklistResponse', 'a checklist answer'],
  ['areaEvidenceRequest', 'an evidence request'],
  ['mediaUploadSession', 'an upload'],
  ['inspectionAreaStatusHistory', 'a status change'],
];

async function main() {
  const prisma = ownerPrismaClient();
  try {
    const leaked = await prisma.inspectionArea.findMany({
      where: {
        propertyArea: { source: 'SYSTEM' },
        inspection: { inspectionType: { in: ROOM_WALKS } },
      },
      select: {
        id: true,
        inspectionId: true,
        propertyArea: { select: { name: true } },
        inspection: { select: { inspectionType: true, finalizedAt: true } },
      },
      orderBy: { id: 'asc' },
    });

    if (!leaked.length) {
      console.log('Nothing leaked: no SYSTEM area sits on a room-by-room inspection.');
      return;
    }

    const kept = [];
    let removable = [];
    for (const area of leaked) {
      if (area.inspection.finalizedAt) {
        kept.push({ area, because: 'the inspection is finalized' });
        continue;
      }
      // Sequential and per-area on purpose: the reason an area is kept is
      // reported, and a single combined count could not say which table held
      // the work or which area it belonged to.
      let holds = null;
      for (const [model, what] of DEPENDENTS) {
        const count = await prisma[model].count({ where: { inspectionAreaId: area.id } });
        if (count) {
          holds = `${what}${count > 1 ? ` (${count})` : ''}`;
          break;
        }
      }
      if (holds) kept.push({ area, because: `it holds ${holds}` });
      else removable.push(area);
    }

    /**
     * Never leave an inspection with no areas at all.
     *
     * One move-in in production has exactly one area and it is the leaked
     * one. Removing it would turn a scheduling success into an empty job --
     * a technician opening a visit with nothing to walk -- and for a move-in
     * it would also leave the move-out that will be compared against it with
     * counterparts that never resolve.
     *
     * A wrong area is a smaller problem than no area, so the inspection keeps
     * it and is reported instead. Whoever reads that line can give the visit a
     * real layout, which is a decision this script has no business making.
     */
    const totals = new Map();
    for (const row of await prisma.inspectionArea.groupBy({
      by: ['inspectionId'],
      where: { inspectionId: { in: [...new Set(removable.map((area) => area.inspectionId))] } },
      _count: { _all: true },
    }))
      totals.set(row.inspectionId, row._count._all);

    const wouldEmpty = new Set();
    for (const [inspectionId, total] of totals) {
      const removing = removable.filter((area) => area.inspectionId === inspectionId).length;
      if (removing >= total) wouldEmpty.add(inspectionId);
    }
    for (const area of removable.filter((row) => wouldEmpty.has(row.inspectionId)))
      kept.push({ area, because: 'it is the only area this inspection has' });
    removable = removable.filter((area) => !wouldEmpty.has(area.inspectionId));

    const byName = new Map();
    for (const area of removable) {
      const key = `${area.inspection.inspectionType} · ${area.propertyArea.name}`;
      byName.set(key, (byName.get(key) ?? 0) + 1);
    }
    console.log(`${leaked.length} SYSTEM areas sit on room-by-room inspections.`);
    console.log(`\n${removable.length} can be removed — nothing was ever recorded against them:`);
    for (const [key, count] of [...byName].sort()) console.log(`  ${count.toString().padStart(3)}  ${key}`);

    if (kept.length) {
      console.log(`\n${kept.length} are left alone:`);
      for (const { area, because } of kept)
        console.log(
          `  ${area.propertyArea.name} on ${area.inspectionId} — ${because}`,
        );
    }

    if (!apply) {
      console.log('\nReport only. Re-run with --apply to remove them.');
      return;
    }
    if (!removable.length) {
      console.log('\nNothing to remove.');
      return;
    }

    const { count } = await prisma.inspectionArea.deleteMany({
      where: { id: { in: removable.map((area) => area.id) } },
    });
    console.log(`\nRemoved ${count}.`);
    // Said rather than assumed. A mismatch means something wrote to one of
    // these areas between the read above and this delete, and whoever ran it
    // should know before they close the terminal.
    if (count !== removable.length)
      console.log(
        `Expected ${removable.length}. Re-run the report to see what changed underneath it.`,
      );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
