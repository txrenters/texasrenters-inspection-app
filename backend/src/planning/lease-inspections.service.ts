import { Inject, Injectable, Logger } from '@nestjs/common';
import type { InspectionType } from '@prisma/client';
import { InspectionSource, InspectionStatus, LeaseInspectionOutcome } from '@prisma/client';
import {
  type DueInspection,
  type LeaseDates,
  type LeaseInspectionKind,
  type LeaseScheduleAction,
  type LeaseScheduleChange,
  type LeaseScheduleItem,
  type LeaseScheduleRun,
  LEASE_INSPECTION_HORIZON_DAYS,
  addDays,
  inspectionsDue,
  spreadOverdue,
  tenancyEndsOn,
  tenantIsLeaving,
} from '@texasrenters/shared';

import { insertInspection, resolveInspectionPlan } from '../admin/inspection-creation';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

/**
 * Move-outs and move-ins, booked from Propertyware's leases (the office, 2026-09-18).
 *
 * The office used to book these in Jobber by hand. Jobber is on its way out --
 * "PW will be there just for the integration" -- so this books them here, from
 * the lease dates the tenant sync already holds: a move-out sixty days before
 * every tenancy ends, for the technician who handles move-outs (Moses), and a
 * move-in twenty-two days after a leaving tenant goes, for the one who handles
 * move-ins (Amy). The rules themselves are `inspectionsDue` in shared.
 *
 * Run once a day, and safe to run again: each lease and kind has one row in
 * `LeaseScheduledInspection`, so an inspection is booked once, moved when the
 * lease's dates move, and called off when the lease no longer asks for it --
 * but only while it is still this schedule's own. One the office has started,
 * moved by hand or cancelled is theirs, and one the office booked themselves
 * near the day is linked rather than doubled.
 */

/** How near the day an inspection the office booked has to be to count as the one the lease asks for. */
const ALREADY_BOOKED_WINDOW_DAYS = 30;

/** How long a lease that dropped off the report is still read: long enough for the move-in after it. */
const DROPPED_LEASE_DAYS = 60;

const KINDS: readonly LeaseInspectionKind[] = ['MOVE_OUT', 'MOVE_IN'];

const LABEL: Record<LeaseInspectionKind, string> = { MOVE_OUT: 'move-out', MOVE_IN: 'move-in' };

interface LeaseRow {
  id: string;
  buildingId: string;
  unitId: string | null;
  leaseName: string | null;
  sourceStatus: string | null;
  isActive: boolean;
  endDate: Date | null;
  scheduledMoveOutDate: Date | null;
  noticeGivenDate: Date | null;
  deactivatedAt: Date | null;
  building: { addressLine1: string | null; city: string | null };
}

interface ScheduleRow {
  id: string;
  leaseId: string;
  inspectionType: InspectionType;
  dueOn: Date;
  scheduledOn: Date;
  outcome: LeaseInspectionOutcome;
  inspectionId: string | null;
  inspection: { id: string; status: InspectionStatus; startedAt: Date | null; scheduledAt: Date } | null;
}

const day = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const dateOf = (value: string) => new Date(`${value}T00:00:00.000Z`);
/** A lease written again under its name at the same building is the same tenancy renewed. */
const renewalKey = (lease: Pick<LeaseRow, 'buildingId' | 'leaseName'>) =>
  `${lease.buildingId}|${(lease.leaseName ?? '').trim().toLowerCase()}`;

const LONG_DAY = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const spoken = (value: string) => LONG_DAY.format(dateOf(value));

