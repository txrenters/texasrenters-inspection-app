/**
 * Lists the Actual vs Budget cells a one-cell save cleared (2026-11-17).
 *
 * From v2.5.242 until the fix (#579, v2.5.248), saving one cell on the
 * technician log, a daily sheet or the weekly report also cleared every other
 * typed cell of its row, day or week. Every save is on the audit record with
 * each field's value before and after, so a cleared cell is a change to ""
 * from a value, made by a save that also changed another cell.
 *
 * This only reads. It prints each cleared cell -- when, by whom, where, the
 * value it lost -- and whether it is still empty now (to restore) or has been
 * typed again since (nothing to do). With --json it also writes the cells to
 * restore to cleared-revenue-cells.json, for a person to check before anything
 * is put back.
 *
 *   node scripts/find-cleared-revenue-cells.mjs [--since 2026-11-16T20:00:00Z] [--json]
 *
 * Inside the API container: `docker cp` this file and `owner-prisma.mjs` into
 * /app/backend/scripts and run it from /app/backend.
 */
/* global process, console */
import { writeFileSync } from 'node:fs';

import { ownerPrismaClient } from './owner-prisma.mjs';

const argument = (name) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};
// v2.5.242 went live 2026-11-16 20:51Z: the technician log's first save could not be earlier.
const since = new Date(argument('--since') ?? '2026-11-16T20:00:00Z');
const asJson = process.argv.includes('--json');

// Owner connection: cross-organization, and the application role is subject to the tenant-isolation policies.
const prisma = ownerPrismaClient();

const events = await prisma.auditLog.findMany({
  where: { action: { in: ['REVENUE_LOG_EDITED', 'REVENUE_DAY_EDITED', 'REVENUE_WEEK_EDITED'] }, createdAt: { gte: since } },
  orderBy: { createdAt: 'asc' },
  select: { id: true, organizationId: true, action: true, entityId: true, actorUserId: true, createdAt: true, metadata: true },
});

const people = new Map(
  (await prisma.userProfile.findMany({ where: { id: { in: [...new Set(events.map((event) => event.actorUserId).filter(Boolean))] } }, select: { id: true, displayName: true } })).map(
    (person) => [person.id, person.displayName],
  ),
);

// The last value each cell was saved with, after the event that cleared it: typed again since means nothing to restore.
const lastSaved = new Map();
for (const event of events)
  for (const change of event.metadata?.changes ?? []) lastSaved.set(`${event.action}|${event.entityId}|${change.field}`, { at: event.createdAt, to: change.to });

const cleared = [];
for (const event of events) {
  const changes = event.metadata?.changes ?? [];
  if (changes.length < 2) continue;
  const emptied = changes.filter((change) => change.to === '' && change.from !== '');
  if (!emptied.length) continue;
  // The save meant one cell. When it set a value, every cell it emptied is the bug's; when it emptied every cell it
  // touched, which one the office meant cannot be told: each is listed, marked so.
  const meant = changes.filter((change) => change.to !== '');
  for (const change of emptied) {
    const later = lastSaved.get(`${event.action}|${event.entityId}|${change.field}`);
    cleared.push({
      at: event.createdAt.toISOString(),
      by: people.get(event.actorUserId) ?? event.actorUserId ?? 'unknown',
      action: event.action,
      entityId: event.entityId,
      organizationId: event.organizationId,
      field: change.field,
      lost: change.from,
      savedField: meant.map((other) => `${other.field}=${other.to}`).join(', ') || '(every cell it touched was emptied)',
      certain: meant.length > 0,
      typedAgainSince: later && later.at > event.createdAt ? later.to : null,
    });
  }
}

// Where each is, in words, and what the cell holds now.
const describe = async (cell) => {
  if (cell.action === 'REVENUE_LOG_EDITED') {
    const entry = await prisma.revenueLogEntry.findUnique({
      where: { id: cell.entityId },
      select: {
        day: true,
        address: true,
        technician: { select: { displayName: true } },
        inspection: { select: { jobberJobNumber: true, propertywareBuilding: { select: { addressLine1: true } }, property: { select: { addressLine1: true } } } },
        [cell.field]: true,
      },
    });
    if (!entry) return { where: `log row ${cell.entityId} (removed since)`, now: null };
    const address = entry.address ?? entry.inspection?.propertywareBuilding?.addressLine1 ?? entry.inspection?.property?.addressLine1 ?? '(no address)';
    const job = entry.inspection?.jobberJobNumber ? ` job ${entry.inspection.jobberJobNumber}` : '';
    const now = entry[cell.field];
    return { where: `${entry.technician.displayName}, ${entry.day.toISOString().slice(0, 10)}, ${address}${job}`, now: now instanceof Date ? now.toISOString().slice(0, 10) : now };
  }
  const [technicianId, when] = cell.entityId.split(':');
  const person = await prisma.userProfile.findUnique({ where: { id: technicianId }, select: { displayName: true } });
  const day = new Date(`${when}T00:00:00.000Z`);
  const row =
    cell.action === 'REVENUE_DAY_EDITED'
      ? await prisma.revenueDayEntry.findUnique({ where: { technicianId_day: { technicianId, day } }, select: { [cell.field]: true } })
      : await prisma.revenueWeekEntry.findUnique({ where: { technicianId_weekStart: { technicianId, weekStart: day } }, select: { [cell.field]: true } });
  return { where: `${person?.displayName ?? technicianId}, ${cell.action === 'REVENUE_DAY_EDITED' ? 'day' : 'week of'} ${when}`, now: row?.[cell.field] ?? null };
};

const toRestore = [];
for (const cell of cleared) {
  const { where, now } = await describe(cell);
  const still = now === null || now === undefined || now === '';
  const status = cell.typedAgainSince !== null ? `typed again since: "${cell.typedAgainSince}"` : still ? 'STILL EMPTY: restore' : `holds "${now}" now`;
  console.log(
    `${cell.at}  ${cell.by}\n  ${where}\n  ${cell.field}: lost "${cell.lost}"  (the save was ${cell.savedField}${cell.certain ? '' : '; not certain which cell was meant'})\n  ${status}\n`,
  );
  if (still && cell.typedAgainSince === null) toRestore.push({ ...cell, where });
}

console.log(`${cleared.length} cells cleared by a one-cell save since ${since.toISOString()}; ${toRestore.length} still empty.`);
if (asJson) {
  writeFileSync('cleared-revenue-cells.json', JSON.stringify(toRestore, null, 2));
  console.log('Written to cleared-revenue-cells.json: check it before anything is put back.');
}
await prisma.$disconnect();
