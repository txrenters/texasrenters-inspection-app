import { Inject, Injectable, Logger } from '@nestjs/common';
import { TimeSegmentSource } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import {
  MAX_USEFUL_ACCURACY_M,
  SEGMENT_DEFAULTS,
  type DayFence,
  type SegmentFix,
  computeDayLedger,
  withoutIntervals,
} from '@texasrenters/shared';

import { type AuthenticatedUser, auditActor } from '../common/auth';
import { businessDate, businessDayBounds, businessDayFromQuery } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

/** One technician's row on a timesheet: the totals payroll reads. */
export interface TimesheetTotal {
  technicianId: string;
  technician: string;
  /** Inside the circle of a property they had a visit at that day. */
  onsiteSeconds: number;
  /** Everything else between the first arrival and the last departure. */
  generalSeconds: number;
  /** The two together: the working day, with no hole in it. */
  totalSeconds: number;
  /**
   * How much of the total the phone was silent for.
   *
   * Inside the hours, not beside them -- the office decided on 2026-10-06 that
   * a quiet phone does not stop the clock. Reported so that hours which were
   * carried through a silence can be told from hours that were measured.
   */
  quietSeconds: number;
}

/** What reading one technician's day did. */
export interface DayRecompute {
  day: string;
  technicianId: string;
  /** False when the day already said exactly this, and nothing was written. */
  changed: boolean;
  onsiteSeconds: number;
  generalSeconds: number;
  fixesRead: number;
  fixesDiscarded: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reading a technician's trail as the hours of their day.
 *
 * Derived, and re-derivable. Nothing here is the only copy of anything: the
 * fixes in `TechnicianLocationPing` remain the record and this is a reading of
 * them, so a corrected property pin or a changed rule fixes last week's
 * timesheet rather than only next week's. Reading a day again replaces what
 * the last reading wrote for it, which is why it can be run as often as
 * anybody likes.
 *
 * **Start job and End job play no part.** The office was explicit on
 * 2026-10-06: a technician looks round a property before pressing Start and
 * does not always press End when they leave, so the buttons cannot be what
 * somebody is paid from. Neither timestamp is read anywhere in this file. A
 * visit is on a technician's day because it is booked for that day or was
 * worked on it, and the hours come from where the phone was.
 *
 * The arithmetic itself is `computeDayLedger` in shared. This service is what
 * feeds it -- which properties count, which fixes -- and what decides how its
 * answer is written down without disturbing an hour a person has decided.
 */
@Injectable()
export class TimeTrackingService {
  private readonly logger = new Logger(TimeTrackingService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * The most days one request may read again.
   *
   * A month, because the trail is kept for thirty days and there is nothing
   * older to read. Each day is a query for its fixes, so an unbounded range
   * would be a request that runs for minutes and times out having done some
   * unknowable part of the work.
   */
  static readonly MAX_RANGE_DAYS = 31;

  /**
   * One reading of a technician's day at a time.
   *
   * A day is read when a technician submits, again by the sweep every few
   * minutes, and whenever the office asks. Two of those at once would each
   * look at what is stored, each decide what to add, and both add it -- the
   * same hour on the timesheet twice. So readings of one technician's day
   * queue behind each other here.
   *
   * In this process, which is the only one there is: the backend runs as a
   * single container. If that ever changes, the write below still mends
   * itself -- a row the day does not call for is removed by the next reading
   * -- but two instances could disagree for the minutes in between.
   */
  private readonly reading = new Map<string, Promise<unknown>>();

  private oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
    const before = this.reading.get(key) ?? Promise.resolve();
    const mine = before.then(run, run);
    this.reading.set(key, mine);
    const done = () => {
      if (this.reading.get(key) === mine) this.reading.delete(key);
    };
    mine.then(done, done);
    return mine;
  }

  /**
   * Read one technician's day from the trail, and store it.
   *
   * `day` is a Texas calendar day. `actor` is null when nobody asked -- a
   * submission, or the sweep -- and the audit says which it was: two null
   * actor columns already mean "no person", but they mean that for an
   * anonymous write too, and on a table these hours are paid from the
   * difference between "somebody asked" and "it simply happened" is the point
   * of auditing at all.
   */
  recomputeDay(
    organizationId: string,
    technicianId: string,
    day: string,
    actor: AuthenticatedUser | null,
  ): Promise<DayRecompute> {
    if (!DAY.test(day)) throw new ApplicationError(422, 'BAD_DATES', 'Give the day as YYYY-MM-DD.');
    return this.oneAtATime(`${organizationId}:${technicianId}:${day}`, () =>
      this.readDay(organizationId, technicianId, day, actor),
    );
  }

