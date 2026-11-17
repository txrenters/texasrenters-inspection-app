import { CONSOLE_FILLED, type RevenueWorkbookImport } from '@texasrenters/shared';
import { InspectionStatus, type Prisma } from '@prisma/client';

import { technicianMatcher, type ImportedLogCells, type ImportedLogRow, type ImportedWorkbook } from './workbook-import';

/**
 * Writing what the office's workbook holds for its working technicians into
 * Actual vs Budget (2026-11-17, the office: "I want all the data imported
 * too", and for the days before the import "the workbook's" values win).
 *
 * Each row goes on its visit -- the technician's visit that day with the
 * row's Jobber job number -- or, with none, becomes a row of the office's own.
 * Every entry keeps what the import wrote, field by field (`importedFields`):
 * importing again replaces a cell only while it still holds what the last
 * import wrote, so what the office changed in the console since is kept. A
 * cell the workbook leaves blank leaves the console's value showing.
 */

type Values = Record<string, string | number | boolean | null>;

const LOG_FIELDS = [
  'address', 'workOrder', 'jobNumber', 'driveTime', 'timeBudgeted', 'estimatedBudgetCents', 'arrival', 'leaving', 'workComplete',
  'rescheduleRequired', 'rescheduleOn', 'laborCents', 'serviceCallFeeCents', 'materialsCents', 'invoiceNumber', 'postedInPw', 'notes',
] as const satisfies readonly (keyof ImportedLogCells)[];

/** The workbook's overtime key: the hourly rate a day's overtime adds, by the daily budget. */
const OT_RATE_BY_BUDGET: Record<number, number> = { 71000: 9900, 61000: 8500, 40000: 5600 };

const dateOf = (day: string) => new Date(`${day}T00:00:00.000Z`);
/** How far a visit may have moved from the day the workbook has it on and still be the row's. */
const MOVED_DAYS = 7;
const DAY_MS = 86_400_000;
const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const shown = (value: unknown) => (value instanceof Date ? dayOf(value) : (value ?? null)) as string | number | boolean | null;

/**
 * One entry's cells after an import: the workbook's value for every cell it
 * has, except where the office changed the cell in the console after the last
 * import; a cell the last import wrote and the workbook now leaves blank is
 * cleared. `current` is null for an entry not made yet. With `preferConsole`
 * (a log tab taken over, 2026-11-18) a cell the console already holds a value
 * in keeps it: the workbook only fills what the console leaves blank.
 */
export function mergeImported(current: Record<string, unknown> | null, previous: Values | null, incoming: Values, preferConsole = false) {
  const data: Values = {};
  const imported: Values = {};
  let kept = 0;
  const fields = new Set([...Object.keys(incoming), ...Object.keys(previous ?? {})]);
  for (const field of fields) {
    const value = incoming[field] ?? null;
    if (!current) {
      if (value !== null) data[field] = imported[field] = value;
      continue;
    }
    const now = shown(current[field]);
    const before = previous && field in previous ? previous[field]! : undefined;
    if (preferConsole && before === undefined && now !== null) {
      if (value !== null && value !== now) kept += 1;
      continue;
    }
    if (before !== undefined && now !== before) {
      // Changed in the console since the last import: the office's, and it stays so.
      imported[field] = before;
      if (value !== null && value !== now) kept += 1;
      continue;
    }
    if (value !== null) {
      if (value !== now) data[field] = value;
      imported[field] = value;
    } else if (before !== undefined && now !== null) data[field] = null;
  }
  return { data, imported, kept };
}

const asColumns = (values: Values) =>
  Object.fromEntries(Object.entries(values).map(([field, value]) => [field, field === 'rescheduleOn' && typeof value === 'string' ? dateOf(value) : value]));

/** Every field of an entry still holds what the import wrote, and nothing else was typed in it. */
function untouched(entry: Record<string, unknown>, imported: Values) {
  return LOG_FIELDS.every((field) => shown(entry[field]) === (imported[field] ?? null));
}

