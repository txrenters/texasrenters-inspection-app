import type { RevenueClearedCell } from '@texasrenters/shared';
import type { Prisma } from '@prisma/client';

/**
 * The Actual vs Budget cells a save cleared by mistake, found in the database's
 * own history and put back (2026-11-17, the office: "fix it from the history
 * ... we can use the database history for this one").
 *
 * From v2.5.242 until v2.5.248, saving one cell cleared every other typed cell
 * of its log row, day or week (#579); and until v2.5.248 an empty cell read
 * from Excel cleared the console's (#580). Every save is on the audit record
 * with each cell's value before and after:
 *  - REVENUE_LOG_EDITED / _DAY_EDITED / _WEEK_EDITED: a save that set one cell
 *    and emptied others -- the emptied ones are the bug's. One that emptied
 *    every cell it touched is listed too, marked: which one was meant cannot be
 *    told.
 *  - REVENUE_EXCEL_EDITS_TAKEN: a cell emptied from Excel, listed, marked.
 * A cell typed again since, or holding a value now, is not listed: there is
 * nothing to put back.
 */

/** The technician log v2.5.242 shipped went live 2026-11-16 20:51Z: no save it could clear is older. */
export const CLEARED_SINCE = new Date('2026-11-16T20:00:00.000Z');

const INTS = new Set(['estimatedBudgetCents', 'laborCents', 'serviceCallFeeCents', 'materialsCents', 'budgetCents', 'workSeconds', 'targetCents', 'actualCents']);
const BOOLEANS = new Set(['workComplete', 'rescheduleRequired']);
const LOG_FIELDS = new Set([
  'address', 'workOrder', 'jobNumber', 'driveTime', 'timeBudgeted', 'estimatedBudgetCents', 'arrival', 'leaving', 'workComplete', 'rescheduleRequired',
  'rescheduleOn', 'laborCents', 'serviceCallFeeCents', 'materialsCents', 'invoiceNumber', 'postedInPw', 'notes',
]);
const DAY_FIELDS = new Set(['budgetCents', 'workSeconds', 'projectionRemarks', 'dailyRemarks', 'trackerRemarks']);
const WEEK_FIELDS = new Set(['targetCents', 'actualCents', 'remarks']);

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

/** Where a cell lives: a log entry, a technician's day, or a technician's week. */
type Place = { kind: 'log'; entryId: string } | { kind: 'logVisit'; inspectionId: string } | { kind: 'day' | 'week'; technicianId: string; day: string };

interface Change {
  field: string;
  from: string;
  to: string;
}

interface Found {
  id: string;
  at: Date;
  actorUserId: string | null;
  place: Place;
  field: string;
  lost: string;
  meant: string | null;
  fromExcel: boolean;
}

/** An Excel read's cell key ("day|<technician>|<date>", "log|visit|<visit>|…", "log|entry|<entry>") as a place. */
function placeOfKey(key: string): Place | null {
  const [kind, a, b, c] = key.split('|');
  if (kind === 'day' && a && b) return { kind: 'day', technicianId: a, day: b };
  if (kind === 'week' && a && b) return { kind: 'week', technicianId: a, day: b };
  if (kind === 'log' && a === 'visit' && b) return { kind: 'logVisit', inspectionId: b };
  if (kind === 'log' && a === 'entry' && b) return { kind: 'log', entryId: b };
  void c;
  return null;
}

const placeKey = (place: Place) =>
  place.kind === 'log' ? `log:${place.entryId}` : place.kind === 'logVisit' ? `visit:${place.inspectionId}` : `${place.kind}:${place.technicianId}:${place.day}`;

