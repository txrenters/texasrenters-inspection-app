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
