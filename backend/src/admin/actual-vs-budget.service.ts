import { Inject, Injectable } from '@nestjs/common';
import {
  CONSOLE_FILLED,
  actualSeconds,
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
import { readCompanies, shownInvoices } from './shown-invoices';

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
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

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
    return this.prisma.$transaction(async (tx) => {
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
  }

  /** A row of the office's own, for work the console has no visit for. */
  async addRow(user: AuthenticatedUser, input: SaveRevenueLogEntryInput) {
    const organizationId = user.organizationId;
    if (!input.technicianId || !input.date) throw new ApplicationError(422, 'ROW_NEEDS_DAY', 'Choose the technician and the day.');
    const technician = await this.technicianOf(organizationId, input.technicianId);
    const data = this.cellsOf(input);
    return this.prisma.$transaction(async (tx) => {
      const saved = await tx.revenueLogEntry.create({
        data: { organizationId, technicianId: technician.id, day: dateOf(input.date!), ...data, updatedById: auditActor(user).actorUserId },
        select: ENTRY_SELECT,
      });
      await this.audit(tx, user, saved.id, undefined, data);
      return { entryId: saved.id };
    });
  }

  /** Change a row the office has an entry for. */
  async saveEntry(user: AuthenticatedUser, entryId: string, input: SaveRevenueLogEntryInput) {
    const data = this.cellsOf(input);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.revenueLogEntry.findFirst({ where: { id: entryId, organizationId: user.organizationId }, select: ENTRY_SELECT });
      if (!before) throw new ApplicationError(404, 'ROW_NOT_FOUND', 'That row is not on the log any more.');
      const day = !before.inspectionId && input.date ? { day: dateOf(input.date) } : {};
      await tx.revenueLogEntry.update({ where: { id: entryId }, data: { ...data, ...day, updatedById: auditActor(user).actorUserId } });
      await this.audit(tx, user, entryId, before, data);
      return { entryId };
    });
  }

  /** Remove a row the office added. A visit's row goes only with its visit; its cells are cleared instead. */
  async removeRow(user: AuthenticatedUser, entryId: string) {
    return this.prisma.$transaction(async (tx) => {
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
    return this.productColumns(user);
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