  /**
   * The same reading, for a caller with nothing to do about a failure.
   *
   * A submission must not fail because its hours could not be read, and a
   * sweep that threw on one technician would stop reading everybody after
   * them. Reported, and null handed back so the caller can count it.
   */
  async recomputeDayAutomatically(
    organizationId: string,
    technicianId: string,
    day: string = businessDate(),
  ): Promise<DayRecompute | null> {
    try {
      return await this.recomputeDay(organizationId, technicianId, day, null);
    } catch (error) {
      this.logger.warn({
        event: 'time_day_not_recomputed',
        technicianId,
        day,
        reason: error instanceof ApplicationError ? error.code : 'UNEXPECTED',
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async readDay(
    organizationId: string,
    technicianId: string,
    day: string,
    actor: AuthenticatedUser | null,
  ): Promise<DayRecompute> {
    const { start, end } = businessDayBounds(businessDayFromQuery(day));

    /**
     * The properties whose circles count today.
     *
     * Only the ones this technician has a visit at -- the office's decision.
     * Any of 589 circles would start the clock for somebody waiting at a red
     * light outside a house we happen to manage. A visit is "today's" when it
     * is booked for today or was worked today: the second half is for the job
     * done a day early or late, which is still where the technician was.
     *
     * `startedAt` and `submittedAt` are read here to find which day a visit
     * fell on, and for nothing else. They are never the hours.
     */
    const visits = await this.prisma.inspection.findMany({
      where: {
        organizationId,
        propertywareBuildingId: { not: null },
        assignments: { some: { isCurrent: true, technicianId } },
        OR: [
          { scheduledAt: { gte: start, lt: end } },
          { startedAt: { gte: start, lt: end } },
          { submittedAt: { gte: start, lt: end } },
        ],
      },
      select: {
        id: true,
        propertywareBuilding: {
          select: {
            id: true,
            latitude: true,
            longitude: true,
            geofence: {
              select: { latitude: true, longitude: true, enterRadiusMeters: true, exitRadiusMeters: true },
            },
          },
        },
      },
      // The first visit at a building is the one its on-site time is filed
      // under, so the order has to be the same on every reading.
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    });

    const fences = new Map<string, DayFence>();
    const visitAt = new Map<string, string>();
    for (const visit of visits) {
      const fence = this.fenceFor(visit.propertywareBuilding);
      if (!fence || fences.has(fence.id)) continue;
      fences.set(fence.id, fence);
      visitAt.set(fence.id, visit.id);
    }

    const fixes = await this.fixesIn(organizationId, technicianId, start, end);
    const ledger = computeDayLedger(fixes, [...fences.values()]);

    const scope = { organizationId, technicianId };
    const [kept, stored] = await Promise.all([
      // Hours a person has decided: a correction, or time credited by hand.
      // Anything that touches the day, not only what starts in it -- and a
      // correction touches the day if what it replaced did.
      this.prisma.timeSegment.findMany({
        where: {
          ...scope,
          AND: [
            { OR: [{ source: TimeSegmentSource.MANUAL }, { adjustedAt: { not: null } }] },
            {
              OR: [
                { startedAt: { lt: end }, endedAt: { gt: start } },
                { adjustments: { some: { beforeStartedAt: { lt: end }, beforeEndedAt: { gt: start } } } },
              ],
            },
          ],
        },
        select: {
          startedAt: true,
          endedAt: true,
          adjustments: { select: { beforeStartedAt: true, beforeEndedAt: true } },
        },
      }),
      this.prisma.timeSegment.findMany({
        where: {
          ...scope,
          source: TimeSegmentSource.AUTOMATIC,
          adjustedAt: null,
          startedAt: { gte: start, lt: end },
        },
        select: {
          id: true,
          category: true,
          buildingId: true,
          inspectionId: true,
          startedAt: true,
          endedAt: true,
          durationSeconds: true,
          quietSeconds: true,
        },
      }),
    ]);

    /**
     * What the trail says, less what a person has already said.
     *
     * The first version spared a corrected row from deletion and then wrote
     * the trail's own version of the same hour beside it, so one correction
     * followed by one recompute paid the hour twice. Cutting the decided
     * intervals out of the answer is what stops that.
     *
     * What a correction replaced is cut out as well as what it says now. An
     * administrator who shortens a visit from an hour to half is saying the
     * technician was not working for the other half; the trail still says
     * they were, and would write the half hour straight back.
     */
    const decided = kept.flatMap((row) => [
      { startedAt: row.startedAt.getTime(), endedAt: row.endedAt.getTime() },
      ...row.adjustments.map((was) => ({
        startedAt: was.beforeStartedAt.getTime(),
        endedAt: was.beforeEndedAt.getTime(),
      })),
    ]);
    const wanted = withoutIntervals(ledger.stretches, decided).map((stretch) => ({
      category: stretch.category,
      buildingId: stretch.fenceId,
      inspectionId: stretch.fenceId ? (visitAt.get(stretch.fenceId) ?? null) : null,
      startedAt: new Date(stretch.startedAt),
      endedAt: new Date(stretch.endedAt),
      durationSeconds: stretch.durationSeconds,
      quietSeconds: stretch.quietSeconds,
    }));

    /**
     * Written as a difference, not as delete-everything-and-insert.
     *
     * Today is read every few minutes while the technician is still out, and
     * almost all of it is the same each time: the visits already finished have
     * not moved, and the one in progress has only grown. Replacing every row
     * would give every stretch a new id on every reading, and the office
     * correcting a stretch would find it gone between opening the dialog and
     * saving it. So a stretch that is still there keeps its row, one that grew
     * is updated, and only what the day no longer calls for is removed --
     * which is also what removes the rows the per-job reading left behind,
     * and any duplicate a second writer might ever leave.
     */
    const spare = [...stored];
    const creates: typeof wanted = [];
    const updates: { id: string; data: Omit<(typeof wanted)[number], 'category' | 'buildingId' | 'startedAt'> }[] = [];
    for (const row of wanted) {
      const index = spare.findIndex(
        (old) =>
          old.category === row.category &&
          old.buildingId === row.buildingId &&
          old.startedAt.getTime() === row.startedAt.getTime(),
      );
      if (index === -1) {
        creates.push(row);
        continue;
      }
      const [old] = spare.splice(index, 1);
      if (
        old!.endedAt.getTime() !== row.endedAt.getTime() ||
        old!.durationSeconds !== row.durationSeconds ||
        old!.quietSeconds !== row.quietSeconds ||
        old!.inspectionId !== row.inspectionId
      )
        updates.push({
          id: old!.id,
          data: {
            inspectionId: row.inspectionId,
            endedAt: row.endedAt,
            durationSeconds: row.durationSeconds,
            quietSeconds: row.quietSeconds,
          },
        });
    }

    /**
     * The per-job reading listed every silence as a question for the office.
     * A silence is counted now, so an open question about this day has been
     * answered and is removed. One somebody settled is their decision and
     * stays, as does any time they credited for it.
     */
    const openGaps = await this.prisma.trackingGap.count({
      where: { ...scope, resolvedAt: null, startedAt: { gte: start, lt: end } },
    });

    const changed = Boolean(spare.length || updates.length || creates.length || openGaps);
    const onsiteSeconds = wanted
      .filter((row) => row.category === 'ONSITE')
      .reduce((sum, row) => sum + row.durationSeconds, 0);
    const generalSeconds = wanted
      .filter((row) => row.category === 'GENERAL')
      .reduce((sum, row) => sum + row.durationSeconds, 0);
    const result: DayRecompute = {
      day,
      technicianId,
      changed,
      onsiteSeconds,
      generalSeconds,
      fixesRead: fixes.length,
      fixesDiscarded: ledger.discardedFixes,
    };
    // Nothing to say, so nothing is written -- not the rows, and not an audit
    // entry for a reading that changed nobody's hours.
    if (!changed) return result;

    await this.prisma.$transaction(async (tx) => {
      if (spare.length)
        await tx.timeSegment.deleteMany({ where: { ...scope, id: { in: spare.map((old) => old.id) } } });
      for (const update of updates)
        await tx.timeSegment.update({ where: { id: update.id }, data: update.data });
      if (creates.length)
        await tx.timeSegment.createMany({ data: creates.map((row) => ({ ...scope, ...row })) });
      if (openGaps)
        await tx.trackingGap.deleteMany({
          where: { ...scope, resolvedAt: null, startedAt: { gte: start, lt: end } },
        });
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId,
        ...(actor ? auditActor(actor) : { actorUserId: null, actorApiClientId: null }),
        action: actor ? 'TIME_DAY_RECOMPUTED' : 'TIME_DAY_RECOMPUTED_AUTOMATICALLY',
        entityType: 'UserProfile',
        entityId: technicianId,
        // Counts and durations only: never the coordinates themselves.
        metadata: {
          day,
          onsiteSeconds,
          generalSeconds,
          quietSeconds: wanted.reduce((sum, row) => sum + row.quietSeconds, 0),
          stretches: wanted.length,
          properties: fences.size,
          fixesRead: fixes.length,
          fixesDiscarded: ledger.discardedFixes,
        },
      },
    });

    this.logger.log(
      `Day ${day} read for technician ${technicianId}: ${Math.round(onsiteSeconds / 60)} min on site, ` +
        `${Math.round(generalSeconds / 60)} min general, from ${fixes.length} fixes at ${fences.size} properties.`,
    );

    return result;
  }

  /**
   * Read every technician's days in a range again.
   *
   * The office's button. It is how a change of rule reaches days already on
   * the timesheet -- the 20 m circle, on the day this was written -- and how a
   * corrected property pin does. Hours somebody corrected by hand are left
   * exactly as they are; everything else in the range is whatever the trail
   * says now.
   */
  async recalculate(user: AuthenticatedUser, query: { from: string; to: string }) {
    const { organizationId } = user;
    const { from, to } = this.rangeFor(query);
    const days = this.daysIn(query.from, query.to);
    if (days.length > TimeTrackingService.MAX_RANGE_DAYS)
      throw new ApplicationError(
        422,
        'RANGE_TOO_LONG',
        `Recalculate up to ${TimeTrackingService.MAX_RANGE_DAYS} days at a time.`,
      );

    // Anybody with a trail in the range, and anybody with hours in it: the
    // second is how hours whose trail has since been pruned are not skipped
    // in silence, and how the rows of an earlier rule are cleared away.
    const [tracked, timed] = await Promise.all([
      this.prisma.technicianLocationPing.groupBy({
        by: ['technicianId'],
        where: { organizationId, recordedAt: { gte: from, lt: to } },
      }),
      this.prisma.timeSegment.groupBy({
        by: ['technicianId'],
        where: { organizationId, startedAt: { gte: from, lt: to } },
      }),
    ]);
    const technicians = [...new Set([...tracked, ...timed].map((row) => row.technicianId))];

    let changed = 0;
    for (const technicianId of technicians)
      for (const day of days) {
        // Sequential on purpose: this shares a database with the handsets
        // reporting their positions, which is the one thing that cannot wait.
        const result = await this.recomputeDay(organizationId, technicianId, day, user);
        if (result.changed) changed += 1;
      }

    return { days: days.length, technicians: technicians.length, changed };
  }

  /**
   * A pair of Texas calendar days as the instants either side of them.
   *
   * Texas days, because that is the day a technician works: read as UTC days,
   * an evening visit landed on the following day's timesheet.
   */
  private rangeFor(query: { from: string; to: string }) {
    if (!DAY.test(query.from) || !DAY.test(query.to))
      throw new ApplicationError(422, 'BAD_DATES', 'Give the dates as YYYY-MM-DD.');
    if (query.to < query.from) throw new ApplicationError(422, 'BAD_RANGE', 'The last day is before the first.');
    return {
      from: businessDayBounds(businessDayFromQuery(query.from)).start,
      to: businessDayBounds(businessDayFromQuery(query.to)).end,
    };
  }

  /** Every calendar day from one to another, both included. */
  private daysIn(from: string, to: string): string[] {
    const days: string[] = [];
    // Noon, so that adding a day's worth of milliseconds cannot land on the
    // wrong date whatever the clocks did that night.
    for (let at = Date.parse(`${from}T12:00:00.000Z`); at <= Date.parse(`${to}T12:00:00.000Z`); at += 86_400_000)
      days.push(new Date(at).toISOString().slice(0, 10));
    return days;
  }

  /**
   * What each technician worked over a stretch of days, and where it came from.
   *
   * The number payroll uses, and the working that produced it, in one answer --
   * somebody paid from a total must be able to see the stretches behind it
   * without having to ask.
   */
  async timesheet(user: AuthenticatedUser, query: { technicianId?: string; from: string; to: string }) {
    const { organizationId } = user;
    const { from, to } = this.rangeFor(query);

    const segments = await this.prisma.timeSegment.findMany({
      where: {
        organizationId,
        startedAt: { gte: from, lt: to },
        ...(query.technicianId ? { technicianId: query.technicianId } : {}),
      },
      select: {
        id: true,
        technicianId: true,
        inspectionId: true,
        buildingId: true,
        category: true,
        startedAt: true,
        endedAt: true,
        durationSeconds: true,
        quietSeconds: true,
        source: true,
        adjustedAt: true,
        flag: true,
        technician: { select: { displayName: true } },
        building: { select: { addressLine1: true } },
        inspection: { select: { propertywareBuilding: { select: { addressLine1: true } } } },
      },
      orderBy: [{ technicianId: 'asc' }, { startedAt: 'asc' }],
    });

    // Totalled per technician, because that is the shape a payroll run needs.
    const totals = new Map<string, TimesheetTotal>();
    for (const segment of segments) {
      const total = totals.get(segment.technicianId) ?? {
        technicianId: segment.technicianId,
        technician: segment.technician.displayName,
        onsiteSeconds: 0,
        generalSeconds: 0,
        totalSeconds: 0,
        quietSeconds: 0,
      };
      totals.set(segment.technicianId, total);
      // One figure for everything away from a property. `DRIVING` is only on
      // rows from before the day was read whole, and it belongs in here.
      if (segment.category === 'ONSITE') total.onsiteSeconds += segment.durationSeconds;
      else total.generalSeconds += segment.durationSeconds;
      total.totalSeconds += segment.durationSeconds;
      total.quietSeconds += segment.quietSeconds;
    }

    return {
      from: query.from,
      to: query.to,
      totals: [...totals.values()].sort((left, right) => right.totalSeconds - left.totalSeconds),
      segments: segments.map((segment) => ({
        id: segment.id,
        technicianId: segment.technicianId,
        technician: segment.technician.displayName,
        inspectionId: segment.inspectionId,
        address:
          segment.building?.addressLine1 ?? segment.inspection?.propertywareBuilding?.addressLine1 ?? null,
        category: segment.category === 'ONSITE' ? ('ONSITE' as const) : ('GENERAL' as const),
        startedAt: segment.startedAt.toISOString(),
        endedAt: segment.endedAt.toISOString(),
        durationSeconds: segment.durationSeconds,
        quietSeconds: segment.quietSeconds,
        source: segment.source,
        adjusted: Boolean(segment.adjustedAt),
        flag: segment.flag,
      })),
    };
  }

  /**
   * An administrator correcting a segment, with the original kept.
   *
   * The correction is written to the segment and the previous value into
   * `TimeAdjustment` -- never over the top of it -- so the difference between
   * "the trail said this" and "a person decided this" survives. `adjustedAt` is
   * what makes the hour theirs: every later reading of the day works round it.
   */
  async adjustSegment(
    user: AuthenticatedUser,
    segmentId: string,
    input: { startedAt: string; endedAt: string; reason: string },
  ) {
    const { organizationId } = user;
    const started = new Date(input.startedAt);
    const ended = new Date(input.endedAt);
    if (Number.isNaN(started.getTime()) || Number.isNaN(ended.getTime()))
      throw new ApplicationError(422, 'BAD_TIMES', 'Give both ends as timestamps.');
    if (ended <= started)
      throw new ApplicationError(422, 'BAD_RANGE', 'A segment has to end after it starts.');

    const segment = await this.prisma.timeSegment.findFirst({
      where: { id: segmentId, organizationId },
      select: { id: true, technicianId: true, startedAt: true, endedAt: true, durationSeconds: true },
    });
    if (!segment)
      throw new ApplicationError(
        404,
        'SEGMENT_NOT_FOUND',
        'That stretch is no longer on the timesheet. Refresh the page and correct it from there.',
      );

    const durationSeconds = Math.round((ended.getTime() - started.getTime()) / 1000);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.timeAdjustment.create({
        data: {
          organizationId,
          segmentId,
          adminId: user.id,
          beforeStartedAt: segment.startedAt,
          beforeEndedAt: segment.endedAt,
          beforeDurationSeconds: segment.durationSeconds,
          afterStartedAt: started,
          afterEndedAt: ended,
          afterDurationSeconds: durationSeconds,
          reason: input.reason.trim(),
        },
      });
      return tx.timeSegment.update({
        where: { id: segmentId },
        data: { startedAt: started, endedAt: ended, durationSeconds, adjustedAt: new Date() },
        select: { id: true, startedAt: true, endedAt: true, durationSeconds: true },
      });
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId,
        ...auditActor(user),
        action: 'TIME_SEGMENT_ADJUSTED',
        entityType: 'TimeSegment',
        entityId: segmentId,
        // The change in seconds, not the reason: the reason belongs to the
        // technician as much as the office and lives on the adjustment itself.
        metadata: { beforeSeconds: segment.durationSeconds, afterSeconds: durationSeconds },
      },
    });

    /**
     * The days either end of the correction touches are read again.
     *
     * A stretch made longer now covers minutes the trail had called something
     * else, and those rows have to give way or the minutes are counted twice.
     * Asked for by this person, so it is theirs in the audit. A failure here
     * does not fail the correction: that is already saved, and the sweep
     * reads today again within minutes.
     */
    const days = new Set(
      [segment.startedAt, segment.endedAt, started, ended].map((instant) => businessDate(instant)),
    );
    for (const day of days)
      await this.recomputeDay(organizationId, segment.technicianId, day, user).catch((error: unknown) =>
        this.logger.warn({
          event: 'time_day_not_recomputed_after_correction',
          segmentId,
          day,
          message: error instanceof Error ? error.message : String(error),
        }),
      );

    return {
      id: updated.id,
      startedAt: updated.startedAt.toISOString(),
      endedAt: updated.endedAt.toISOString(),
      durationSeconds: updated.durationSeconds,
      adjusted: true,
    };
  }

