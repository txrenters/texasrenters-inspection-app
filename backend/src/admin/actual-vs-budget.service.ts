import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  CONSOLE_FILLED,
  revenueCell,
  type RevenueLiveScope,
  DEFAULT_PAYROLL_PERIOD,
  REGULAR_DAY_SECONDS,
  actualSeconds,
  monthEnd,
  monthWeeks,
  overtimeSeconds,
  payrollPeriodOf,
  trackerFigures,
  type RevenueBudgets,
  type RevenueDay,
  type RevenueDayTechnician,
  type RevenueHistoryImport,
  type RevenueHistoryList,
  type RevenueHistorySheetView,
  type RevenueMonthReport,
  type RevenueWeek,
  type RevenueWeekRow,
  type SaveRevenueMonthInput,
  type SaveRevenueWeekInput,
  type SaveRevenueBudgetsInput,
  type SaveRevenueDayInput,
  logRangeProblem,
  revenueLogTotals,
  type RevenueColumn,
  type RevenueLog,
  type RevenueLogCells,
  type RevenueLogDay,
  type RevenueLogField,
  type RevenueLogRow,
  type RevenueLogSource,
  type RevenueLogTechnicians,
  type RevenueProductColumns,
  type SaveRevenueLogEntryInput,
} from '@texasrenters/shared';
import { InspectionStatus, InvoiceStatus, TimeSegmentCategory, UserRole, type Prisma } from '@prisma/client';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { businessClockTime, businessDate, businessDayBounds, businessDayFromQuery } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { ActualVsBudgetGateway } from './actual-vs-budget.gateway';
import { readCompanies, shownInvoices } from './shown-invoices';
import { WorkbookError, readWorkbook, technicianLog, type WorkbookSheet } from './workbook-reader';

/** The workbook as uploaded: what the upload hands the service. */
export interface UploadedWorkbook {
  originalname: string;
  size: number;
  buffer: Buffer;
}

/** The office's workbook is 1.2 MB; this leaves room and no more. */
export const MAX_WORKBOOK_BYTES = 20_000_000;

/**
 * Actual vs Budget's technician log (2026-11-17, PR 1 of rebuilding the
 * office's "THMP Scheduling Actual Vs Budget 2026.xlsx" in the console): one
 * technician's visits, day by day, in the workbook's 19 columns.
 *
 * Every cell the console already knows is filled -- the visit's day, address
 * and Jobber job number, whether it was done, the timesheet's arrival and
 * leaving, and the visit's invoices -- and the office types the rest, or over
 * any of it. Read when the page opens or its days change, never on a poll, and
 * nothing here calls anything billed.
 */

/** A visit the technician has done or handed in counts as done ("Submitted = done"). */
const DONE: InspectionStatus[] = [
  InspectionStatus.TECHNICIAN_SUBMITTED,
  InspectionStatus.PROCESSING,
  InspectionStatus.REVIEW_REQUIRED,
  InspectionStatus.UNDER_REVIEW,
  InspectionStatus.COMPLETED,
];

const dateOf = (day: string) => new Date(`${day}T00:00:00.000Z`);
const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const nextDay = (day: string) => dayOf(new Date(dateOf(day).getTime() + 86_400_000));

/** What the office types for a technician's day on the daily sheets. */
const DAY_FIELDS = ['budgetCents', 'workSeconds', 'projectionRemarks', 'dailyRemarks', 'trackerRemarks'] as const satisfies readonly (keyof SaveRevenueDayInput)[];
const clock = (instant: Date) => businessClockTime(instant).slice(0, 5);

/** The entry's typed cells, by the contract's names. `date` is the entry's `day`. */
const TYPED_FIELDS = [
  'address',
  'workOrder',
  'jobNumber',
  'driveTime',
  'timeBudgeted',
  'estimatedBudgetCents',
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
  'notes',
] as const satisfies readonly Exclude<RevenueLogField, 'date'>[];
type TypedField = (typeof TYPED_FIELDS)[number];

const ENTRY_SELECT = {
  id: true,
  technicianId: true,
  inspectionId: true,
  day: true,
  createdAt: true,
  address: true,
  workOrder: true,
  jobNumber: true,
  driveTime: true,
  timeBudgeted: true,
  estimatedBudgetCents: true,
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
  notes: true,
} as const satisfies Prisma.RevenueLogEntrySelect & Record<TypedField, true>;
type Entry = Prisma.RevenueLogEntryGetPayload<{ select: typeof ENTRY_SELECT }>;

/** An entry's cell as the contract has it: dates as days. */
function typed(entry: Entry | undefined, field: TypedField): RevenueLogCells[TypedField] | null {
  if (!entry) return null;
  const value = (entry as Record<string, unknown>)[field];
  if (value instanceof Date) return dayOf(value);
  return (value ?? null) as RevenueLogCells[TypedField] | null;
}

interface Known {
  date: string;
  address: string | null;
  jobNumber: string | null;
  workComplete: boolean | null;
  arrival: string | null;
  leaving: string | null;
  invoiceNumber: string | null;
  laborCents: number | null;
  serviceCallFeeCents: number | null;
  materialsCents: number | null;
}

