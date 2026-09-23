import { Inject, Injectable, Logger } from '@nestjs/common';
import { TimeSegmentSource } from '@prisma/client';
import type { Prisma, TimeSegmentCategory } from '@prisma/client';
import {
  MAX_USEFUL_ACCURACY_M,
  SEGMENT_DEFAULTS,
  type SegmentFix,
  type SegmentGeofence,
  computeSegments,
} from '@texasrenters/shared';

import { type AuthenticatedUser, auditActor } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

/** One technician's row on a timesheet: the totals payroll reads. */
export interface TimesheetTotal {
  technicianId: string;
  technician: string;
  onsiteSeconds: number;
  drivingSeconds: number;
  generalSeconds: number;
  /**
   * Time the trail could not account for and nobody has settled.
   *
   * Beside the totals rather than inside them. It is not hours worked and it is
   * not hours not worked -- it is a question, and a timesheet that hides it
   * pays somebody the wrong amount quietly.
   */
  unsettledGapSeconds: number;
}

/**
 * Reading a technician's trail as the time a job took.
 *
 * Derived, and re-derivable. Nothing here is the only copy of anything: the
 * fixes in `TechnicianLocationPing` remain the record and this is a reading of
 * them, so a corrected property pin or a changed rule fixes last week's
 * invoice rather than only next week's. Every recompute replaces what the last
 * one wrote for that job, which is why it can be run as often as anybody likes.
 *
 * The arithmetic itself is `computeSegments` in shared -- the same function the
 * phone runs, so a technician watching their own screen and the office reading
 * the invoice are looking at one rule rather than two implementations of it.
 * This service is what feeds it, and what decides which of its answers belong
 * to which job.
 */