export async function importWorkingTechnicians(
  tx: Prisma.TransactionClient,
  organizationId: string,
  actorUserId: string | null,
  technicians: { id: string; name: string }[],
  found: ImportedWorkbook,
  /**
   * A log tab taken over (2026-11-18): only its rows' days are the import's,
   * so the office's rows an earlier import made on other days are left alone;
   * what the console already holds stands; and on a visit's row only what the
   * office types comes in -- the address, Job#, times and money are the
   * visit's, its timesheet's and its invoices' to fill.
   */
  options: { days?: { from: string; to: string }; preferConsole?: boolean } = {},
): Promise<RevenueWorkbookImport> {
  const match = technicianMatcher(technicians, found.logs.map((log) => log.tab));
  const unmatched = new Set<string>();
  const whose = (name: string) => {
    const technician = match(name);
    if (!technician) unmatched.add(name.trim());
    return technician;
  };
  const summary: RevenueWorkbookImport = { logs: [], budgets: [], days: 0, weeks: 0, months: 0, unmatched: [] };

  // ── Budgets: only for a technician with none ──────────────────────────────
  const budgetRows = await tx.revenueTechnicianSetting.findMany({ where: { organizationId }, select: { technicianId: true, dailyBudgetCents: true } });
  const budgetOf = new Map(budgetRows.map((row) => [row.technicianId, row.dailyBudgetCents]));
  for (const budget of found.budgets) {
    const technician = whose(budget.name);
    if (!technician || budgetOf.has(technician.id)) continue;
    const otRateCents = OT_RATE_BY_BUDGET[budget.dailyBudgetCents] ?? 0;
    await tx.revenueTechnicianSetting.create({
      data: { organizationId, technicianId: technician.id, dailyBudgetCents: budget.dailyBudgetCents, otRateCents, updatedById: actorUserId },
    });
    budgetOf.set(technician.id, budget.dailyBudgetCents);
    summary.budgets.push(technician.name);
  }

  // ── The logs ──────────────────────────────────────────────────────────────
  const tabs = found.logs.map((log) => ({ log, technician: whose(log.tab) }));
  const ids = [...new Set(tabs.flatMap(({ technician }) => (technician ? [technician.id] : [])))];
  const dates = tabs.flatMap(({ log }) => log.rows.map((row) => row.date)).sort();
  const visits = ids.length && dates.length
    ? await tx.inspection.findMany({
        where: {
          organizationId,
          status: { not: InspectionStatus.CANCELLED },
          scheduledAt: {
            gte: new Date(dateOf(dates[0]!).getTime() - MOVED_DAYS * DAY_MS),
            lte: new Date(dateOf(dates.at(-1)!).getTime() + MOVED_DAYS * DAY_MS),
          },
          jobberJobNumber: { not: null },
          assignments: { some: { isCurrent: true, technicianId: { in: ids } } },
        },
        select: { id: true, scheduledAt: true, jobberJobNumber: true, assignments: { where: { isCurrent: true }, select: { technicianId: true }, take: 1 } },
        orderBy: [{ scheduledAt: 'asc' }, { scheduledStartAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      })
    : [];
  const visitsAt = new Map<string, { id: string; scheduledAt: Date }[]>();
  const visitsOfJob = new Map<string, { id: string; scheduledAt: Date }[]>();
  for (const visit of visits) {
    const technicianId = visit.assignments[0]?.technicianId;
    if (!technicianId) continue;
    const job = `${technicianId}:${visit.jobberJobNumber!.trim()}`;
    const key = `${technicianId}:${dayOf(visit.scheduledAt)}:${visit.jobberJobNumber!.trim()}`;
    visitsAt.set(key, [...(visitsAt.get(key) ?? []), visit]);
    visitsOfJob.set(job, [...(visitsOfJob.get(job) ?? []), visit]);
  }
  // Each row's visit: first the technician's visit that day with the row's job, for every row; then, for a
  // row still without one, their one visit of that job within a week -- a visit moved in Jobber. A recurring
  // job has a visit every few days: with two near, none is guessed, and the row is the office's own.
  const used = new Set<string>();
  const visitOfRow = new Map<ImportedLogRow, { id: string; scheduledAt: Date }>();
  for (const { log, technician } of tabs) {
    if (!technician) continue;
    for (const row of log.rows) {
      const job = row.cells.jobNumber;
      const sameDay = job ? (visitsAt.get(`${technician.id}:${row.date}:${job}`) ?? []).find((candidate) => !used.has(candidate.id)) : undefined;
      if (!sameDay) continue;
      used.add(sameDay.id);
      visitOfRow.set(row, sameDay);
    }
  }
  for (const { log, technician } of tabs) {
    if (!technician) continue;
    for (const row of log.rows) {
      const job = row.cells.jobNumber;
      if (!job || visitOfRow.has(row)) continue;
      const near = (visitsOfJob.get(`${technician.id}:${job}`) ?? []).filter(
        (candidate) => Math.abs(candidate.scheduledAt.getTime() - dateOf(row.date).getTime()) <= MOVED_DAYS * DAY_MS,
      );
      if (near.length !== 1 || used.has(near[0]!.id)) continue;
      used.add(near[0]!.id);
      visitOfRow.set(row, near[0]!);
    }
  }
  const entries = ids.length
    ? await tx.revenueLogEntry.findMany({
        where: {
          organizationId,
          OR: [
            { inspectionId: { in: visits.map((visit) => visit.id) } },
            {
              inspectionId: null,
              technicianId: { in: ids },
              ...(options.days ? { day: { gte: dateOf(options.days.from), lte: dateOf(options.days.to) } } : {}),
            },
          ],
        },
      })
    : [];
  const entryOfVisit = new Map(entries.filter((entry) => entry.inspectionId).map((entry) => [entry.inspectionId!, entry]));

  // The office's own rows an earlier import made: gone unless changed since, and then kept as they are.
  const keptRowKeys = new Set<string>();
  const stale: string[] = [];
  for (const entry of entries) {
    if (entry.inspectionId || !entry.importedFields) continue;
    const imported = entry.importedFields as Values;
    if (untouched(entry, imported)) stale.push(entry.id);
    else keptRowKeys.add(`${entry.technicianId}:${dayOf(entry.day)}:${imported.jobNumber ?? ''}:${imported.address ?? ''}`);
  }
  if (stale.length) await tx.revenueLogEntry.deleteMany({ where: { id: { in: stale } } });

  const creates: Prisma.RevenueLogEntryCreateManyInput[] = [];
  for (const { log, technician } of tabs) {
    const counts = { tab: log.tab, technician: technician?.name ?? null, visits: 0, officeRows: 0, keptEdits: 0, skipped: log.undated + log.notPast };
    summary.logs.push(counts);
    if (!technician) continue;
    for (const row of log.rows) {
      const incoming = Object.fromEntries(LOG_FIELDS.map((field) => [field, row.cells[field]])) as Values;
      const visit = visitOfRow.get(row);
      if (visit) {
        counts.visits += 1;
        const entry = entryOfVisit.get(visit.id);
        const typed = options.preferConsole ? (Object.fromEntries(Object.entries(incoming).filter(([field]) => !(field in CONSOLE_FILLED))) as Values) : incoming;
        const { data, imported, kept } = mergeImported(entry ?? null, (entry?.importedFields as Values | null) ?? null, typed, options.preferConsole);
        counts.keptEdits += kept;
        if (!entry)
          creates.push({
            organizationId,
            technicianId: technician.id,
            inspectionId: visit.id,
            day: visit.scheduledAt,
            ...asColumns(data),
            importedFields: imported,
            updatedById: actorUserId,
          });
        else if (Object.keys(data).length || JSON.stringify(imported) !== JSON.stringify(entry.importedFields ?? {}))
          await tx.revenueLogEntry.update({ where: { id: entry.id }, data: { ...asColumns(data), importedFields: imported, updatedById: actorUserId } });
        continue;
      }
      if (keptRowKeys.has(`${technician.id}:${row.date}:${row.cells.jobNumber ?? ''}:${row.cells.address ?? ''}`)) {
        counts.keptEdits += 1;
        continue;
      }
      counts.officeRows += 1;
      const { data, imported } = mergeImported(null, null, incoming);
      creates.push({ organizationId, technicianId: technician.id, day: dateOf(row.date), ...asColumns(data), importedFields: imported, updatedById: actorUserId });
    }
  }
  if (creates.length) await tx.revenueLogEntry.createMany({ data: creates });

  // ── Days, weeks and months ────────────────────────────────────────────────
  const dayValues = new Map<string, { technicianId: string; date: string; values: Values }>();
  for (const cell of found.days) {
    const technician = whose(cell.name);
    if (!technician) continue;
    // A day's budget is typed only where it is not the technician's own.
    if (cell.field === 'budgetCents' && cell.value === budgetOf.get(technician.id)) continue;
    const key = `${technician.id}:${cell.date}`;
    const known = dayValues.get(key) ?? { technicianId: technician.id, date: cell.date, values: {} };
    known.values[cell.field] = cell.value;
    dayValues.set(key, known);
  }
  summary.days = await upsertImported(
    [...dayValues.values()],
    (keys) => tx.revenueDayEntry.findMany({ where: { organizationId, OR: keys.map(({ technicianId, date }) => ({ technicianId, day: dateOf(date) })) } }),
    (entry) => `${entry.technicianId}:${dayOf(entry.day as Date)}`,
    (item) => `${item.technicianId}:${item.date}`,
    (item, data, imported) =>
      tx.revenueDayEntry.upsert({
        where: { technicianId_day: { technicianId: item.technicianId, day: dateOf(item.date) } },
        create: { organizationId, technicianId: item.technicianId, day: dateOf(item.date), ...data, importedFields: imported, updatedById: actorUserId },
        update: { ...data, importedFields: imported, updatedById: actorUserId },
      }),
  );

  const weekValues = new Map<string, { technicianId: string; date: string; values: Values }>();
  for (const week of found.weeks) {
    const technician = whose(week.name);
    if (!technician) continue;
    const values: Values = {};
    if (week.targetCents !== null) values.targetCents = week.targetCents;
    if (week.actualCents !== null) values.actualCents = week.actualCents;
    if (week.remarks) values.remarks = week.remarks;
    weekValues.set(`${technician.id}:${week.weekStart}`, { technicianId: technician.id, date: week.weekStart, values });
  }
  summary.weeks = await upsertImported(
    [...weekValues.values()],
    (keys) => tx.revenueWeekEntry.findMany({ where: { organizationId, OR: keys.map(({ technicianId, date }) => ({ technicianId, weekStart: dateOf(date) })) } }),
    (entry) => `${entry.technicianId}:${dayOf(entry.weekStart as Date)}`,
    (item) => `${item.technicianId}:${item.date}`,
    (item, data, imported) =>
      tx.revenueWeekEntry.upsert({
        where: { technicianId_weekStart: { technicianId: item.technicianId, weekStart: dateOf(item.date) } },
        create: { organizationId, technicianId: item.technicianId, weekStart: dateOf(item.date), ...data, importedFields: imported, updatedById: actorUserId },
        update: { ...data, importedFields: imported, updatedById: actorUserId },
      }),
  );

  const monthValues = new Map<string, { technicianId: string; date: string; values: Values }>();
  for (const month of found.months) {
    const technician = whose(month.name);
    if (!technician || !month.remarks) continue;
    monthValues.set(`${technician.id}:${month.month}`, { technicianId: technician.id, date: `${month.month}-01`, values: { remarks: month.remarks } });
  }
  summary.months = await upsertImported(
    [...monthValues.values()],
    (keys) => tx.revenueMonthEntry.findMany({ where: { organizationId, OR: keys.map(({ technicianId, date }) => ({ technicianId, month: dateOf(date) })) } }),
    (entry) => `${entry.technicianId}:${dayOf(entry.month as Date)}`,
    (item) => `${item.technicianId}:${item.date}`,
    (item, data, imported) =>
      tx.revenueMonthEntry.upsert({
        where: { technicianId_month: { technicianId: item.technicianId, month: dateOf(item.date) } },
        create: { organizationId, technicianId: item.technicianId, month: dateOf(item.date), ...data, importedFields: imported, updatedById: actorUserId },
        update: { ...data, importedFields: imported, updatedById: actorUserId },
      }),
  );

  summary.unmatched = [...unmatched].sort();
  return summary;
}

/** Day, week and month entries: read the ones there, merge, and write those that change. Returns how many changed. */
async function upsertImported<Item extends { technicianId: string; date: string; values: Values }, Row extends { importedFields: Prisma.JsonValue }>(
  items: Item[],
  read: (keys: Item[]) => Promise<Row[]>,
  keyOfRow: (row: Row) => string,
  keyOfItem: (item: Item) => string,
  write: (item: Item, data: Values, imported: Values) => Promise<unknown>,
) {
  if (!items.length) return 0;
  const rows = new Map((await read(items)).map((row) => [keyOfRow(row), row]));
  let changed = 0;
  for (const item of items) {
    const row = rows.get(keyOfItem(item));
    const { data, imported } = mergeImported((row as Record<string, unknown> | undefined) ?? null, (row?.importedFields as Values | null) ?? null, item.values);
    if (!Object.keys(data).length && row && JSON.stringify(imported) === JSON.stringify(row.importedFields ?? {})) continue;
    if (!row && !Object.keys(data).length) continue;
    await write(item, data, imported);
    changed += 1;
  }
  return changed;
}