/** A row: what the console knows, with the office's entry laid over it. */
function rowOf(key: string, inspectionId: string | null, known: Known | null, entry: Entry | undefined): RevenueLogRow {
  const filled: Partial<Record<RevenueLogField, RevenueLogSource>> = {};
  const corrected: RevenueLogField[] = [];
  const cell = <F extends TypedField>(field: F): RevenueLogCells[F] => {
    const mine = typed(entry, field);
    const theirs = known && field in known ? (known as unknown as Record<string, unknown>)[field] : null;
    if (mine !== null) {
      if (theirs !== null && theirs !== undefined && theirs !== mine) corrected.push(field);
      return mine as RevenueLogCells[F];
    }
    if (theirs !== null && theirs !== undefined) {
      const source = CONSOLE_FILLED[field];
      if (source) filled[field] = source;
      return theirs as RevenueLogCells[F];
    }
    return null as RevenueLogCells[F];
  };
  const date = known?.date ?? dayOf(entry!.day);
  if (known) filled.date = 'VISIT';
  const cells = Object.fromEntries(TYPED_FIELDS.map((field) => [field, cell(field)])) as Omit<RevenueLogCells, 'date'>;
  return {
    key,
    inspectionId,
    entryId: entry?.id ?? null,
    date,
    ...cells,
    actualSeconds: actualSeconds(cells.arrival, cells.leaving),
    filled,
    corrected,
  };
}