  /**
   * Where a property's circle is, and how big.
   *
   * The building's own pin unless a geofence row overrides it. A handful of
   * properties are not rooftop-geocoded, and for those the override is the
   * only way to get an honest answer -- so it is a separate row rather than a
   * correction to the building, which the map and the routing also read.
   */
  private fenceFor(
    building: {
      id: string;
      latitude: Prisma.Decimal | null;
      longitude: Prisma.Decimal | null;
      geofence: {
        latitude: Prisma.Decimal | null;
        longitude: Prisma.Decimal | null;
        enterRadiusMeters: number;
        exitRadiusMeters: number;
      } | null;
    } | null,
  ): DayFence | null {
    if (!building) return null;
    const latitude = building.geofence?.latitude ?? building.latitude;
    const longitude = building.geofence?.longitude ?? building.longitude;
    if (!latitude || !longitude) return null;
    return {
      id: building.id,
      latitude: Number(latitude),
      longitude: Number(longitude),
      enterRadiusMeters: building.geofence?.enterRadiusMeters ?? SEGMENT_DEFAULTS.enterRadiusMeters,
      exitRadiusMeters: building.geofence?.exitRadiusMeters ?? SEGMENT_DEFAULTS.exitRadiusMeters,
    };
  }

  private async fixesIn(
    organizationId: string,
    technicianId: string,
    from: Date,
    to: Date,
  ): Promise<SegmentFix[]> {
    const pings = await this.prisma.technicianLocationPing.findMany({
      where: {
        organizationId,
        technicianId,
        recordedAt: { gte: from, lt: to },
        // The engine gates on accuracy itself, and far more tightly. This only
        // keeps the obviously useless out of the query.
        OR: [{ accuracyMeters: null }, { accuracyMeters: { lte: MAX_USEFUL_ACCURACY_M } }],
      },
      select: { latitude: true, longitude: true, accuracyMeters: true, recordedAt: true },
      orderBy: { recordedAt: 'asc' },
    });
    return pings.map((ping) => ({
      latitude: Number(ping.latitude),
      longitude: Number(ping.longitude),
      accuracyMeters: ping.accuracyMeters,
      at: ping.recordedAt.getTime(),
    }));
  }
}
