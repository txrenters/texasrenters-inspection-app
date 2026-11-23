import { InspectionStatus, JobberVisitImportStatus, Prisma, UserRole } from '@prisma/client';

import { businessDate } from '../common/business-day';
import type { PrismaService } from '../common/prisma.service';
import { jobberVisitSchema } from '../integrations/jobber/jobber.schemas';

/**
 * A row the office typed for a job follows the job when Jobber moves it
 * (2026-11-23). The office types tomorrow's rows into each technician's tab --
 * on Friday, Monday's -- for the jobs Jobber has on them then. When Jobber
 * moves a job to another technician or day afterwards, the row stayed where it
 * was typed: Amy's Monday had three of Moses's jobs, which Jobber had put on her
 * for 23 minutes on Friday afternoon, and one of his for Tuesday. Her day counted
 * nine visits where Jobber had five, and those jobs were budgeted twice.
 *
 * After each run of the Jobber sync, a row of the office's own for a day still
 * to come whose Job# Jobber has somewhere else -- one visit of that job, one
 * technician of the console's -- goes there:
 *
 *  - when that visit is an inspection on the log, the row's planned cells fill the
 *    inspection's row where it has none of its own (the row is that visit, typed
 *    on the wrong tab or day), and the row goes;
 *  - when it is not -- a repair, a cleaning, a pick-up -- the row moves to that
 *    technician and day, or fills the row the office already has for the job
 *    there, and goes.
 *
 * It stays where it is when:
 *  - its day is today or gone by: that is the day's record, whether or not the
 *    office has typed how it went yet (2026-11-23: a repair worked on four days
 *    had a row for each, and Jobber had moved its one visit along to the last --
 *    following it would have folded the days worked into that one);
 *  - Jobber has the job there (any day of a visit that runs over several days);
 *  - it records what happened that day -- arrival, leaving, complete or not, a
 *    reschedule, money, an invoice, posted in PW: that is the day's history, not
 *    a plan;
 *  - the office changed it in the last {@link QUIET_MS} minutes: they may be
 *    moving the job in Jobber next;
 *  - Jobber has the job on several visits, on a visit with no technician of the
 *    console's or with two, or on a visit the office ruled out in the import queue
 *    (the sync never reads those again, so where Jobber has it is not known) --
 *    there is no telling which one the row is.
 *
 * Nothing typed is lost: a cell already filled where the row goes keeps its own
 * value, and the row as it was is in the audit record. The Excel sync then reads
 * every tab again: the row is emptied where it was (when nobody has typed in it
 * since) and written where it went.
 *
 * Reads the console's own copies only: no call to Jobber, Excel or anything billed.
 */

/** A row changed this recently is left for now: the office may be moving the job in Jobber next. */
export const QUIET_MS = 15 * 60_000;
/** A visit longer than this is a booking error, not days of work: only its first day counts. */
const LONGEST_VISIT_DAYS = 14;

/** Cells that say what happened that day: a row holding any is the day's record and stays. */
export const OUTCOME_FIELDS = [
  'arrival',
  'leaving',
  'workComplete',
  'rescheduleRequired',
  'rescheduleOn',
  'laborCents',
  'serviceCallFeeCents',
  'materialsCents',
  'invoiceNumber',
  'postedInPw',
] as const;
/** Cells the office plans a job with: what follows it. */
export const PLANNED_FIELDS = ['workOrder', 'driveTime', 'timeBudgeted', 'estimatedBudgetCents', 'notes'] as const;
type Planned = (typeof PLANNED_FIELDS)[number];
type Cells = Partial<Record<Planned | (typeof OUTCOME_FIELDS)[number], unknown>>;

export interface FollowRow {
  id: string;
  technicianId: string;
  /** "2026-11-23" */
  day: string;
  jobNumber: string | null;
  updatedAt: Date;
  cells: Cells;
}

export interface FollowVisit {
  jobberVisitId: string;
  jobNumber: string;
  /** Every Texas day the visit runs over, first to last. */
  days: string[];
  /** The console's technicians among Jobber's assignees. */
  technicianIds: string[];
  /** The inspection the visit is on the log as, where it is one. */
  inspection: { id: string; day: string; technicianId: string | null; entryId: string | null; cells: Cells } | null;
}

