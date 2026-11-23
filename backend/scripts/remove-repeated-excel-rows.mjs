/**
 * Removes the office rows the Excel sync brought into the console again and
 * again (2026-11-20 to 11-22).
 *
 * A row the office typed in a technician's log tab for a day after tomorrow --
 * Monday's rows, typed on Friday -- was outside the days the sync compares, so
 * every run took it in as a new row of the office's own: Moses's 8 rows for
 * 11/23 became 1,203, and every technician's 11/23 had copies. Fixed in the
 * sync (the row now waits for its day); this removes the copies already made.
 *
 * A copy is a row of the office's own (no visit) that the sync made (a
 * REVENUE_EXCEL_ROWS_ADDED record within two seconds after it), that nobody
 * has changed since (no saver, nothing on the record), with another such row
 * on the same technician's same day for the same Job# (or street, without
 * one). Of each set:
 *  - when one of the technician's visits that day has that Job#, every copy
 *    goes: the visit's row is the office's row in Excel, holding what was
 *    typed there;
 *  - otherwise the oldest stays -- it is the one the sync found in the
 *    office's row, and it has taken every later edit -- and the rest go.
 *
 * The sync's next run (told to read every log tab) empties the rows it wrote at
 * the foot of each tab for the copies removed, where the office has not typed
 * in them -- contents only: the empty rows stay for the office to delete.
 *
 * Prints what it would remove; changes nothing without --apply.
 *
 *   node scripts/remove-repeated-excel-rows.mjs [--from 2026-11-20] [--apply]
 *
 * Inside the API container: `docker cp` this file and `owner-prisma.mjs` into
 * /app/backend/scripts and run it from /app/backend.
 */
/* global process, console */
import { ownerPrismaClient } from './owner-prisma.mjs';

const argument = (name) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const apply = process.argv.includes('--apply');
const from = argument('--from');
if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error('--from takes a day: 2026-11-20.');

/** The sync's own audit record follows the rows it made, in the same transaction: milliseconds later. */
const MADE_WITHIN_MS = 2_000;
const dayOf = (date) => date.toISOString().slice(0, 10);
const jobKey = (value) => (value ?? '').trim().replace(/^#/, '');
const street = (value) => (value ?? '').split(/\s+[-–]\s+/)[0].trim().toLowerCase().replace(/\s+/g, ' ');
const identity = (entry) => (jobKey(entry.jobNumber) ? `job ${jobKey(entry.jobNumber)}` : street(entry.address) ? `street ${street(entry.address)}` : null);

// Owner connection: cross-organization, and the application role is subject to the tenant-isolation policies.
const prisma = ownerPrismaClient();
let removedInAll = 0;
try {
  const syncs = await prisma.excelSync.findMany({ select: { organizationId: true, startDate: true } });
  for (const sync of syncs) {
    const organizationId = sync.organizationId;
    const firstDay = from ?? dayOf(sync.startDate);
    const adds = (
      await prisma.auditLog.findMany({ where: { organizationId, action: 'REVENUE_EXCEL_ROWS_ADDED' }, select: { createdAt: true } })
    ).map((audit) => audit.createdAt.getTime());
    const madeBySync = (entry) => adds.some((at) => at >= entry.createdAt.getTime() && at - entry.createdAt.getTime() <= MADE_WITHIN_MS);

    const entries = (
      await prisma.revenueLogEntry.findMany({
        where: { organizationId, inspectionId: null, updatedById: null, day: { gte: new Date(`${firstDay}T00:00:00.000Z`) } },
        select: { id: true, technicianId: true, day: true, address: true, jobNumber: true, createdAt: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    ).filter(madeBySync);
    if (!entries.length) continue;

    // Anything on the record for a row -- a save on the page, a cell put back -- makes it the office's: it stays.
    const touched = new Set(
      (
        await prisma.auditLog.findMany({
          where: { organizationId, entityType: 'RevenueLogEntry', entityId: { in: entries.map((entry) => entry.id) } },
          select: { entityId: true },
        })
      ).map((audit) => audit.entityId),
    );

    const sets = new Map();
    for (const entry of entries) {
      const name = identity(entry);
      if (!name || touched.has(entry.id)) continue;
      const key = `${entry.technicianId}|${dayOf(entry.day)}|${name}`;
      sets.set(key, [...(sets.get(key) ?? []), entry]);
    }
    const repeated = [...sets].filter(([, copies]) => copies.length > 1);
    if (!repeated.length) continue;

    // Each technician's visits on those days, by Job#.
    const days = [...new Set(repeated.map(([key]) => key.split('|')[1]))];
    const visits = await prisma.inspection.findMany({
      where: {
        organizationId,
        status: { not: 'CANCELLED' },
        scheduledAt: { in: days.map((day) => new Date(`${day}T00:00:00.000Z`)) },
        jobberJobNumber: { not: null },
      },
      select: { scheduledAt: true, jobberJobNumber: true, assignments: { where: { isCurrent: true }, select: { technicianId: true } } },
    });
    const visitJobs = new Set(
      visits.flatMap((visit) => visit.assignments.map((assignment) => `${assignment.technicianId}|${dayOf(visit.scheduledAt)}|job ${jobKey(visit.jobberJobNumber)}`)),
    );
    const names = new Map(
      (await prisma.userProfile.findMany({ where: { id: { in: [...new Set(repeated.map(([key]) => key.split('|')[0]))] } }, select: { id: true, displayName: true } })).map(
        (person) => [person.id, person.displayName],
      ),
    );

    const remove = [];
    const lines = [];
    for (const [key, copies] of repeated.sort(([left], [right]) => left.localeCompare(right))) {
      const [technicianId, day, name] = key.split('|');
      const visitHasIt = visitJobs.has(key);
      const going = visitHasIt ? copies : copies.slice(1);
      remove.push(...going.map((entry) => entry.id));
      lines.push({
        technician: names.get(technicianId) ?? technicianId,
        day,
        row: name,
        copies: copies.length,
        removing: going.length,
        keeps: visitHasIt ? "the visit's row" : 'the oldest',
      });
    }
    console.log(`Organization ${organizationId}: ${remove.length} copies to remove, from ${firstDay}.`);
    console.table(lines);
    if (!apply) continue;

    await prisma.$transaction(async (tx) => {
      const { count } = await tx.revenueLogEntry.deleteMany({ where: { organizationId, id: { in: remove }, inspectionId: null, updatedById: null } });
      if (count !== remove.length) throw new Error(`Expected to remove ${remove.length} rows, would remove ${count}: nothing removed.`);
      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: null,
          action: 'REVENUE_EXCEL_REPEATS_REMOVED',
          entityType: 'ExcelSync',
          entityId: organizationId,
          metadata: { from: firstDay, removed: count, sets: lines, ids: remove },
        },
      });
      // The next run reads every log tab, as after an edit in Excel -- nothing else would make it look at a tab whose
      // rows only went away -- and empties the rows it wrote there for the copies.
      await tx.excelSync.update({ where: { organizationId }, data: { fileTag: null, dirtyAt: new Date() } });
    });
    removedInAll += remove.length;
    console.log(`Removed ${remove.length}.`);
  }
  console.log(apply ? `Done: ${removedInAll} removed.` : 'Dry run: nothing changed. Run again with --apply to remove them.');
} finally {
  await prisma.$disconnect();
}