/** The cleared cells still empty now, newest first. */
export async function findClearedCells(db: Prisma.TransactionClient, organizationId: string): Promise<{ found: Found[]; cells: RevenueClearedCell[] }> {
  const events = await db.auditLog.findMany({
    where: {
      organizationId,
      createdAt: { gte: CLEARED_SINCE },
      action: { in: ['REVENUE_LOG_EDITED', 'REVENUE_DAY_EDITED', 'REVENUE_WEEK_EDITED', 'REVENUE_EXCEL_EDITS_TAKEN', 'REVENUE_CELLS_RESTORED'] },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, action: true, entityId: true, actorUserId: true, createdAt: true, metadata: true },
  });

  // Each event's cells, as place + field: what it set them to.
  const touched: { at: Date; key: string; to: string }[] = [];
  const found: Found[] = [];
  for (const event of events) {
    const metadata = (event.metadata ?? {}) as { changes?: Change[]; edits?: (Change & { key: string })[]; cells?: { place: string; field: string; to: string }[] };
    if (event.action === 'REVENUE_CELLS_RESTORED') {
      for (const cell of metadata.cells ?? []) touched.push({ at: event.createdAt, key: `${cell.place}|${cell.field}`, to: cell.to });
      continue;
    }
    if (event.action === 'REVENUE_EXCEL_EDITS_TAKEN') {
      for (const edit of metadata.edits ?? []) {
        const place = placeOfKey(edit.key);
        if (!place) continue;
        touched.push({ at: event.createdAt, key: `${placeKey(place)}|${edit.field}`, to: edit.to });
        if (edit.to.trim() === '' && edit.from.trim() !== '')
          found.push({ id: `${event.id}:${edit.key}:${edit.field}`, at: event.createdAt, actorUserId: null, place, field: edit.field, lost: edit.from, meant: null, fromExcel: true });
      }
      continue;
    }
    const place: Place | null =
      event.action === 'REVENUE_LOG_EDITED'
        ? { kind: 'log', entryId: event.entityId }
        : (() => {
            const [technicianId, day] = event.entityId.split(':');
            return technicianId && day ? { kind: event.action === 'REVENUE_DAY_EDITED' ? 'day' : 'week', technicianId, day } : null;
          })();
    if (!place) continue;
    const changes = metadata.changes ?? [];
    for (const change of changes) touched.push({ at: event.createdAt, key: `${placeKey(place)}|${change.field}`, to: change.to });
    if (changes.length < 2) continue;
    const meant = changes.filter((change) => change.to !== '');
    for (const change of changes)
      if (change.to === '' && change.from !== '')
        found.push({
          id: `${event.id}:${change.field}`,
          at: event.createdAt,
          actorUserId: event.actorUserId,
          place,
          field: change.field,
          lost: change.from,
          meant: meant.map((other) => `${other.field} = ${other.to}`).join(', ') || null,
          fromExcel: false,
        });
  }

  // A visit's row is one entry, whichever way it was named.
  const visitIds = [...new Set(found.flatMap((cell) => (cell.place.kind === 'logVisit' ? [cell.place.inspectionId] : [])))];
  const entryIds = [...new Set(found.flatMap((cell) => (cell.place.kind === 'log' ? [cell.place.entryId] : [])))];
  const entries = await db.revenueLogEntry.findMany({
    where: { organizationId, OR: [{ id: { in: entryIds } }, { inspectionId: { in: visitIds } }] },
    include: {
      technician: { select: { displayName: true } },
      inspection: { select: { jobberJobNumber: true, propertywareBuilding: { select: { addressLine1: true } }, property: { select: { addressLine1: true } } } },
    },
  });
  const entryOf = (place: Place) => entries.find((entry) => (place.kind === 'log' ? entry.id === place.entryId : place.kind === 'logVisit' && entry.inspectionId === place.inspectionId));
  // Typed again since (or put back): nothing to do. Counted by entry for a log row, so its two names are one.
  const lastTo = (cell: Found) => {
    const entry = entryOf(cell.place);
    const keys = new Set([`${placeKey(cell.place)}|${cell.field}`]);
    if (entry) {
      keys.add(`log:${entry.id}|${cell.field}`);
      if (entry.inspectionId) keys.add(`visit:${entry.inspectionId}|${cell.field}`);
    }
    return touched.filter((touch) => touch.at > cell.at && keys.has(touch.key)).at(-1);
  };

  const days = found.filter((cell) => cell.place.kind === 'day') as (Found & { place: { kind: 'day'; technicianId: string; day: string } })[];
  const weeks = found.filter((cell) => cell.place.kind === 'week') as (Found & { place: { kind: 'week'; technicianId: string; day: string } })[];
  const [dayRows, weekRows, people] = await Promise.all([
    days.length
      ? db.revenueDayEntry.findMany({ where: { organizationId, OR: days.map((cell) => ({ technicianId: cell.place.technicianId, day: new Date(`${cell.place.day}T00:00:00.000Z`) })) } })
      : [],
    weeks.length
      ? db.revenueWeekEntry.findMany({ where: { organizationId, OR: weeks.map((cell) => ({ technicianId: cell.place.technicianId, weekStart: new Date(`${cell.place.day}T00:00:00.000Z`) })) } })
      : [],
    db.userProfile.findMany({
      where: { id: { in: [...new Set([...found.map((cell) => cell.actorUserId), ...found.flatMap((cell) => (cell.place.kind === 'day' || cell.place.kind === 'week' ? [cell.place.technicianId] : []))].filter((id): id is string => Boolean(id)))] } },
      select: { id: true, displayName: true },
    }),
  ]);
  const nameOf = new Map(people.map((person) => [person.id, person.displayName]));

  const cells: RevenueClearedCell[] = [];
  const kept: Found[] = [];
  const seen = new Set<string>();
  for (const cell of [...found].reverse()) {
    if (lastTo(cell)) continue;
    let now: unknown;
    let where: string;
    if (cell.place.kind === 'log' || cell.place.kind === 'logVisit') {
      const entry = entryOf(cell.place);
      if (!entry || !LOG_FIELDS.has(cell.field)) continue;
      now = (entry as Record<string, unknown>)[cell.field];
      const address = entry.address ?? entry.inspection?.propertywareBuilding?.addressLine1 ?? entry.inspection?.property?.addressLine1 ?? 'a row of the office’s own';
      where = `${entry.technician.displayName} · ${dayOf(entry.day)} · ${address}${entry.inspection?.jobberJobNumber ? ` · job ${entry.inspection.jobberJobNumber}` : ''}`;
      // One cell, once: the newest clearing of it is the one listed.
      const same = `log:${entry.id}|${cell.field}`;
      if (seen.has(same)) continue;
      seen.add(same);
    } else {
      const { technicianId, day } = cell.place;
      const fields = cell.place.kind === 'day' ? DAY_FIELDS : WEEK_FIELDS;
      if (!fields.has(cell.field)) continue;
      const row = (cell.place.kind === 'day' ? dayRows : weekRows).find(
        (candidate) => candidate.technicianId === technicianId && dayOf('day' in candidate ? candidate.day : candidate.weekStart) === day,
      );
      now = row ? (row as Record<string, unknown>)[cell.field] : null;
      where = `${nameOf.get(technicianId) ?? 'A technician'} · ${cell.place.kind === 'day' ? day : `week of ${day}`}`;
      const same = `${placeKey(cell.place)}|${cell.field}`;
      if (seen.has(same)) continue;
      seen.add(same);
    }
    if (now !== null && now !== undefined && now !== '') continue;
    kept.push(cell);
    cells.push({
      id: cell.id,
      at: cell.at.toISOString(),
      by: cell.fromExcel ? 'Excel' : (nameOf.get(cell.actorUserId ?? '') ?? 'Someone'),
      where,
      field: cell.field,
      lost: cell.lost,
      saved: cell.meant,
      certain: !cell.fromExcel && cell.meant !== null,
    });
  }
  return { found: kept, cells };
}