@Injectable()
export class ActualVsBudgetService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(ActualVsBudgetGateway) private readonly live?: ActualVsBudgetGateway,
  ) {}

  /** Tell everyone with the page open what a save just changed (2026-11-17, live editing). */
  private tell(user: AuthenticatedUser, scope: RevenueLiveScope, cells: string[] = []) {
    this.live?.publishChange(user.organizationId, { scope, cells, by: { userId: user.id, name: user.displayName } });
  }

  /** Everyone the office may read a log for: the office's technicians, those still working first. */
  async technicians(user: AuthenticatedUser): Promise<RevenueLogTechnicians> {
    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId: user.organizationId, role: UserRole.INSPECTION_TECHNICIAN },
      select: { userProfile: { select: { id: true, displayName: true, isActive: true } } },
    });
    const seen = new Map<string, { id: string; name: string; active: boolean }>();
    for (const { userProfile } of members)
      seen.set(userProfile.id, { id: userProfile.id, name: userProfile.displayName, active: userProfile.isActive });
    return {
      technicians: [...seen.values()]
        .sort((left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name))
        .map(({ id, name }) => ({ id, name })),
    };
  }

  /** One technician's log over a stretch of days. */
  async log(user: AuthenticatedUser, query: { technicianId: string; from: string; to: string }): Promise<RevenueLog> {
    const organizationId = user.organizationId;
    const problem = logRangeProblem(query.from, query.to);
    if (problem) throw new ApplicationError(422, 'BAD_DATES', problem);
    const technician = await this.technicianOf(organizationId, query.technicianId);
    const start = businessDayBounds(businessDayFromQuery(query.from)).start;
    const end = businessDayBounds(businessDayFromQuery(query.to)).end;
    const read = await readCompanies(this.prisma, organizationId);

    const visits = await this.prisma.inspection.findMany({
      where: {
        organizationId,
        status: { not: InspectionStatus.CANCELLED },
        scheduledAt: { gte: dateOf(query.from), lte: dateOf(query.to) },
        assignments: { some: { isCurrent: true, technicianId: technician.id } },
      },
      select: {
        id: true,
        status: true,
        scheduledAt: true,
        scheduledStartAt: true,
        jobberJobNumber: true,
        jobberVisitTitle: true,
        propertywareBuildingId: true,
        propertywareBuilding: { select: { addressLine1: true } },
        property: { select: { addressLine1: true } },
        invoices: {
          where: { AND: [shownInvoices(read), { status: { not: InvoiceStatus.VOIDED } }] },
          orderBy: { createdAt: 'asc' },
          select: { number: true, lines: { select: { name: true, productName: true, totalCents: true } } },
        },
      },
      orderBy: [{ scheduledAt: 'asc' }, { scheduledStartAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    });
    const visitIds = visits.map((visit) => visit.id);

    const [entries, segments, products] = await Promise.all([
      this.prisma.revenueLogEntry.findMany({
        where: {
          organizationId,
          OR: [
            { inspectionId: { in: visitIds } },
            { inspectionId: null, technicianId: technician.id, day: { gte: dateOf(query.from), lte: dateOf(query.to) } },
          ],
        },
        select: ENTRY_SELECT,
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.timeSegment.findMany({
        where: { organizationId, technicianId: technician.id, category: TimeSegmentCategory.ONSITE, startedAt: { gte: start, lt: end } },
        select: { inspectionId: true, buildingId: true, startedAt: true, endedAt: true },
        orderBy: { startedAt: 'asc' },
      }),
      this.prisma.invoiceProduct.findMany({ where: { organizationId }, select: { nameKey: true, revenueColumn: true } }),
    ]);

    const columnOf = new Map(products.map((product) => [product.nameKey, product.revenueColumn]));
    const lineColumn = (line: { name: string; productName: string | null }): RevenueColumn =>
      columnOf.get((line.productName ?? line.name).trim().toLowerCase()) ?? 'LABOR';

    // The timesheet files time under a visit, or under a property: a property's
    // time goes to the visit only when it is the technician's one visit there
    // that day, so two visits at one address never both claim the same hours.
    const span = new Map<string, { arrivedAt: Date; leftAt: Date }>();
    const widen = (id: string, from: Date, to: Date) => {
      const known = span.get(id);
      if (!known) span.set(id, { arrivedAt: from, leftAt: to });
      else {
        if (from < known.arrivedAt) known.arrivedAt = from;
        if (to > known.leftAt) known.leftAt = to;
      }
    };
    const byBuildingDay = new Map<string, string[]>();
    for (const visit of visits) {
      if (!visit.propertywareBuildingId) continue;
      const place = `${visit.propertywareBuildingId}:${dayOf(visit.scheduledAt)}`;
      byBuildingDay.set(place, [...(byBuildingDay.get(place) ?? []), visit.id]);
    }
    const visitIdSet = new Set(visitIds);
    for (const segment of segments) {
      if (segment.inspectionId && visitIdSet.has(segment.inspectionId)) {
        widen(segment.inspectionId, segment.startedAt, segment.endedAt);
        continue;
      }
      if (segment.inspectionId || !segment.buildingId) continue;
      const there = byBuildingDay.get(`${segment.buildingId}:${businessDate(segment.startedAt)}`);
      if (there?.length === 1) widen(there[0]!, segment.startedAt, segment.endedAt);
    }

    const today = businessDate();
    const entryOf = new Map(entries.filter((entry) => entry.inspectionId).map((entry) => [entry.inspectionId!, entry]));
    const rows: RevenueLogRow[] = visits.map((visit) => {
      const date = dayOf(visit.scheduledAt);
      const address = visit.propertywareBuilding?.addressLine1 ?? visit.property?.addressLine1 ?? null;
      const money: Record<RevenueColumn, number> = { LABOR: 0, SERVICE_CALL_FEE: 0, MATERIALS: 0 };
      for (const invoice of visit.invoices) for (const line of invoice.lines) money[lineColumn(line)] += line.totalCents;
      const billed = visit.invoices.length > 0;
      const numbers = visit.invoices.map((invoice) => invoice.number).filter((number): number is string => Boolean(number));
      const time = span.get(visit.id);
      const known: Known = {
        date,
        address: address && visit.jobberVisitTitle ? `${address} - ${visit.jobberVisitTitle}` : (address ?? visit.jobberVisitTitle),
        jobNumber: visit.jobberJobNumber,
        workComplete: DONE.includes(visit.status) ? true : date < today ? false : null,
        arrival: time ? clock(time.arrivedAt) : null,
        leaving: time ? clock(time.leftAt) : null,
        invoiceNumber: numbers.length ? numbers.join('/') : null,
        laborCents: billed ? money.LABOR : null,
        serviceCallFeeCents: billed && money.SERVICE_CALL_FEE ? money.SERVICE_CALL_FEE : null,
        materialsCents: billed && money.MATERIALS ? money.MATERIALS : null,
      };
      return rowOf(visit.id, visit.id, known, entryOf.get(visit.id));
    });
    for (const entry of entries) if (!entry.inspectionId) rows.push(rowOf(entry.id, null, null, entry));

    const days = new Map<string, RevenueLogRow[]>();
    for (const row of rows) days.set(row.date, [...(days.get(row.date) ?? []), row]);
    const ordered: RevenueLogDay[] = [...days.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, dayRows]) => ({ date, rows: dayRows, totals: revenueLogTotals(dayRows) }));
    return { technician, from: query.from, to: query.to, days: ordered };
  }

  /** The office's cells for a visit's row: made the first time it types anything. */
  async saveVisit(user: AuthenticatedUser, inspectionId: string, input: SaveRevenueLogEntryInput) {
    const organizationId = user.organizationId;
    const visit = await this.prisma.inspection.findFirst({
      where: { id: inspectionId, organizationId },
      select: { id: true, scheduledAt: true, assignments: { where: { isCurrent: true }, select: { technicianId: true }, take: 1 } },
    });
    if (!visit) throw new ApplicationError(404, 'VISIT_NOT_FOUND', 'That visit is not in the console any more.');
    const technicianId = visit.assignments[0]?.technicianId;
    if (!technicianId) throw new ApplicationError(409, 'VISIT_UNASSIGNED', 'That visit has no technician, so it is on nobody\'s log.');
    const data = this.cellsOf(input);
    const result = await this.prisma.$transaction(async (tx) => {
      const before = await tx.revenueLogEntry.findUnique({ where: { inspectionId }, select: ENTRY_SELECT });
      const saved = before
        ? await tx.revenueLogEntry.update({ where: { id: before.id }, data: { ...data, updatedById: auditActor(user).actorUserId }, select: ENTRY_SELECT })
        : await tx.revenueLogEntry.create({
            data: { organizationId, technicianId, inspectionId, day: visit.scheduledAt, ...data, updatedById: auditActor(user).actorUserId },
            select: ENTRY_SELECT,
          });
      await this.audit(tx, user, saved.id, before, data);
      return { entryId: saved.id };
    });
    this.tell(user, 'log', Object.keys(data).map((field) => revenueCell.log(inspectionId, field)));
    return result;
  }

  /** A row of the office's own, for work the console has no visit for. */
  async addRow(user: AuthenticatedUser, input: SaveRevenueLogEntryInput) {
    const organizationId = user.organizationId;
    if (!input.technicianId || !input.date) throw new ApplicationError(422, 'ROW_NEEDS_DAY', 'Choose the technician and the day.');
    const technician = await this.technicianOf(organizationId, input.technicianId);
    const data = this.cellsOf(input);
    const result = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.revenueLogEntry.create({
        data: { organizationId, technicianId: technician.id, day: dateOf(input.date!), ...data, updatedById: auditActor(user).actorUserId },
        select: ENTRY_SELECT,
      });
      await this.audit(tx, user, saved.id, undefined, data);
      return { entryId: saved.id };
    });
    this.tell(user, 'log');
    return result;
  }

  /** Change a row the office has an entry for. */
  async saveEntry(user: AuthenticatedUser, entryId: string, input: SaveRevenueLogEntryInput) {
    const data = this.cellsOf(input);
    const rowKey = await this.prisma.$transaction(async (tx) => {
      const before = await tx.revenueLogEntry.findFirst({ where: { id: entryId, organizationId: user.organizationId }, select: ENTRY_SELECT });
      if (!before) throw new ApplicationError(404, 'ROW_NOT_FOUND', 'That row is not on the log any more.');
      const day = !before.inspectionId && input.date ? { day: dateOf(input.date) } : {};
      await tx.revenueLogEntry.update({ where: { id: entryId }, data: { ...data, ...day, updatedById: auditActor(user).actorUserId } });
      await this.audit(tx, user, entryId, before, data);
      return before.inspectionId ?? entryId;
    });
    this.tell(user, 'log', [...Object.keys(data), ...('date' in input ? ['date'] : [])].map((field) => revenueCell.log(rowKey, field)));
    return { entryId };
  }

  /** Remove a row the office added. A visit's row goes only with its visit; its cells are cleared instead. */
  async removeRow(user: AuthenticatedUser, entryId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const before = await tx.revenueLogEntry.findFirst({ where: { id: entryId, organizationId: user.organizationId }, select: ENTRY_SELECT });
      if (!before) throw new ApplicationError(404, 'ROW_NOT_FOUND', 'That row is not on the log any more.');
      if (before.inspectionId)
        throw new ApplicationError(409, 'ROW_IS_A_VISIT', 'This row is a visit. Clear what was typed instead; the row goes when the visit does.');
      await tx.revenueLogEntry.delete({ where: { id: entryId } });
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          ...auditActor(user),
          action: 'REVENUE_LOG_ROW_REMOVED',
          entityType: 'RevenueLogEntry',
          entityId: entryId,
          metadata: { day: dayOf(before.day), address: before.address },
        },
      });
      return { removed: true };
    });
    this.tell(user, 'log');
    return result;
  }

  /** Every product of the office, and the money column its lines go in. */
  async productColumns(user: AuthenticatedUser): Promise<RevenueProductColumns> {
    const products = await this.prisma.invoiceProduct.findMany({
      where: { organizationId: user.organizationId, active: true },
      select: { id: true, name: true, revenueColumn: true },
      orderBy: { name: 'asc' },
    });
    return { products: products.map((product) => ({ productId: product.id, name: product.name, column: product.revenueColumn ?? 'LABOR' })) };
  }

  async saveProductColumn(user: AuthenticatedUser, productId: string, column: RevenueColumn): Promise<RevenueProductColumns> {
    await this.prisma.$transaction(async (tx) => {
      const product = await tx.invoiceProduct.findFirst({ where: { id: productId, organizationId: user.organizationId }, select: { id: true, name: true, revenueColumn: true } });
      if (!product) throw new ApplicationError(404, 'PRODUCT_NOT_FOUND', 'That product is not on the list any more.');
      if ((product.revenueColumn ?? 'LABOR') === column) return;
      await tx.invoiceProduct.update({ where: { id: productId }, data: { revenueColumn: column } });
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          ...auditActor(user),
          action: 'REVENUE_PRODUCT_COLUMN_CHANGED',
          entityType: 'InvoiceProduct',
          entityId: productId,
          metadata: { product: product.name, from: product.revenueColumn ?? 'LABOR', to: column },
        },
      });
    });
    this.tell(user, 'products');
    return this.productColumns(user);
  }

  // ── PR 2: the daily sheets ──────────────────────────────────────────────

  /**
   * One day across the technicians who have a budget: what next day's
   * projection, the daily report and the revenue tracker all read. Each
   * technician's figures are their log's Total row for the day and the
   * timesheet's hours, and the payroll period so far is the same worked out
   * for every day of it up to this one.
   */
  async day(user: AuthenticatedUser, date: string): Promise<RevenueDay> {
    const organizationId = user.organizationId;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApplicationError(422, 'BAD_DATES', 'Give the day as YYYY-MM-DD.');
    const settings = await this.payrollSettings(organizationId);
    const payrollPeriod = payrollPeriodOf(date, settings.start, settings.days);
    const from = payrollPeriod.from;
    const { budgets, figuresOf } = await this.technicianDays(user, from, date);
    if (!budgets.length) return { date, payrollPeriod, technicians: [] };

    const technicians = budgets.map((budget): RevenueDayTechnician => {
      const dayOfTechnician = (day: string) => figuresOf(budget.technicianId, day);
      const period = { regularSeconds: 0, overtimeSeconds: 0, budgetedCents: 0, actualCents: 0 };
      for (let day = from; day <= date; day = nextDay(day)) {
        const figures = dayOfTechnician(day);
        if (!figures.worked) continue;
        const work = figures.workSeconds ?? 0;
        period.regularSeconds += Math.min(work, REGULAR_DAY_SECONDS);
        period.overtimeSeconds += overtimeSeconds(work);
        period.budgetedCents += trackerFigures({ ...figures, otRateCents: budget.otRateCents }).finalBudgetCents;
        period.actualCents += figures.actualCents;
      }
      const today = dayOfTechnician(date);
      return {
        technician: { id: budget.technicianId, name: budget.technician.displayName },
        dailyBudgetCents: budget.dailyBudgetCents,
        otRateCents: budget.otRateCents,
        budgetCents: today.budgetCents,
        driveTime: today.total?.driveTime ?? '0–0 min',
        billableTime: today.total?.timeBudgeted ?? '-',
        projectedCents: today.total?.estimatedBudgetCents ?? 0,
        actualCents: today.actualCents,
        workSeconds: today.workSeconds,
        typed: { budget: today.entry?.budgetCents != null, work: today.entry?.workSeconds != null },
        projectionRemarks: today.entry?.projectionRemarks ?? null,
        dailyRemarks: today.entry?.dailyRemarks ?? null,
        trackerRemarks: today.entry?.trackerRemarks ?? null,
        period,
      };
    });
    technicians.sort((left, right) => left.technician.name.localeCompare(right.technician.name));
    return { date, payrollPeriod, technicians };
  }

  /**
   * The technicians with a budget, and each one's figures for each day of a
   * stretch: the day's budget, the hours worked, the actual revenue, and
   * whether it counts as a day worked -- hours on the timesheet, revenue, or
   * visits on the log. What the daily sheets and the weekly and monthly
   * reports are all made of. Each technician's log is read once for the
   * stretch, which is never more than a month.
   */
  private async technicianDays(user: AuthenticatedUser, from: string, to: string) {
    const organizationId = user.organizationId;
    const budgets = await this.prisma.revenueTechnicianSetting.findMany({
      where: { organizationId },
      select: { technicianId: true, dailyBudgetCents: true, otRateCents: true, technician: { select: { displayName: true } } },
    });
    const ids = budgets.map((budget) => budget.technicianId);
    const start = businessDayBounds(businessDayFromQuery(from)).start;
    const end = businessDayBounds(businessDayFromQuery(to)).end;
    const [entries, segments, logs] = ids.length
      ? await Promise.all([
          this.prisma.revenueDayEntry.findMany({
            where: { organizationId, technicianId: { in: ids }, day: { gte: dateOf(from), lte: dateOf(to) } },
            select: { technicianId: true, day: true, budgetCents: true, workSeconds: true, projectionRemarks: true, dailyRemarks: true, trackerRemarks: true },
          }),
          this.prisma.timeSegment.findMany({
            where: { organizationId, technicianId: { in: ids }, startedAt: { gte: start, lt: end } },
            select: { technicianId: true, startedAt: true, durationSeconds: true },
          }),
          Promise.all(ids.map((technicianId) => this.log(user, { technicianId, from, to }))),
        ])
      : [[], [], []];

    const worked = new Map<string, number>();
    for (const segment of segments) {
      const key = `${segment.technicianId}:${businessDate(segment.startedAt)}`;
      worked.set(key, (worked.get(key) ?? 0) + segment.durationSeconds);
    }
    const entryOf = new Map(entries.map((entry) => [`${entry.technicianId}:${dayOf(entry.day)}`, entry]));
    const totalsOf = new Map(ids.map((id, index) => [id, new Map(logs[index]!.days.map((logDay) => [logDay.date, logDay.totals]))]));
    const budgetOf = new Map(budgets.map((budget) => [budget.technicianId, budget]));

    const figuresOf = (technicianId: string, day: string) => {
      const entry = entryOf.get(`${technicianId}:${day}`);
      const total = totalsOf.get(technicianId)?.get(day);
      const timesheet = worked.get(`${technicianId}:${day}`);
      const workSeconds = entry?.workSeconds ?? (timesheet ? timesheet : null);
      const actualCents = total ? total.laborCents + total.serviceCallFeeCents : 0;
      return {
        entry,
        total,
        budgetCents: entry?.budgetCents ?? budgetOf.get(technicianId)!.dailyBudgetCents,
        workSeconds,
        actualCents,
        worked: Boolean(workSeconds || actualCents || total),
      };
    };
    return { budgets, figuresOf };
  }

  // ── PR 3: the weekly and monthly reports ─────────────────────────────────

  /**
   * A month's weekly reports and its monthly report. A week's target is the
   * technician's budget for each day they worked -- the workbook's "=610*4"
   * -- and its actual revenue the days' Labor Hours Income plus Service Call
   * Fee; the office can type over either, and the remarks are its own. The
   * month adds up its weeks, as the "Month of" tabs add up the weekly tabs.
   */
  async month(user: AuthenticatedUser, month: string): Promise<RevenueMonthReport> {
    const organizationId = user.organizationId;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ApplicationError(422, 'BAD_DATES', 'Give the month as YYYY-MM.');
    const weeks = monthWeeks(month);
    const first = `${month}-01`;
    const last = monthEnd(month);
    const { budgets, figuresOf } = await this.technicianDays(user, first, last);
    if (!budgets.length) return { month, weeks: weeks.map((week) => ({ ...week, technicians: [] })), technicians: [] };
    const ids = budgets.map((budget) => budget.technicianId);
    const [weekEntries, monthEntries] = await Promise.all([
      this.prisma.revenueWeekEntry.findMany({
        where: { organizationId, technicianId: { in: ids }, weekStart: { gte: dateOf(first), lte: dateOf(last) } },
        select: { technicianId: true, weekStart: true, targetCents: true, actualCents: true, remarks: true },
      }),
      this.prisma.revenueMonthEntry.findMany({
        where: { organizationId, technicianId: { in: ids }, month: dateOf(first) },
        select: { technicianId: true, remarks: true },
      }),
    ]);
    const weekEntryOf = new Map(weekEntries.map((entry) => [`${entry.technicianId}:${dayOf(entry.weekStart)}`, entry]));
    const byName = [...budgets].sort((left, right) => left.technician.displayName.localeCompare(right.technician.displayName));

    const reports: RevenueWeek[] = weeks.map((week) => ({
      ...week,
      technicians: byName.map((budget): RevenueWeekRow => {
        let target = 0;
        let actual = 0;
        let daysWorked = 0;
        for (let day = week.from; day <= week.to; day = nextDay(day)) {
          const figures = figuresOf(budget.technicianId, day);
          actual += figures.actualCents;
          if (!figures.worked) continue;
          daysWorked += 1;
          target += figures.budgetCents;
        }
        const entry = weekEntryOf.get(`${budget.technicianId}:${week.from}`);
        return {
          technician: { id: budget.technicianId, name: budget.technician.displayName },
          targetCents: entry?.targetCents ?? target,
          actualCents: entry?.actualCents ?? actual,
          daysWorked,
          typed: { target: entry?.targetCents != null, actual: entry?.actualCents != null },
          remarks: entry?.remarks ?? null,
        };
      }),
    }));
    const remarksOf = new Map(monthEntries.map((entry) => [entry.technicianId, entry.remarks]));
    return {
      month,
      weeks: reports,
      technicians: byName.map((budget, index) => ({
        technician: { id: budget.technicianId, name: budget.technician.displayName },
        targetCents: reports.reduce((sum, week) => sum + week.technicians[index]!.targetCents, 0),
        actualCents: reports.reduce((sum, week) => sum + week.technicians[index]!.actualCents, 0),
        remarks: remarksOf.get(budget.technicianId) ?? null,
      })),
    };
  }

  /** What the office typed for a technician's week: target, actual revenue, remarks. */
  async saveWeek(user: AuthenticatedUser, technicianId: string, weekStart: string, input: SaveRevenueWeekInput) {
    const week = monthWeeks(weekStart.slice(0, 7)).find((candidate) => candidate.from === weekStart);
    if (!week) throw new ApplicationError(422, 'BAD_DATES', 'That is not the first day of a week of its month.');
    const fields = ['targetCents', 'actualCents', 'remarks'] as const;
    const result = await this.saveTyped(user, technicianId, 'REVENUE_WEEK_EDITED', `${technicianId}:${weekStart}`, input, fields, {
      find: (tx) => tx.revenueWeekEntry.findUnique({ where: { technicianId_weekStart: { technicianId, weekStart: dateOf(weekStart) } } }),
      upsert: (tx, data, organizationId) =>
        tx.revenueWeekEntry.upsert({
          where: { technicianId_weekStart: { technicianId, weekStart: dateOf(weekStart) } },
          create: { organizationId, technicianId, weekStart: dateOf(weekStart), ...data },
          update: data,
        }),
    });
    this.tell(user, 'week', fields.filter((field) => field in input).map((field) => revenueCell.week(technicianId, weekStart, field)));
    return result;
  }

  /** The remarks the office typed for a technician's month. */
  async saveMonth(user: AuthenticatedUser, technicianId: string, month: string, input: SaveRevenueMonthInput) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ApplicationError(422, 'BAD_DATES', 'Give the month as YYYY-MM.');
    const first = dateOf(`${month}-01`);
    const result = await this.saveTyped(user, technicianId, 'REVENUE_MONTH_EDITED', `${technicianId}:${month}`, input, ['remarks'], {
      find: (tx) => tx.revenueMonthEntry.findUnique({ where: { technicianId_month: { technicianId, month: first } } }),
      upsert: (tx, data, organizationId) =>
        tx.revenueMonthEntry.upsert({
          where: { technicianId_month: { technicianId, month: first } },
          create: { organizationId, technicianId, month: first, ...data },
          update: data,
        }),
    });
    this.tell(user, 'month', 'remarks' in input ? [revenueCell.month(technicianId, month, 'remarks')] : []);
    return result;
  }

  /** Save the cells the office typed into a week or a month, and put the change on the record. */
  private async saveTyped(
    user: AuthenticatedUser,
    technicianId: string,
    action: string,
    entityId: string,
    input: object,
    fields: readonly string[],
    store: {
      find: (tx: Prisma.TransactionClient) => Promise<Record<string, unknown> | null>;
      upsert: (tx: Prisma.TransactionClient, data: Record<string, unknown>, organizationId: string) => Promise<unknown>;
    },
  ) {
    const organizationId = user.organizationId;
    const technician = await this.technicianOf(organizationId, technicianId);
    const data: Record<string, unknown> = {};
    for (const field of fields) {
      if (!(field in input)) continue;
      const value = (input as Record<string, unknown>)[field];
      data[field] = typeof value === 'string' ? value.trim() || null : (value ?? null);
    }
    await this.prisma.$transaction(async (tx) => {
      const before = await store.find(tx);
      const changes = Object.entries(data)
        .filter(([field, value]) => (before?.[field] ?? null) !== value)
        .map(([field, value]) => ({ field, from: String(before?.[field] ?? ''), to: String(value ?? '') }));
      if (!changes.length) return;
      await store.upsert(tx, { ...data, updatedById: auditActor(user).actorUserId }, organizationId);
      await tx.auditLog.create({
        data: { organizationId, ...auditActor(user), action, entityType: 'RevenueReport', entityId, metadata: { technician: technician.name, changes } },
      });
    });
    return { saved: true };
  }

  /** What the office typed for a technician's day. */
  async saveDay(user: AuthenticatedUser, technicianId: string, date: string, input: SaveRevenueDayInput) {
    const organizationId = user.organizationId;
    const technician = await this.technicianOf(organizationId, technicianId);
    const data: Record<string, unknown> = {};
    for (const field of DAY_FIELDS) {
      if (!(field in input)) continue;
      const value = (input as Record<string, unknown>)[field];
      data[field] = typeof value === 'string' ? value.trim() || null : (value ?? null);
    }
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.revenueDayEntry.findUnique({ where: { technicianId_day: { technicianId: technician.id, day: dateOf(date) } } });
      const changes = Object.entries(data)
        .filter(([field, value]) => ((before as Record<string, unknown> | null)?.[field] ?? null) !== value)
        .map(([field, value]) => ({ field, from: String((before as Record<string, unknown> | null)?.[field] ?? ''), to: String(value ?? '') }));
      if (!changes.length) return;
      await tx.revenueDayEntry.upsert({
        where: { technicianId_day: { technicianId: technician.id, day: dateOf(date) } },
        create: { organizationId, technicianId: technician.id, day: dateOf(date), ...data, updatedById: auditActor(user).actorUserId },
        update: { ...data, updatedById: auditActor(user).actorUserId },
      });
      await tx.auditLog.create({
        data: {
          organizationId,
          ...auditActor(user),
          action: 'REVENUE_DAY_EDITED',
          entityType: 'RevenueDayEntry',
          entityId: `${technician.id}:${date}`,
          metadata: { technician: technician.name, day: date, changes },
        },
      });
    });
    this.tell(user, 'day', Object.keys(data).map((field) => revenueCell.day(technician.id, date, field)));
    return { saved: true };
  }

  /** Each technician's budget and overtime rate, and the payroll periods. */
  async budgets(user: AuthenticatedUser): Promise<RevenueBudgets> {
    const [{ technicians }, settings, budgets] = await Promise.all([
      this.technicians(user),
      this.payrollSettings(user.organizationId),
      this.prisma.revenueTechnicianSetting.findMany({
        where: { organizationId: user.organizationId },
        select: { technicianId: true, dailyBudgetCents: true, otRateCents: true },
      }),
    ]);
    const budgetOf = new Map(budgets.map((budget) => [budget.technicianId, budget]));
    return {
      payrollPeriodStart: settings.start,
      payrollPeriodDays: settings.days,
      technicians: technicians.map((technician) => ({
        ...technician,
        dailyBudgetCents: budgetOf.get(technician.id)?.dailyBudgetCents ?? null,
        otRateCents: budgetOf.get(technician.id)?.otRateCents ?? null,
      })),
    };
  }

  async saveBudgets(user: AuthenticatedUser, input: SaveRevenueBudgetsInput): Promise<RevenueBudgets> {
    const organizationId = user.organizationId;
    for (const row of input.technicians ?? []) await this.technicianOf(organizationId, row.technicianId);
    await this.prisma.$transaction(async (tx) => {
      const changes: string[] = [];
      if (input.payrollPeriodStart !== undefined || input.payrollPeriodDays !== undefined) {
        const current = await this.payrollSettings(organizationId, tx);
        const next = { start: input.payrollPeriodStart ?? current.start, days: input.payrollPeriodDays ?? current.days };
        await tx.revenueSettings.upsert({
          where: { organizationId },
          create: { organizationId, payrollPeriodStart: dateOf(next.start), payrollPeriodDays: next.days },
          update: { payrollPeriodStart: dateOf(next.start), payrollPeriodDays: next.days },
        });
        changes.push(`Payroll periods: ${current.start}/${current.days} → ${next.start}/${next.days}`);
      }
      for (const row of input.technicians ?? []) {
        if (row.dailyBudgetCents === null) {
          const removed = await tx.revenueTechnicianSetting.deleteMany({ where: { organizationId, technicianId: row.technicianId } });
          if (removed.count) changes.push(`${row.technicianId}: off the daily sheets`);
          continue;
        }
        const values = { dailyBudgetCents: row.dailyBudgetCents, otRateCents: row.otRateCents ?? 0, updatedById: auditActor(user).actorUserId };
        await tx.revenueTechnicianSetting.upsert({
          where: { technicianId: row.technicianId },
          create: { organizationId, technicianId: row.technicianId, ...values },
          update: values,
        });
        changes.push(`${row.technicianId}: budget ${row.dailyBudgetCents}, overtime ${row.otRateCents ?? 0}`);
      }
      if (changes.length)
        await tx.auditLog.create({
          data: { organizationId, ...auditActor(user), action: 'REVENUE_BUDGETS_CHANGED', entityType: 'RevenueSettings', entityId: organizationId, metadata: { changes } },
        });
    });
    this.tell(user, 'budgets');
    return this.budgets(user);
  }

  // ── PR 4: past technicians' logs ─────────────────────────────────────────

  /**
   * Read the workbook the office uploads and keep its past technicians' logs:
   * every hidden tab laid out as a technician's log, as the text it showed.
   * The tabs still in use are the console's own now and are left alone.
   * Importing again replaces a tab of the same name; nothing else is touched.
   */
  async importHistory(user: AuthenticatedUser, file: UploadedWorkbook | undefined): Promise<RevenueHistoryImport> {
    if (!file?.buffer?.length) throw new ApplicationError(422, 'NO_WORKBOOK', 'Choose the workbook to import.');
    if (file.size > MAX_WORKBOOK_BYTES) throw new ApplicationError(413, 'WORKBOOK_TOO_LARGE', 'That workbook is larger than 20 MB.');
    let sheets: WorkbookSheet[];
    try {
      sheets = readWorkbook(file.buffer);
    } catch (error) {
      if (error instanceof WorkbookError) throw new ApplicationError(422, 'NOT_A_WORKBOOK', error.message);
      throw error;
    }
    const logs = sheets
      .filter((sheet) => sheet.hidden)
      .map((sheet) => ({ name: sheet.name.trim().slice(0, 100), log: technicianLog(sheet) }))
      .filter((sheet): sheet is { name: string; log: NonNullable<ReturnType<typeof technicianLog>> } => Boolean(sheet.name && sheet.log));
    if (!logs.length) throw new ApplicationError(422, 'NO_PAST_LOGS', 'That workbook has no hidden technician tabs to import.');
    const organizationId = user.organizationId;
    const fileName = (file.originalname || 'workbook.xlsx').slice(0, 200);
    await this.prisma.$transaction(async (tx) => {
      for (const { name, log } of logs) {
        const data = { headers: log.headers, rows: log.rows, rowCount: log.rows.length, fileName, importedAt: new Date(), importedById: auditActor(user).actorUserId };
        await tx.revenueHistorySheet.upsert({
          where: { organizationId_name: { organizationId, name } },
          create: { organizationId, name, ...data },
          update: data,
        });
      }
      await tx.auditLog.create({
        data: {
          organizationId,
          ...auditActor(user),
          action: 'REVENUE_HISTORY_IMPORTED',
          entityType: 'RevenueHistorySheet',
          entityId: organizationId,
          metadata: { fileName, tabs: logs.map(({ name, log }) => ({ name, rows: log.rows.length })) },
        },
      });
    });
    this.tell(user, 'history');
    return { imported: logs.map(({ name, log }) => ({ name, rowCount: log.rows.length })) };
  }

  async historyList(user: AuthenticatedUser): Promise<RevenueHistoryList> {
    const sheets = await this.prisma.revenueHistorySheet.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, name: true, rowCount: true, importedAt: true },
      orderBy: { name: 'asc' },
    });
    return { sheets: sheets.map((sheet) => ({ ...sheet, importedAt: sheet.importedAt.toISOString() })) };
  }

  async historySheet(user: AuthenticatedUser, id: string): Promise<RevenueHistorySheetView> {
    const sheet = await this.prisma.revenueHistorySheet.findFirst({ where: { id, organizationId: user.organizationId } });
    if (!sheet) throw new ApplicationError(404, 'HISTORY_NOT_FOUND', 'That log is not in the console any more.');
    return {
      id: sheet.id,
      name: sheet.name,
      rowCount: sheet.rowCount,
      importedAt: sheet.importedAt.toISOString(),
      fileName: sheet.fileName,
      headers: sheet.headers as string[],
      rows: sheet.rows as string[][],
    };
  }

  private async payrollSettings(organizationId: string, db: Pick<Prisma.TransactionClient, 'revenueSettings'> = this.prisma) {
    const row = await db.revenueSettings.findUnique({ where: { organizationId }, select: { payrollPeriodStart: true, payrollPeriodDays: true } });
    return row ? { start: dayOf(row.payrollPeriodStart), days: row.payrollPeriodDays } : { start: DEFAULT_PAYROLL_PERIOD.start, days: DEFAULT_PAYROLL_PERIOD.days };
  }

  private async technicianOf(organizationId: string, technicianId: string) {
    const member = await this.prisma.organizationMember.findFirst({
      where: { organizationId, userProfileId: technicianId, role: UserRole.INSPECTION_TECHNICIAN },
      select: { userProfile: { select: { id: true, displayName: true } } },
    });
    if (!member) throw new ApplicationError(404, 'TECHNICIAN_NOT_FOUND', 'That technician is not in this office.');
    return { id: member.userProfile.id, name: member.userProfile.displayName };
  }

  /** The typed cells the input names, as columns: a field left out is left alone, a null clears it. */
  private cellsOf(input: SaveRevenueLogEntryInput): Partial<Pick<Prisma.RevenueLogEntryUncheckedCreateInput, TypedField>> {
    const data: Record<string, unknown> = {};
    for (const field of TYPED_FIELDS) {
      if (!(field in input)) continue;
      let value = (input as Record<string, unknown>)[field];
      if (typeof value === 'string') value = value.trim() || null;
      if (field === 'rescheduleOn' && typeof value === 'string') value = dateOf(value);
      data[field] = value ?? null;
    }
    return data as Partial<Pick<Prisma.RevenueLogEntryUncheckedCreateInput, TypedField>>;
  }

  /** Every save of the log is on the record: which cells, from what, to what. */
  private async audit(tx: Prisma.TransactionClient, user: AuthenticatedUser, entryId: string, before: Entry | null | undefined, data: Record<string, unknown>) {
    const show = (value: unknown) => (value instanceof Date ? dayOf(value) : value === null || value === undefined ? '' : String(value));
    const changes = Object.entries(data)
      .filter(([field, value]) => show((before as Record<string, unknown> | null | undefined)?.[field]) !== show(value))
      .map(([field, value]) => ({ field, from: show((before as Record<string, unknown> | null | undefined)?.[field]), to: show(value) }));
    if (!changes.length && before) return;
    await tx.auditLog.create({
      data: {
        organizationId: user.organizationId,
        ...auditActor(user),
        action: before ? 'REVENUE_LOG_EDITED' : 'REVENUE_LOG_ROW_ADDED',
        entityType: 'RevenueLogEntry',
        entityId: entryId,
        metadata: { changes },
      },
    });
  }
}