export type FollowAction =
  | { kind: 'move'; row: FollowRow; technicianId: string; day: string }
  | {
      kind: 'fold';
      row: FollowRow;
      /** The row it goes into: an office row, or an inspection's (null: the inspection has no row of typed cells yet). */
      into: { entryId: string | null; inspectionId: string | null; technicianId: string; day: string };
      fill: Partial<Record<Planned, unknown>>;
    };

export type LeftWhy = 'HAS_OUTCOME' | 'JUST_CHANGED' | 'SEVERAL_VISITS' | 'NOT_ONE_TECHNICIAN' | 'RULED_OUT_IN_JOBBER';

export const jobKey = (value: string | number | null | undefined) => String(value ?? '').trim().replace(/^#/, '');
const filled = (value: unknown) => value !== null && value !== undefined && value !== '';

/** The planned cells the row has and the row it goes into does not. */
const fillOf = (from: Cells, into: Cells) =>
  Object.fromEntries(PLANNED_FIELDS.flatMap((field) => (filled(from[field]) && !filled(into[field]) ? [[field, from[field]]] : [])));

/** Where the rows of the office's own go. Pure. */
export function planFollowJobber(input: {
  rows: FollowRow[];
  visits: FollowVisit[];
  /** Jobs with a visit the office ruled out in Jobber's import queue: where Jobber has them is not known. */
  ruledOut?: ReadonlySet<string>;
  now: Date;
}): { actions: FollowAction[]; left: { row: FollowRow; why: LeftWhy }[] } {
  const actions: FollowAction[] = [];
  const left: { row: FollowRow; why: LeftWhy }[] = [];
  const visitsOf = new Map<string, FollowVisit[]>();
  for (const visit of input.visits) visitsOf.set(visit.jobNumber, [...(visitsOf.get(visit.jobNumber) ?? []), visit]);

  // The office's row for a job at each place, as the plan leaves it: a second row going there fills the first.
  const at = new Map<string, { id: string; day: string; cells: Cells }>();
  const place = (technicianId: string, day: string, job: string) => `${technicianId}|${day}|${job}`;
  const ordered = [...input.rows].sort((left, right) => left.day.localeCompare(right.day) || left.id.localeCompare(right.id));
  for (const row of ordered) {
    const job = jobKey(row.jobNumber);
    const here = place(row.technicianId, row.day, job);
    if (job && !at.has(here)) at.set(here, { id: row.id, day: row.day, cells: { ...row.cells } });
  }
  // What each inspection's row holds, as the plan leaves it.
  const inspectionCells = new Map<string, Cells>();

  for (const row of ordered) {
    const job = jobKey(row.jobNumber);
    const visits = job ? (visitsOf.get(job) ?? []) : [];
    // Jobber does not have the job in its window: nothing to follow.
    if (!visits.length) continue;
    // Jobber has it where the row is.
    if (visits.some((visit) => visit.days.includes(row.day) && visit.technicianIds.includes(row.technicianId))) continue;

    const why: LeftWhy | null = OUTCOME_FIELDS.some((field) => filled(row.cells[field]))
      ? 'HAS_OUTCOME'
      : input.now.getTime() - row.updatedAt.getTime() < QUIET_MS
        ? 'JUST_CHANGED'
        : input.ruledOut?.has(job)
          ? 'RULED_OUT_IN_JOBBER'
          : visits.length > 1
            ? 'SEVERAL_VISITS'
            : null;
    if (why) {
      left.push({ row, why });
      continue;
    }
    const visit = visits[0]!;
    const inspection = visit.inspection;
    if (inspection && visit.days.includes(inspection.day)) {
      // On the log as the inspection's row: the row is that visit.
      if (!inspection.technicianId) {
        left.push({ row, why: 'NOT_ONE_TECHNICIAN' });
        continue;
      }
      const holds = inspectionCells.get(inspection.id) ?? inspection.cells;
      const fill = fillOf(row.cells, holds);
      actions.push({
        kind: 'fold',
        row,
        into: { entryId: inspection.entryId, inspectionId: inspection.id, technicianId: inspection.technicianId, day: inspection.day },
        fill,
      });
      // A second row for the same visit fills only what this one left empty.
      inspectionCells.set(inspection.id, { ...holds, ...fill });
      continue;
    }
    if (visit.technicianIds.length !== 1) {
      left.push({ row, why: 'NOT_ONE_TECHNICIAN' });
      continue;
    }
    const technicianId = visit.technicianIds[0]!;
    // The office's row for the job already there -- on any of the visit's days -- takes it; else to its first day.
    const there = visit.days.map((day) => at.get(place(technicianId, day, job))).find((found) => found && found.id !== row.id);
    if (there) {
      const fill = fillOf(row.cells, there.cells);
      actions.push({ kind: 'fold', row, into: { entryId: there.id, inspectionId: null, technicianId, day: there.day }, fill });
      there.cells = { ...there.cells, ...fill };
      continue;
    }
    actions.push({ kind: 'move', row, technicianId, day: visit.days[0]! });
    const here = place(row.technicianId, row.day, job);
    if (at.get(here)?.id === row.id) at.delete(here);
    at.set(place(technicianId, visit.days[0]!, job), { id: row.id, day: visit.days[0]!, cells: { ...row.cells } });
  }
  return { actions, left };
}

/** Every Texas day from a visit's start to its end. */
export function visitDays(startAt: string, endAt: string | null | undefined): string[] {
  const first = businessDate(new Date(startAt));
  const last = endAt ? businessDate(new Date(endAt)) : first;
  const days = [first];
  for (let day = first; day < last && days.length < LONGEST_VISIT_DAYS; ) {
    day = new Date(Date.parse(`${day}T12:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
    days.push(day);
  }
  return last > days[days.length - 1]! ? [first] : days;
}

const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const ROW_SELECT = {
  id: true,
  technicianId: true,
  day: true,
  jobNumber: true,
  updatedAt: true,
  workOrder: true,
  driveTime: true,
  timeBudgeted: true,
  estimatedBudgetCents: true,
  notes: true,
  arrival: true,
  leaving: true,
  workComplete: true,
  rescheduleRequired: true,
  rescheduleOn: true,
  laborCents: true,
  serviceCallFeeCents: true,
  materialsCents: true,
  invoiceNumber: true,
  postedInPw: true,
} as const;
type Selected = Prisma.RevenueLogEntryGetPayload<{ select: typeof ROW_SELECT }>;
const cellsOf = (entry: Selected | null | undefined): Cells =>
  entry ? Object.fromEntries([...PLANNED_FIELDS, ...OUTCOME_FIELDS].map((field) => [field, entry[field]])) : {};

/**
 * After a full run of the Jobber sync: the office's rows from tomorrow to `to`
 * (the last day the run read) whose job Jobber has somewhere else go there.
 * `since` is when that run started: a stored visit it did not read again is
 * one Jobber no longer has.
 */
export async function followJobber(
  prisma: PrismaService,
  organizationId: string,
  window: { since: Date; to: string },
  now = new Date(),
): Promise<{ moved: number; folded: number; left: number; failed: number }> {
  // Today's rows and those of days gone by are the days' record: never moved.
  const tomorrow = new Date(Date.parse(`${businessDate(now)}T00:00:00.000Z`) + 86_400_000);
  const entries = await prisma.revenueLogEntry.findMany({
    where: {
      organizationId,
      inspectionId: null,
      jobNumber: { not: null },
      day: { gte: tomorrow, lte: new Date(`${window.to}T00:00:00.000Z`) },
    },
    select: ROW_SELECT,
  });
  const rows: FollowRow[] = entries.flatMap((entry) =>
    jobKey(entry.jobNumber) ? [{ id: entry.id, technicianId: entry.technicianId, day: dayOf(entry.day), jobNumber: entry.jobNumber, updatedAt: entry.updatedAt, cells: cellsOf(entry) }] : [],
  );
  if (!rows.length) return { moved: 0, folded: 0, left: 0, failed: 0 };
  const jobs = [...new Set(rows.map((row) => jobKey(row.jobNumber)))];

  // Every stored visit of those jobs; the ones the run read are where Jobber has the job now.
  const stored = await prisma.$queryRaw<{ jobberVisitId: string; status: string; inspectionId: string | null; lastAttemptAt: Date | null; payload: unknown }[]>`
    SELECT "jobberVisitId", status::text AS status, "inspectionId", "lastAttemptAt", payload
      FROM "JobberVisitImport"
     WHERE "organizationId" = ${organizationId}::uuid
       AND ltrim(trim(payload->'job'->>'jobNumber'), '#') IN (${Prisma.join(jobs)})
  `;
  const ruledOut = new Set<string>();
  const current: { jobberVisitId: string; inspectionId: string | null; jobNumber: string; days: string[]; emails: string[] }[] = [];
  for (const visit of stored) {
    const parsed = jobberVisitSchema.safeParse(visit.payload);
    if (!parsed.success) continue;
    const job = jobKey(parsed.data.job?.jobNumber);
    // Never read again once ruled out: where Jobber has it now is not known.
    if (visit.status === JobberVisitImportStatus.IGNORED) {
      ruledOut.add(job);
      continue;
    }
    if (!visit.lastAttemptAt || visit.lastAttemptAt < window.since || !parsed.data.startAt) continue;
    current.push({
      jobberVisitId: visit.jobberVisitId,
      inspectionId: visit.inspectionId,
      jobNumber: job,
      days: visitDays(parsed.data.startAt, parsed.data.endAt),
      emails: (parsed.data.assignedUsers?.nodes ?? []).flatMap((node) => (node.email?.raw ? [node.email.raw.trim().toLowerCase()] : [])),
    });
  }
  if (!current.length) return { moved: 0, folded: 0, left: 0, failed: 0 };

  // Jobber's assignees who are the console's technicians, by email -- as the sync assigns inspections.
  const emails = [...new Set(current.flatMap((visit) => visit.emails))];
  const technicians = emails.length
    ? await prisma.userProfile.findMany({
        where: { email: { in: emails, mode: 'insensitive' }, isActive: true, memberships: { some: { organizationId, role: UserRole.INSPECTION_TECHNICIAN } } },
        select: { id: true, email: true },
      })
    : [];
  const technicianOf = new Map(technicians.map((person) => [person.email.toLowerCase(), person.id]));

  const inspectionIds = [...new Set(current.flatMap((visit) => (visit.inspectionId ? [visit.inspectionId] : [])))];
  const [inspections, inspectionEntries] = inspectionIds.length
    ? await Promise.all([
        prisma.inspection.findMany({
          where: { organizationId, id: { in: inspectionIds }, status: { not: InspectionStatus.CANCELLED } },
          select: { id: true, scheduledAt: true, assignments: { where: { isCurrent: true }, select: { technicianId: true }, take: 1 } },
        }),
        prisma.revenueLogEntry.findMany({ where: { organizationId, inspectionId: { in: inspectionIds } }, select: { ...ROW_SELECT, inspectionId: true } }),
      ])
    : [[], []];
  const inspectionOf = new Map(inspections.map((inspection) => [inspection.id, inspection]));
  const entryOf = new Map(inspectionEntries.map((entry) => [entry.inspectionId!, entry]));

  const visits: FollowVisit[] = current.map((visit) => {
    const inspection = visit.inspectionId ? inspectionOf.get(visit.inspectionId) : undefined;
    const entry = inspection ? entryOf.get(inspection.id) : undefined;
    return {
      jobberVisitId: visit.jobberVisitId,
      jobNumber: visit.jobNumber,
      days: visit.days,
      technicianIds: [...new Set(visit.emails.flatMap((email) => (technicianOf.has(email) ? [technicianOf.get(email)!] : [])))],
      inspection: inspection
        ? { id: inspection.id, day: dayOf(inspection.scheduledAt), technicianId: inspection.assignments[0]?.technicianId ?? null, entryId: entry?.id ?? null, cells: cellsOf(entry) }
        : null,
    };
  });

  const { actions, left } = planFollowJobber({ rows, visits, ruledOut, now });
  let moved = 0;
  let folded = 0;
  let failed = 0;
  for (const action of actions) {
    // One at a time: a row the office changed meanwhile, or one that cannot go, does not stop the others.
    const done = await prisma.$transaction((tx) => apply(tx, organizationId, action)).catch(() => {
      failed += 1;
      return false;
    });
    if (!done) continue;
    if (action.kind === 'move') moved += 1;
    else folded += 1;
  }
  if (moved || folded)
    // The Excel sync reads every tab on its next run, as after an edit in Excel: nothing else makes it look at a tab
    // a row only went away from. It empties the row there and writes it where it went.
    await prisma.excelSync.updateMany({ where: { organizationId, enabled: true }, data: { fileTag: null, dirtyAt: now } });
  return { moved, folded, left: left.length, failed };
}

/** One row to where Jobber has its job. False when the row changed since it was read: the next run looks again. */
async function apply(tx: Prisma.TransactionClient, organizationId: string, action: FollowAction): Promise<boolean> {
  const { row } = action;
  const unchanged = { id: row.id, organizationId, inspectionId: null, updatedAt: row.updatedAt };
  const record = (data: Record<string, unknown>) =>
    tx.auditLog.create({
      data: {
        organizationId,
        actorUserId: null,
        action: 'REVENUE_LOG_ROW_FOLLOWED_JOBBER',
        entityType: 'RevenueLogEntry',
        entityId: row.id,
        metadata: { jobNumber: row.jobNumber, from: { technicianId: row.technicianId, day: row.day }, ...data } as Prisma.InputJsonValue,
      },
    });

  if (action.kind === 'move') {
    const { count } = await tx.revenueLogEntry.updateMany({
      where: unchanged,
      data: { technicianId: action.technicianId, day: new Date(`${action.day}T00:00:00.000Z`) },
    });
    if (count !== 1) return false;
    await record({ to: { technicianId: action.technicianId, day: action.day } });
    return true;
  }

  const { into } = action;
  // What the row it goes into holds now: a cell typed there meanwhile keeps its own value.
  const target = into.entryId
    ? await tx.revenueLogEntry.findFirst({ where: { id: into.entryId, organizationId }, select: ROW_SELECT })
    : into.inspectionId
      ? await tx.revenueLogEntry.findFirst({ where: { inspectionId: into.inspectionId, organizationId }, select: ROW_SELECT })
      : null;
  if (into.entryId && !target) return false;
  const fill = fillOf(action.fill as Cells, cellsOf(target));
  const gone = await tx.revenueLogEntry.findFirst({ where: unchanged, select: ROW_SELECT });
  if (!gone) return false;
  await tx.revenueLogEntry.delete({ where: { id: row.id } });
  let intoId = target?.id ?? null;
  if (Object.keys(fill).length) {
    if (target) await tx.revenueLogEntry.update({ where: { id: target.id }, data: fill });
    else
      intoId = (
        await tx.revenueLogEntry.create({
          data: { organizationId, technicianId: into.technicianId, inspectionId: into.inspectionId, day: new Date(`${into.day}T00:00:00.000Z`), ...fill },
          select: { id: true },
        })
      ).id;
    await tx.auditLog.create({
      data: {
        organizationId,
        actorUserId: null,
        action: target ? 'REVENUE_LOG_EDITED' : 'REVENUE_LOG_ROW_ADDED',
        entityType: 'RevenueLogEntry',
        entityId: intoId!,
        metadata: {
          changes: Object.entries(fill).map(([field, value]) => ({ field, from: '', to: String(value) })),
          followedFrom: row.id,
        } as Prisma.InputJsonValue,
      },
    });
  }
  await record({
    to: { technicianId: into.technicianId, day: into.day },
    into: { entryId: intoId, inspectionId: into.inspectionId },
    filled: Object.keys(fill),
    row: JSON.parse(JSON.stringify(gone)) as Prisma.InputJsonValue,
  });
  return true;
}
