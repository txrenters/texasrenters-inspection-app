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

/**
 * One technician's time at one property on one day: a single row.
 *
 * However often they walked out to the van and back, the office reads one
 * line per property -- the office, 2026-10-06, about a visit that showed as
 * four rows at one address. The stretches stay separate underneath, because
 * the minutes outside the circle are general time and not this property's;
 * the row is when they first arrived, when they last left, and how long of
 * that they were inside.
 */
export interface TimesheetVisit {
  /** Stable for a technician, a property and a day. */
  key: string;
  technicianId: string;
  technician: string;
  buildingId: string | null;
  /** The first visit booked there that day, which the time is filed under. */
  inspectionId: string | null;
  address: string | null;
  arrivedAt: string;
  leftAt: string;
  /** Inside the circle, added up. Never more than the time between the two above. */
  onsiteSeconds: number;
  quietSeconds: number;
  /** How many times they went in. One is the ordinary answer. */
  stays: number;
  /** What a correction of this row replaces. Sent back as they are. */
  segmentIds: string[];
  /** A person changed some of this; the trail will not take it back. */
  adjusted: boolean;
  /** Some of it was added by hand rather than read from the trail. */
  addedByHand: boolean;
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

    /**
     * No trail at all is not an answer, and nothing is written from it.
     *
     * The fixes are pruned after thirty days, and a day read again after that
     * would find nothing and conclude the technician never worked -- every
     * stretch on it deleted by the button meant to put it right. A day the
     * trail is silent for keeps whatever it already says.
     */
    if (!fixes.length)
      return {
        day,
        technicianId,
        changed: false,
        onsiteSeconds: 0,
        generalSeconds: 0,
        fixesRead: 0,
        fixesDiscarded: 0,
      };

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
   * What each technician worked on one Texas day, property by property.
   *
   * One day because the office settles it a day at a time, and a range made
   * the page fetch and draw a fortnight of stretches to look at one of them.
   * One row per property because that is how the office reads a visit: a
   * technician who stepped out to the van three times was at that house once,
   * and four rows at one address on one day read as four jobs.
   */
  async timesheet(user: AuthenticatedUser, query: { technicianId?: string; date: string }) {
    const { organizationId } = user;
    if (!DAY.test(query.date)) throw new ApplicationError(422, 'BAD_DATES', 'Give the day as YYYY-MM-DD.');
    const { start, end } = businessDayBounds(businessDayFromQuery(query.date));

    const segments = await this.prisma.timeSegment.findMany({
      where: {
        organizationId,
        startedAt: { gte: start, lt: end },
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
        technician: { select: { displayName: true } },
        building: { select: { addressLine1: true } },
        inspection: { select: { propertywareBuilding: { select: { addressLine1: true } } } },
      },
      orderBy: [{ technicianId: 'asc' }, { startedAt: 'asc' }],
    });

    const totals = new Map<string, TimesheetTotal>();
    const visits = new Map<string, TimesheetVisit>();
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
      total.totalSeconds += segment.durationSeconds;
      total.quietSeconds += segment.quietSeconds;
      // One figure for everything away from a property. `DRIVING` is only on
      // rows from before the day was read whole, and it belongs in here.
      if (segment.category !== 'ONSITE') {
        total.generalSeconds += segment.durationSeconds;
        continue;
      }
      total.onsiteSeconds += segment.durationSeconds;

      // The property, or the visit for a row from before stretches named one.
      const place = segment.buildingId ?? segment.inspectionId ?? segment.id;
      const key = `${segment.technicianId}:${place}:${query.date}`;
      const startedAt = segment.startedAt.toISOString();
      const endedAt = segment.endedAt.toISOString();
      const visit = visits.get(key);
      if (!visit) {
        visits.set(key, {
          key,
          technicianId: segment.technicianId,
          technician: segment.technician.displayName,
          buildingId: segment.buildingId,
          inspectionId: segment.inspectionId,
          address:
            segment.building?.addressLine1 ?? segment.inspection?.propertywareBuilding?.addressLine1 ?? null,
          arrivedAt: startedAt,
          leftAt: endedAt,
          onsiteSeconds: segment.durationSeconds,
          quietSeconds: segment.quietSeconds,
          stays: 1,
          segmentIds: [segment.id],
          adjusted: Boolean(segment.adjustedAt),
          addedByHand: segment.source === TimeSegmentSource.MANUAL,
        });
        continue;
      }
      // In time order, so the first row seen is the arrival -- but a corrected
      // stretch can end after a later one, so the departure is the latest end.
      if (endedAt > visit.leftAt) visit.leftAt = endedAt;
      visit.inspectionId ??= segment.inspectionId;
      visit.onsiteSeconds += segment.durationSeconds;
      visit.quietSeconds += segment.quietSeconds;
      visit.stays += 1;
      visit.segmentIds.push(segment.id);
      visit.adjusted ||= Boolean(segment.adjustedAt);
      visit.addedByHand ||= segment.source === TimeSegmentSource.MANUAL;
    }