/** A value as the audit record shows it ("7899", "true", "2026-11-17", text), as the column stores it. */
export function storedValue(field: string, shown: string): number | boolean | Date | string {
  if (INTS.has(field)) return Math.round(Number(shown));
  if (BOOLEANS.has(field)) return shown === 'true';
  if (field === 'rescheduleOn') return new Date(`${shown}T00:00:00.000Z`);
  return shown;
}

/** Put the chosen cells back, each only while it is still empty. Returns the cells put back, for the record. */
export async function restoreClearedCells(db: Prisma.TransactionClient, organizationId: string, ids: ReadonlySet<string>) {
  const { found } = await findClearedCells(db, organizationId);
  const restored: { place: string; field: string; to: string; technicianId: string | null; scope: 'log' | 'day' | 'week'; cellKey: string }[] = [];
  for (const cell of found) {
    if (!ids.has(cell.id)) continue;
    const value = storedValue(cell.field, cell.lost);
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    if (cell.place.kind === 'log' || cell.place.kind === 'logVisit') {
      const where = cell.place.kind === 'log' ? { id: cell.place.entryId, organizationId } : { inspectionId: cell.place.inspectionId, organizationId };
      const entry = await db.revenueLogEntry.findFirst({ where, select: { id: true, inspectionId: true, technicianId: true } });
      if (!entry) continue;
      const done = await db.revenueLogEntry.updateMany({ where: { id: entry.id, [cell.field]: null }, data: { [cell.field]: value } });
      if (done.count)
        restored.push({ place: `log:${entry.id}`, field: cell.field, to: cell.lost, technicianId: entry.technicianId, scope: 'log', cellKey: entry.inspectionId ?? entry.id });
      continue;
    }
    const { technicianId, day } = cell.place;
    const date = new Date(`${day}T00:00:00.000Z`);
    const done =
      cell.place.kind === 'day'
        ? await db.revenueDayEntry.updateMany({ where: { organizationId, technicianId, day: date, [cell.field]: null }, data: { [cell.field]: value } })
        : await db.revenueWeekEntry.updateMany({ where: { organizationId, technicianId, weekStart: date, [cell.field]: null }, data: { [cell.field]: value } });
    if (done.count) restored.push({ place: `${cell.place.kind}:${technicianId}:${day}`, field: cell.field, to: cell.lost, technicianId, scope: cell.place.kind, cellKey: day });
  }
  return restored;
}