@Injectable()
export class LeaseInspectionService {
  private readonly logger = new Logger(LeaseInspectionService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Book, move or call off every lease's move-out and move-in, as the rules say today.
   *
   * A dry run reads everything a run would and writes nothing, so the console
   * can show what the schedule is about to do before anyone switches it on.
   */
  async run(organizationId: string, options: { dryRun?: boolean; now?: Date } = {}): Promise<LeaseScheduleRun> {
    const dryRun = Boolean(options.dryRun);
    const today = businessDate(options.now ?? new Date());

    const leases: LeaseRow[] = await this.prisma.propertywareLease.findMany({
      where: {
        organizationId,
        OR: [{ isActive: true }, { deactivatedAt: { gte: dateOf(addDays(today, -DROPPED_LEASE_DAYS)) } }],
      },
      select: {
        id: true,
        buildingId: true,
        unitId: true,
        leaseName: true,
        sourceStatus: true,
        isActive: true,
        endDate: true,
        scheduledMoveOutDate: true,
        noticeGivenDate: true,
        deactivatedAt: true,
        building: { select: { addressLine1: true, city: true } },
      },
      orderBy: [{ endDate: 'asc' }, { id: 'asc' }],
    });
    const onReport = new Set(leases.filter((lease) => lease.isActive).map(renewalKey));

    const rows: ScheduleRow[] = await this.prisma.leaseScheduledInspection.findMany({
      where: { organizationId },
      select: {
        id: true,
        leaseId: true,
        inspectionType: true,
        dueOn: true,
        scheduledOn: true,
        outcome: true,
        inspectionId: true,
        inspection: { select: { id: true, status: true, startedAt: true, scheduledAt: true } },
      },
    });
    const schedule = new Map(rows.map((row) => [`${row.leaseId}|${row.inspectionType}`, row]));
    const technicians = await this.handlers(organizationId);

    const run: LeaseScheduleRun = {
      today,
      dryRun,
      leases: leases.length,
      counts: { BOOK: 0, ALREADY_BOOKED: 0, NEEDS_UNIT: 0, NOT_BOOKABLE: 0, MOVE: 0, CALL_OFF: 0 },
      changes: [],
    };
    const plans = leases.map((lease) => {
      const dates: LeaseDates = {
        status: lease.sourceStatus,
        isActive: lease.isActive,
        endDate: day(lease.endDate),
        scheduledMoveOutDate: day(lease.scheduledMoveOutDate),
        noticeGivenDate: day(lease.noticeGivenDate),
        droppedOn: lease.isActive || !lease.deactivatedAt ? null : businessDate(lease.deactivatedAt),
        renewed: !lease.isActive && onReport.has(renewalKey(lease)),
      };
      return { lease, dates, due: inspectionsDue(dates, today) };
    });
    // Whose day has already passed, and not booked yet: three a working day
    // from the next one, soonest first, not all on one morning (2026-09-18).
    const spread = spreadOverdue(
      plans.flatMap(({ lease, dates, due }) =>
        due
          .filter((entry) => entry.dueOn < today && !schedule.has(`${lease.id}|${entry.kind}`))
          .map((entry) => ({
            key: `${lease.id}|${entry.kind}`,
            kind: entry.kind,
            dueOn: entry.dueOn,
            latest: entry.kind === 'MOVE_OUT' ? tenancyEndsOn(dates) : null,
          })),
      ),
      today,
    );

    for (const { lease, dates, due } of plans) {
      for (const kind of KINDS) {
        const found = due.find((entry) => entry.kind === kind) ?? null;
        const spreadTo = spread.get(`${lease.id}|${kind}`);
        const change = await this.reconcile({
          organizationId,
          lease,
          dates,
          kind,
          wanted: found && spreadTo ? { ...found, scheduledOn: spreadTo } : found,
          row: schedule.get(`${lease.id}|${kind}`) ?? null,
          today,
          technicianId: technicians[kind],
          dryRun,
        });
        if (!change) continue;
        run.counts[change.action] += 1;
        run.changes.push(change);
      }
    }

    this.logger.log({
      event: 'lease_inspections_run',
      organizationId,
      today,
      dryRun,
      leases: run.leases,
      ...run.counts,
    });
    return run;
  }

  /** The lease schedule as it stands, for the console: soonest first, from a week ago. */
  async list(organizationId: string, now: Date = new Date()): Promise<LeaseScheduleItem[]> {
    const since = dateOf(addDays(businessDate(now), -7));
    const rows = await this.prisma.leaseScheduledInspection.findMany({
      where: { organizationId, scheduledOn: { gte: since } },
      orderBy: [{ scheduledOn: 'asc' }, { inspectionType: 'asc' }],
      select: {
        id: true,
        inspectionType: true,
        dueOn: true,
        scheduledOn: true,
        outcome: true,
        detail: true,
        updatedAt: true,
        inspection: {
          select: {
            id: true,
            status: true,
            scheduledAt: true,
            assignments: {
              where: { isCurrent: true },
              select: { technician: { select: { id: true, displayName: true } } },
              take: 1,
            },
          },
        },
        lease: {
          select: {
            id: true,
            sourceStatus: true,
            endDate: true,
            scheduledMoveOutDate: true,
            building: { select: { id: true, name: true, addressLine1: true, city: true } },
          },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      kind: row.inspectionType as LeaseInspectionKind,
      dueOn: day(row.dueOn)!,
      scheduledOn: day(row.scheduledOn)!,
      outcome: row.outcome,
      detail: row.detail,
      updatedAt: row.updatedAt.toISOString(),
      property: {
        id: row.lease.building.id,
        name: row.lease.building.name,
        address: row.lease.building.addressLine1,
        city: row.lease.building.city,
      },
      lease: {
        id: row.lease.id,
        status: row.lease.sourceStatus,
        endsOn: day(row.lease.scheduledMoveOutDate) ?? day(row.lease.endDate),
      },
      inspection: row.inspection
        ? {
            id: row.inspection.id,
            status: row.inspection.status,
            scheduledOn: day(row.inspection.scheduledAt)!,
            technician: row.inspection.assignments[0]?.technician ?? null,
          }
        : null,
    }));
  }

  /**
   * One lease's move-out or move-in: what the rules want against what is booked.
   *
   * Only an inspection this schedule booked, still scheduled, not started, on
   * the day it was booked for and not yet come, is moved or called off with the
   * lease. Anything else is somebody's: the lease's new dates are noted and it
   * is left alone.
   */
  private async reconcile(input: {
    organizationId: string;
    lease: LeaseRow;
    dates: LeaseDates;
    kind: LeaseInspectionKind;
    wanted: DueInspection | null;
    row: ScheduleRow | null;
    today: string;
    technicianId: string | null;
    dryRun: boolean;
  }): Promise<LeaseScheduleChange | null> {
    const { kind, wanted, row, today, dryRun } = input;
    const ours = row?.outcome === LeaseInspectionOutcome.SCHEDULED ? row.inspection : null;

    // Cancelled in the console: the office's decision about that day, recorded
    // so it is not booked again unless the lease's dates move.
    if (row && ours?.status === InspectionStatus.CANCELLED) {
      if (!dryRun)
        await this.prisma.leaseScheduledInspection.update({
          where: { id: row.id },
          data: { outcome: LeaseInspectionOutcome.CANCELLED, detail: 'Cancelled in the console.' },
        });
      return null;
    }

    const untouched =
      row !== null &&
      ours !== null &&
      ours.status === InspectionStatus.SCHEDULED &&
      !ours.startedAt &&
      day(ours.scheduledAt) === day(row.scheduledOn) &&
      day(ours.scheduledAt)! > today;

    if (!wanted) return row && untouched ? this.callOff(input, row, ours!.id) : null;
    if (!row) return this.book(input);

    if (day(row.dueOn) === wanted.dueOn) {
      // The lease has not changed. Only what could not be booked is tried
      // again, and a booking of the office's that no longer covers it.
      const officeBookingGone =
        row.outcome === LeaseInspectionOutcome.ALREADY_BOOKED &&
        (!row.inspection || row.inspection.status === InspectionStatus.CANCELLED);
      // An inspection booked here that has since been deleted outright.
      const oursGone = row.outcome === LeaseInspectionOutcome.SCHEDULED && !row.inspection;
      const retry =
        row.outcome === LeaseInspectionOutcome.NEEDS_UNIT ||
        row.outcome === LeaseInspectionOutcome.NOT_BOOKABLE ||
        officeBookingGone ||
        oursGone;
      return retry ? this.book(input) : null;
    }

    // The lease's dates moved.
    if (untouched) return this.move(input, row, ours!.id);
    if (row.outcome === LeaseInspectionOutcome.SCHEDULED && ours) {
      if (!dryRun)
        await this.prisma.leaseScheduledInspection.update({
          where: { id: row.id },
          data: {
            dueOn: dateOf(wanted.dueOn),
            detail: `The lease’s dates moved its ${LABEL[kind]} to ${spoken(wanted.scheduledOn)}, but this one was started or moved by hand, so it was left as it is.`,
          },
        });
      return null;
    }
    return this.book(input);
  }

  /**
   * Book one: link the office's own booking near the day if there is one, and
   * otherwise create the inspection, assigned to whoever handles the kind.
   */
  private async book(input: {
    organizationId: string;
    lease: LeaseRow;
    kind: LeaseInspectionKind;
    wanted: DueInspection | null;
    technicianId: string | null;
    dryRun: boolean;
  }): Promise<LeaseScheduleChange> {
    const { organizationId, lease, kind, technicianId, dryRun } = input;
    const wanted = input.wanted!;
    const change = (action: LeaseScheduleAction, inspectionId: string | null, detail: string | null): LeaseScheduleChange => ({
      leaseId: lease.id,
      property: { id: lease.buildingId, address: lease.building.addressLine1, city: lease.building.city },
      kind,
      action,
      scheduledOn: wanted.scheduledOn,
      inspectionId,
      detail,
    });
    const record = (outcome: LeaseInspectionOutcome, inspectionId: string | null, detail: string | null) =>
      this.prisma.leaseScheduledInspection.upsert({
        where: { leaseId_inspectionType: { leaseId: lease.id, inspectionType: kind } },
        create: {
          organizationId,
          leaseId: lease.id,
          inspectionType: kind,
          dueOn: dateOf(wanted.dueOn),
          scheduledOn: dateOf(wanted.scheduledOn),
          outcome,
          inspectionId,
          detail,
        },
        update: { dueOn: dateOf(wanted.dueOn), scheduledOn: dateOf(wanted.scheduledOn), outcome, inspectionId, detail },
      });

    // One the office booked near the day is the one the lease asks for.
    const existing = await this.prisma.inspection.findFirst({
      where: {
        organizationId,
        propertywareBuildingId: lease.buildingId,
        ...(lease.unitId ? { propertywareUnitId: lease.unitId } : {}),
        inspectionType: kind,
        status: { not: InspectionStatus.CANCELLED },
        scheduledAt: {
          gte: dateOf(addDays(wanted.scheduledOn, -ALREADY_BOOKED_WINDOW_DAYS)),
          lte: dateOf(addDays(wanted.scheduledOn, ALREADY_BOOKED_WINDOW_DAYS)),
        },
      },
      orderBy: { scheduledAt: 'asc' },
      select: { id: true, scheduledAt: true },
    });
    if (existing) {
      const detail = `Already booked for ${spoken(day(existing.scheduledAt)!)}.`;
      if (!dryRun) await record(LeaseInspectionOutcome.ALREADY_BOOKED, existing.id, detail);
      return change('ALREADY_BOOKED', existing.id, detail);
    }

    const unitMissing =
      !lease.unitId &&
      (await this.prisma.propertywareUnit.count({
        where: { organizationId, buildingId: lease.buildingId, isActive: true },
      })) > 0;
    const needsUnitDetail =
      'The building has several units, and Propertyware’s lease does not say which is the tenancy’s. Book it from the console with its unit.';
    if (dryRun) return unitMissing ? change('NEEDS_UNIT', null, needsUnitDetail) : change('BOOK', null, null);

    try {
      const inspectionId = await this.prisma.$transaction(async (tx) => {
        const plan = await resolveInspectionPlan(tx, {
          organizationId,
          buildingId: lease.buildingId,
          unitId: lease.unitId,
          // A lease is only ever linked through its unit; the report's carry none.
          leaseId: lease.unitId ? lease.id : null,
          inspectionType: kind,
          scheduledAt: dateOf(wanted.scheduledOn),
        });
        const inspection = await insertInspection(tx, plan, {
          priority: 'STANDARD',
          // Nobody chose this property or this day; the lease's dates did.
          createdById: null,
          source: InspectionSource.MANUAL,
          status: InspectionStatus.SCHEDULED,
          internalNotes: noteFor(kind, wanted, lease),
        });
        if (technicianId)
          await tx.inspectionAssignment.create({
            data: {
              inspectionId: inspection.id,
              technicianId,
              assignedById: null,
              reason: kind === 'MOVE_OUT' ? 'Move-out booked from the lease' : 'Move-in booked from the lease',
              idempotencyKey: `lease:${lease.id}:${kind}:${wanted.dueOn}`,
            },
          });
        await tx.leaseScheduledInspection.upsert({
          where: { leaseId_inspectionType: { leaseId: lease.id, inspectionType: kind } },
          create: {
            organizationId,
            leaseId: lease.id,
            inspectionType: kind,
            dueOn: dateOf(wanted.dueOn),
            scheduledOn: dateOf(wanted.scheduledOn),
            outcome: LeaseInspectionOutcome.SCHEDULED,
            inspectionId: inspection.id,
            detail: null,
          },
          update: {
            dueOn: dateOf(wanted.dueOn),
            scheduledOn: dateOf(wanted.scheduledOn),
            outcome: LeaseInspectionOutcome.SCHEDULED,
            inspectionId: inspection.id,
            detail: null,
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: null,
            action: 'INSPECTION_BOOKED_FROM_LEASE',
            entityType: 'Inspection',
            entityId: inspection.id,
            metadata: { leaseId: lease.id, kind, dueOn: wanted.dueOn, scheduledOn: wanted.scheduledOn, technicianId },
          },
        });
        return inspection.id;
      });
      return change('BOOK', inspectionId, null);
    } catch (error) {
      const needsUnit = error instanceof ApplicationError && error.code === 'UNIT_REQUIRED';
      const detail = needsUnit ? needsUnitDetail : error instanceof Error ? error.message : String(error);
      await record(needsUnit ? LeaseInspectionOutcome.NEEDS_UNIT : LeaseInspectionOutcome.NOT_BOOKABLE, null, detail);
      return change(needsUnit ? 'NEEDS_UNIT' : 'NOT_BOOKABLE', null, detail);
    }
  }

  /** The lease's dates moved: so does the inspection booked from them. */
  private async move(
    input: { organizationId: string; lease: LeaseRow; kind: LeaseInspectionKind; wanted: DueInspection | null; dryRun: boolean },
    row: ScheduleRow,
    inspectionId: string,
  ): Promise<LeaseScheduleChange> {
    const { organizationId, lease, kind, dryRun } = input;
    const wanted = input.wanted!;
    const from = day(row.scheduledOn)!;
    const detail = `Moved from ${spoken(from)} when the lease’s dates changed.`;
    if (!dryRun)
      await this.prisma.$transaction(async (tx) => {
        await tx.inspection.update({ where: { id: inspectionId }, data: { scheduledAt: dateOf(wanted.scheduledOn) } });
        await tx.leaseScheduledInspection.update({
          where: { id: row.id },
          data: { dueOn: dateOf(wanted.dueOn), scheduledOn: dateOf(wanted.scheduledOn), detail },
        });
        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: null,
            action: 'INSPECTION_MOVED_WITH_LEASE',
            entityType: 'Inspection',
            entityId: inspectionId,
            metadata: { leaseId: lease.id, kind, from, to: wanted.scheduledOn },
          },
        });
      });
    return {
      leaseId: lease.id,
      property: { id: lease.buildingId, address: lease.building.addressLine1, city: lease.building.city },
      kind,
      action: 'MOVE',
      scheduledOn: wanted.scheduledOn,
      inspectionId,
      detail,
    };
  }

  /** The lease no longer asks for it: the inspection booked from it is cancelled, with the reason. */
  private async callOff(
    input: { organizationId: string; lease: LeaseRow; dates: LeaseDates; kind: LeaseInspectionKind; dryRun: boolean },
    row: ScheduleRow,
    inspectionId: string,
  ): Promise<LeaseScheduleChange> {
    const { organizationId, lease, dates, kind, dryRun } = input;
    const reason =
      kind === 'MOVE_IN' && !tenantIsLeaving(dates)
        ? 'The tenant is no longer leaving: the lease was renewed or the notice withdrawn.'
        : !dates.isActive
          ? 'The lease is no longer on Propertyware’s report.'
          : `The lease’s new dates put its ${LABEL[kind]} more than ${LEASE_INSPECTION_HORIZON_DAYS} days away; it is booked again nearer the time.`;
    if (!dryRun)
      await this.prisma.$transaction(async (tx) => {
        await tx.inspection.update({
          where: { id: inspectionId },
          data: { status: InspectionStatus.CANCELLED, cancelledAt: new Date(), cancellationReason: reason },
        });
        const current = await tx.inspectionAssignment.findFirst({ where: { inspectionId, isCurrent: true } });
        if (current)
          await tx.inspectionAssignment.update({
            where: { id: current.id },
            data: {
              isCurrent: false,
              status: 'UNASSIGNED',
              endedAt: new Date(),
              reason: `Inspection cancelled: ${reason}`,
            },
          });
        await tx.leaseScheduledInspection.update({
          where: { id: row.id },
          data: { outcome: LeaseInspectionOutcome.CALLED_OFF, detail: reason },
        });
        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: null,
            action: 'INSPECTION_CALLED_OFF_WITH_LEASE',
            entityType: 'Inspection',
            entityId: inspectionId,
            metadata: { leaseId: lease.id, kind, reason },
          },
        });
      });
    return {
      leaseId: lease.id,
      property: { id: lease.buildingId, address: lease.building.addressLine1, city: lease.building.city },
      kind,
      action: 'CALL_OFF',
      scheduledOn: day(row.scheduledOn)!,
      inspectionId,
      detail: reason,
    };
  }

  /** Who takes each kind: the technician marked on their planning profile, or nobody yet. */
  private async handlers(organizationId: string): Promise<Record<LeaseInspectionKind, string | null>> {
    const first = (flag: 'handlesMoveOuts' | 'handlesMoveIns') =>
      this.prisma.technicianPlanningProfile.findFirst({
        where: { organizationId, [flag]: true },
        orderBy: [{ tbpZoneOrder: 'asc' }, { technicianId: 'asc' }],
        select: { technicianId: true },
      });
    const [moveOuts, moveIns] = await Promise.all([first('handlesMoveOuts'), first('handlesMoveIns')]);
    return { MOVE_OUT: moveOuts?.technicianId ?? null, MOVE_IN: moveIns?.technicianId ?? null };
  }
}

/** What the office reads on the inspection about where it came from. */
function noteFor(kind: LeaseInspectionKind, wanted: DueInspection, lease: LeaseRow): string {
  const ends = day(lease.scheduledMoveOutDate) ?? day(lease.endDate);
  return kind === 'MOVE_OUT'
    ? `Booked from Propertyware: the tenancy ends ${ends ? spoken(ends) : 'soon'}, and its move-out is sixty days before.`
    : `Booked from Propertyware: the tenant is leaving, and the move-in is twenty-two days after they go, for the make-ready (due ${spoken(wanted.dueOn)}).`;
}