@Injectable()
export class TimeTrackingService {
  private readonly logger = new Logger(TimeTrackingService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * The trail either side of the visit.
   *
   * Two hours, because the question is when the technician arrived and left,
   * and both of those happen outside whatever the job's own timestamps claim --
   * which is the whole reason for replacing them. Wide enough to catch an
   * arrival well before Start job was pressed; narrow enough that one day's
   * fixes do not become every job's.
   */
  private static readonly WINDOW_MS = 2 * 60 * 60 * 1000;

  /**
   * Recompute one job's segments from the trail, and store them.
   *
   * Returns what it found rather than only writing it, so a caller can show the
   * office the difference between this and the buttons without a second query.
   */
  async recomputeForInspection(user: AuthenticatedUser, inspectionId: string) {
    const { organizationId } = user;
    const inspection = await this.prisma.inspection.findFirst({
      where: { id: inspectionId, organizationId },
      select: {
        id: true,
        startedAt: true,
        submittedAt: true,
        scheduledAt: true,
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
        assignments: { where: { isCurrent: true }, select: { technicianId: true }, take: 1 },
      },
    });
    if (!inspection) throw new ApplicationError(404, 'INSPECTION_NOT_FOUND', 'That job does not exist.');

    const geofence = this.geofenceFor(inspection.propertywareBuilding);
    if (!geofence)
      throw new ApplicationError(
        409,
        'NO_PROPERTY_LOCATION',
        'This job’s property has no coordinates, so its time cannot be measured. Correct the pin first.',
      );

    const technicianId = inspection.assignments[0]?.technicianId;
    if (!technicianId)
      throw new ApplicationError(
        409,
        'NO_TECHNICIAN',
        'This job has nobody assigned, so there is no trail to read.',
      );

    const window = this.windowFor(inspection);
    const fixes = await this.fixesIn(organizationId, technicianId, window);
    const result = computeSegments(fixes, geofence);

    /**
     * Which of the answers belong to this job.
     *
     * The on-site ones plainly do. Off-site time is harder: a technician
     * driving between two properties is driving for both and neither, and
     * answering that properly needs the whole day's schedule rather than one
     * job. So only the off-site stretches that sit **between** two of this
     * job's own on-site segments are attributed here -- the property, the
     * supplier, the property again, which is the case the office described.
     *
     * Travel before the first arrival and after the last departure is left
     * unattributed rather than guessed at. It is recorded in the trail and can
     * be attributed later by something that knows the day; inventing an answer
     * now would put somebody else's driving on this invoice.
     */
    const onsite = result.segments.filter((segment) => segment.category === 'ONSITE');
    const firstArrival = onsite[0]?.startedAt;
    const lastDeparture = onsite[onsite.length - 1]?.endedAt;
    const mine = result.segments.filter((segment) =>
      segment.category === 'ONSITE'
        ? true
        : firstArrival !== undefined &&
          lastDeparture !== undefined &&
          segment.startedAt >= firstArrival &&
          segment.endedAt <= lastDeparture,
    );

    const gaps = result.gaps.filter(
      (gap) =>
        firstArrival === undefined ||
        lastDeparture === undefined ||
        (gap.endedAt >= firstArrival && gap.startedAt <= lastDeparture),
    );

    await this.prisma.$transaction(async (tx) => {
      /**
       * Replaced, not merged.
       *
       * A recompute is the whole answer for this job, so anything the last one
       * wrote is stale by definition. Adjustments are deliberately spared: an
       * administrator who corrected a segment did so because the trail was
       * wrong, and re-deriving would undo their correction on the next run.
       */
      await tx.timeSegment.deleteMany({
        where: { inspectionId, organizationId, source: TimeSegmentSource.AUTOMATIC, adjustedAt: null },
      });
      if (mine.length)
        await tx.timeSegment.createMany({
          data: mine.map((segment) => ({
            organizationId,
            technicianId,
            inspectionId,
            category: segment.category as TimeSegmentCategory,
            startedAt: new Date(segment.startedAt),
            endedAt: new Date(segment.endedAt),
            durationSeconds: segment.durationSeconds,
          })),
        });

      // Gaps are re-derived the same way, and an unresolved one is not worth
      // keeping twice. One a person has already settled is left alone.
      await tx.trackingGap.deleteMany({ where: { inspectionId, organizationId, resolvedAt: null } });
      if (gaps.length)
        await tx.trackingGap.createMany({
          data: gaps.map((gap) => ({
            organizationId,
            technicianId,
            inspectionId,
            startedAt: new Date(gap.startedAt),
            endedAt: new Date(gap.endedAt),
            durationSeconds: gap.durationSeconds,
          })),
        });
    });

    const onsiteSeconds = mine
      .filter((segment) => segment.category === 'ONSITE')
      .reduce((sum, segment) => sum + segment.durationSeconds, 0);

    await this.prisma.auditLog.create({
      data: {
        organizationId,
        ...auditActor(user),
        action: 'TIME_SEGMENTS_RECOMPUTED',
        entityType: 'Inspection',
        entityId: inspectionId,
        // Counts and durations only: never the coordinates themselves.
        metadata: {
          segments: mine.length,
          onsiteSeconds,
          gaps: gaps.length,
          fixesRead: fixes.length,
          fixesDiscarded: result.discardedFixes,
        },
      },
    });

    this.logger.log(
      `Time segments recomputed for ${inspectionId}: ${mine.length} segments, ` +
        `${Math.round(onsiteSeconds / 60)} min on site, ${gaps.length} gaps, from ${fixes.length} fixes.`,
    );

    return {
      inspectionId,
      segments: mine,
      gaps,
      onsiteSeconds,
      fixesRead: fixes.length,
      fixesDiscarded: result.discardedFixes,
      /**
       * What the manual buttons said, for the same job.
       *
       * Returned beside the computed answer rather than replacing it, because
       * while both exist the office's first question about every job will be
       * why they differ -- and on the month measured they differed by 35%.
       */
      manualSeconds:
        inspection.startedAt && inspection.submittedAt
          ? Math.round((inspection.submittedAt.getTime() - inspection.startedAt.getTime()) / 1000)
          : null,
    };
  }

  /**
   * What a technician is owed for a stretch of days, and where it came from.
   *
   * The number payroll uses, and the working that produced it, in one answer --
   * somebody paid from a total must be able to see the visits behind it without
   * having to ask. Gaps come back beside the segments rather than folded into
   * them: an unsettled gap is time the trail could not account for, and a
   * timesheet that quietly omits it is the failure this feature exists to stop.
   */
  async timesheet(user: AuthenticatedUser, query: { technicianId?: string; from: string; to: string }) {
    const { organizationId } = user;
    const from = new Date(`${query.from}T00:00:00.000Z`);
    const to = new Date(`${query.to}T23:59:59.999Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
      throw new ApplicationError(422, 'BAD_DATES', 'Give the dates as YYYY-MM-DD.');
    if (to < from) throw new ApplicationError(422, 'BAD_RANGE', 'The last day is before the first.');

    const scope = query.technicianId ? { technicianId: query.technicianId } : {};
    const [segments, gaps] = await Promise.all([
      this.prisma.timeSegment.findMany({
        where: { organizationId, startedAt: { gte: from, lte: to }, ...scope },
        select: {
          id: true,
          technicianId: true,
          inspectionId: true,
          category: true,
          startedAt: true,
          endedAt: true,
          durationSeconds: true,
          source: true,
          adjustedAt: true,
          flag: true,
          technician: { select: { displayName: true } },
          inspection: {
            select: {
              inspectionType: true,
              propertywareBuilding: { select: { addressLine1: true } },
            },
          },
        },
        orderBy: [{ technicianId: 'asc' }, { startedAt: 'asc' }],
      }),
      this.prisma.trackingGap.findMany({
        where: { organizationId, startedAt: { gte: from, lte: to }, ...scope },
        select: {
          id: true,
          technicianId: true,
          inspectionId: true,
          startedAt: true,
          endedAt: true,
          durationSeconds: true,
          resolvedAt: true,
          resolution: true,
          technician: { select: { displayName: true } },
        },
        orderBy: { startedAt: 'asc' },
      }),
    ]);

    // Totalled per technician, because that is the shape a payroll run needs.
    const totals = new Map<string, TimesheetTotal>();
    const totalFor = (technicianId: string, displayName: string) => {
      const existing = totals.get(technicianId);
      if (existing) return existing;
      const fresh: TimesheetTotal = {
        technicianId,
        technician: displayName,
        onsiteSeconds: 0,
        drivingSeconds: 0,
        generalSeconds: 0,
        unsettledGapSeconds: 0,
      };
      totals.set(technicianId, fresh);
      return fresh;
    };

    for (const segment of segments) {
      const total = totalFor(segment.technicianId, segment.technician.displayName);
      if (segment.category === 'ONSITE') total.onsiteSeconds += segment.durationSeconds;
      else if (segment.category === 'DRIVING') total.drivingSeconds += segment.durationSeconds;
      else total.generalSeconds += segment.durationSeconds;
    }
    for (const gap of gaps)
      if (!gap.resolvedAt)
        totalFor(gap.technicianId, gap.technician.displayName).unsettledGapSeconds += gap.durationSeconds;

    return {
      from: query.from,
      to: query.to,
      totals: [...totals.values()].sort((left, right) => right.onsiteSeconds - left.onsiteSeconds),
      segments: segments.map((segment) => ({
        id: segment.id,
        technicianId: segment.technicianId,
        technician: segment.technician.displayName,
        inspectionId: segment.inspectionId,
        address: segment.inspection.propertywareBuilding?.addressLine1 ?? null,
        inspectionType: segment.inspection.inspectionType,
        category: segment.category,
        startedAt: segment.startedAt.toISOString(),
        endedAt: segment.endedAt.toISOString(),
        durationSeconds: segment.durationSeconds,
        source: segment.source,
        adjusted: Boolean(segment.adjustedAt),
        flag: segment.flag,
      })),
      gaps: gaps.map((gap) => ({
        id: gap.id,
        technicianId: gap.technicianId,
        technician: gap.technician.displayName,
        inspectionId: gap.inspectionId,
        startedAt: gap.startedAt.toISOString(),
        endedAt: gap.endedAt.toISOString(),
        durationSeconds: gap.durationSeconds,
        resolved: Boolean(gap.resolvedAt),
        resolution: gap.resolution,
      })),
    };
  }

  /**
   * An administrator correcting a segment, with the original kept.
   *
   * The correction is written to the segment and the previous value into
   * `TimeAdjustment` -- never over the top of it -- so the difference between
   * "the trail said this" and "a person decided this" survives. `adjustedAt` is
   * what stops the next recompute quietly undoing the decision.
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
      select: { id: true, startedAt: true, endedAt: true, durationSeconds: true },
    });
    if (!segment) throw new ApplicationError(404, 'SEGMENT_NOT_FOUND', 'That segment does not exist.');

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

    return {
      id: updated.id,
      startedAt: updated.startedAt.toISOString(),
      endedAt: updated.endedAt.toISOString(),
      durationSeconds: updated.durationSeconds,
      adjusted: true,
    };
  }

  /**
   * Settling a stretch the trail could not account for.
   *
   * With `creditedMinutes` the office is saying the work happened and the phone
   * missed it, so a segment is written for it -- `MANUAL`, so no later
   * recompute takes it away again. Without, the gap is marked seen and nothing
   * is added: a technician who was not working is owed nothing, and saying so
   * is better than leaving it open forever.
   */
  async resolveGap(
    user: AuthenticatedUser,
    gapId: string,
    input: { resolution: string; creditedMinutes?: number },
  ) {
    const { organizationId } = user;
    const gap = await this.prisma.trackingGap.findFirst({
      where: { id: gapId, organizationId },
      select: {
        id: true,
        technicianId: true,
        inspectionId: true,
        startedAt: true,
        endedAt: true,
        resolvedAt: true,
      },
    });
    if (!gap) throw new ApplicationError(404, 'GAP_NOT_FOUND', 'That tracking gap does not exist.');
    if (gap.resolvedAt) throw new ApplicationError(409, 'GAP_SETTLED', 'That gap has already been settled.');

    const credited = Math.max(0, Math.round(input.creditedMinutes ?? 0));
    if (credited && !gap.inspectionId)
      throw new ApplicationError(
        409,
        'GAP_HAS_NO_JOB',
        'This gap is not attached to a job, so there is nothing to credit the time to.',
      );

    await this.prisma.$transaction(async (tx) => {
      await tx.trackingGap.update({
        where: { id: gapId },
        data: { resolvedAt: new Date(), resolvedById: user.id, resolution: input.resolution.trim() },
      });
      if (credited && gap.inspectionId)
        await tx.timeSegment.create({
          data: {
            organizationId,
            technicianId: gap.technicianId,
            inspectionId: gap.inspectionId,
            category: 'ONSITE',
            startedAt: gap.startedAt,
            endedAt: new Date(gap.startedAt.getTime() + credited * 60_000),
            durationSeconds: credited * 60,
            source: TimeSegmentSource.MANUAL,
            flag: 'Credited for a tracking gap',
          },
        });
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId,
        ...auditActor(user),
        action: 'TRACKING_GAP_RESOLVED',
        entityType: 'TrackingGap',
        entityId: gapId,
        metadata: { creditedMinutes: credited },
      },
    });

    return { id: gapId, resolved: true, creditedMinutes: credited };
  }

  /**
   * Where the fence is, and how big.
   *
   * The building's own pin unless a geofence row overrides it. Five of 589
   * active properties are not rooftop-geocoded, and for those the override is
   * the only way to get an honest answer -- so it is a separate row rather than
   * a correction to the building, which the map and the routing also read.
   */
  private geofenceFor(
    building: {
      latitude: Prisma.Decimal | null;
      longitude: Prisma.Decimal | null;
      geofence: {
        latitude: Prisma.Decimal | null;
        longitude: Prisma.Decimal | null;
        enterRadiusMeters: number;
        exitRadiusMeters: number;
      } | null;
    } | null,
  ): SegmentGeofence | null {
    if (!building) return null;
    const latitude = building.geofence?.latitude ?? building.latitude;
    const longitude = building.geofence?.longitude ?? building.longitude;
    if (!latitude || !longitude) return null;
    return {
      latitude: Number(latitude),
      longitude: Number(longitude),
      enterRadiusMeters: building.geofence?.enterRadiusMeters ?? SEGMENT_DEFAULTS.enterRadiusMeters,
      exitRadiusMeters: building.geofence?.exitRadiusMeters ?? SEGMENT_DEFAULTS.exitRadiusMeters,
    };
  }

  /** The stretch of trail worth reading for this job. */
  private windowFor(inspection: {
    startedAt: Date | null;
    submittedAt: Date | null;
    scheduledAt: Date | null;
  }) {
    // The job's own timestamps where it has them, the day it was booked for
    // where it does not -- a job nobody pressed Start on still happened.
    const anchor = inspection.startedAt ?? inspection.scheduledAt ?? new Date();
    const closed = inspection.submittedAt ?? new Date(anchor.getTime() + 8 * 60 * 60 * 1000);
    return {
      from: new Date(anchor.getTime() - TimeTrackingService.WINDOW_MS),
      to: new Date(closed.getTime() + TimeTrackingService.WINDOW_MS),
    };
  }

  private async fixesIn(
    organizationId: string,
    technicianId: string,
    window: { from: Date; to: Date },
  ): Promise<SegmentFix[]> {
    const pings = await this.prisma.technicianLocationPing.findMany({
      where: {
        organizationId,
        technicianId,
        recordedAt: { gte: window.from, lte: window.to },
        // The engine gates on accuracy itself, and far more tightly. This only
        // keeps the obviously useless out of the query.
        OR: [{ accuracyMeters: null }, { accuracyMeters: { lte: MAX_USEFUL_ACCURACY_M } }],
      },
      select: {
        latitude: true,
        longitude: true,
        accuracyMeters: true,
        speedMetersPerSecond: true,
        recordedAt: true,
      },
      orderBy: { recordedAt: 'asc' },
    });
    return pings.map((ping) => ({
      latitude: Number(ping.latitude),
      longitude: Number(ping.longitude),
      accuracyMeters: ping.accuracyMeters,
      speedMetersPerSecond: ping.speedMetersPerSecond,
      at: ping.recordedAt.getTime(),
    }));
  }
}