    return {
      date: query.date,
      totals: [...totals.values()].sort((left, right) => right.totalSeconds - left.totalSeconds),
      visits: [...visits.values()].sort(
        (left, right) =>
          left.technician.localeCompare(right.technician) || left.arrivedAt.localeCompare(right.arrivedAt),
      ),
    };
  }

  /**
   * An administrator correcting a technician's time at one property.
   *
   * The timesheet shows a property once a day, so this corrects it once: every
   * stretch behind the row becomes one stretch, on site from `startedAt` to
   * `endedAt`, and the minutes the trail had called general time inside that
   * span are on site now -- that is what the person is saying.
   *
   * Nothing is overwritten without a record. The first stretch is kept and
   * changed; what the whole visit said before -- first arrival, last departure,
   * the minutes inside -- goes into `TimeAdjustment`; and the corrections any
   * of the others already carried are moved onto it before they go, so the
   * history of the row survives the row being merged. `adjustedAt` is what
   * makes the hours a person's: every later reading of the day works round
   * them, including the span they replaced, so the trail cannot put the old
   * minutes back.
   */
  async correctVisit(
    user: AuthenticatedUser,
    input: { segmentIds: string[]; startedAt: string; endedAt: string; reason: string },
  ) {
    const { organizationId } = user;
    const started = new Date(input.startedAt);
    const ended = new Date(input.endedAt);
    if (Number.isNaN(started.getTime()) || Number.isNaN(ended.getTime()))
      throw new ApplicationError(422, 'BAD_TIMES', 'Give both ends as timestamps.');
    if (ended <= started)
      throw new ApplicationError(422, 'BAD_RANGE', 'The time at a property has to end after it starts.');
    const ids = [...new Set(input.segmentIds)];

    const gone = () =>
      new ApplicationError(
        404,
        'SEGMENT_NOT_FOUND',
        'This visit has changed since the page was loaded. Refresh the page and correct it from there.',
      );

    // Which technician and day, to queue behind any reading of that day.
    const first = await this.prisma.timeSegment.findFirst({
      where: { id: { in: ids }, organizationId },
      select: { technicianId: true, startedAt: true },
      orderBy: { startedAt: 'asc' },
    });
    if (!first) throw gone();
    const day = businessDate(first.startedAt);

    /**
     * Inside the same queue as the sweep. A reading that ran between finding
     * the stretches and replacing them could lengthen one of them, or delete
     * it, and the correction would be made to a visit that no longer exists.
     */
    const result = await this.oneAtATime(`${organizationId}:${first.technicianId}:${day}`, async () => {
      const segments = await this.prisma.timeSegment.findMany({
        where: { id: { in: ids }, organizationId },
        select: {
          id: true,
          technicianId: true,
          category: true,
          buildingId: true,
          inspectionId: true,
          startedAt: true,
          endedAt: true,
          durationSeconds: true,
        },
        orderBy: { startedAt: 'asc' },
      });
      if (segments.length !== ids.length) throw gone();
      const place = (segment: (typeof segments)[number]) => segment.buildingId ?? segment.inspectionId ?? segment.id;
      if (
        segments.some(
          (segment) =>
            segment.category !== 'ONSITE' ||
            segment.technicianId !== first.technicianId ||
            place(segment) !== place(segments[0]!),
        )
      )
        throw new ApplicationError(
          422,
          'NOT_ONE_VISIT',
          'Those stretches are not one technician’s time at one property.',
        );

      const [keep, ...others] = segments as [(typeof segments)[number], ...typeof segments];
      const before = {
        startedAt: keep.startedAt,
        endedAt: new Date(Math.max(...segments.map((segment) => segment.endedAt.getTime()))),
        durationSeconds: segments.reduce((sum, segment) => sum + segment.durationSeconds, 0),
      };
      const durationSeconds = Math.round((ended.getTime() - started.getTime()) / 1000);

      const updated = await this.prisma.$transaction(async (tx) => {
        if (others.length) {
          const otherIds = others.map((segment) => segment.id);
          await tx.timeAdjustment.updateMany({
            where: { organizationId, segmentId: { in: otherIds } },
            data: { segmentId: keep.id },
          });
          await tx.timeSegment.deleteMany({ where: { organizationId, id: { in: otherIds } } });
        }
        await tx.timeAdjustment.create({
          data: {
            organizationId,
            segmentId: keep.id,
            adminId: user.id,
            beforeStartedAt: before.startedAt,
            beforeEndedAt: before.endedAt,
            beforeDurationSeconds: before.durationSeconds,
            afterStartedAt: started,
            afterEndedAt: ended,
            afterDurationSeconds: durationSeconds,
            reason: input.reason.trim(),
          },
        });
        return tx.timeSegment.update({
          where: { id: keep.id },
          data: {
            startedAt: started,
            endedAt: ended,
            durationSeconds,
            // A person's answer, not a reading through a silence.
            quietSeconds: 0,
            adjustedAt: new Date(),
          },
          select: { id: true, startedAt: true, endedAt: true, durationSeconds: true },
        });
      });

      await this.prisma.auditLog.create({
        data: {
          organizationId,
          ...auditActor(user),
          action: 'TIME_VISIT_CORRECTED',
          entityType: 'TimeSegment',
          entityId: keep.id,
          // The change in seconds, not the reason: the reason belongs to the
          // technician as much as the office and lives on the adjustment itself.
          metadata: {
            beforeSeconds: before.durationSeconds,
            afterSeconds: durationSeconds,
            stretchesMerged: segments.length,
          },
        },
      });

      /**
       * The day is read again straight away, still in the queue.
       *
       * The corrected span may now cover minutes the trail had called general
       * time, or another property's, and those rows have to give way or the
       * minutes are counted twice. A failure here does not fail the
       * correction: that is already saved, and the sweep reads today again
       * within minutes.
       */
      await this.readDay(organizationId, first.technicianId, day, user).catch((error: unknown) =>
        this.logger.warn({
          event: 'time_day_not_recomputed_after_correction',
          segmentId: keep.id,
          day,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return updated;
    });

    // A correction moved onto another day leaves that day to be read too.
    for (const other of new Set([businessDate(started), businessDate(ended)]))
      if (other !== day)
        await this.recomputeDay(organizationId, first.technicianId, other, user).catch((error: unknown) =>
          this.logger.warn({
            event: 'time_day_not_recomputed_after_correction',
            segmentId: result.id,
            day: other,
            message: error instanceof Error ? error.message : String(error),
          }),
        );

    return {
      id: result.id,
      startedAt: result.startedAt.toISOString(),
      endedAt: result.endedAt.toISOString(),
      durationSeconds: result.durationSeconds,
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
