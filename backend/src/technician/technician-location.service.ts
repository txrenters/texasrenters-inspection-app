import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { normaliseMotion, rejectLocationFix, usableLocationFixes } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';
import { TechnicianEventsGateway } from '../realtime/technician-events.gateway';
import type { TechnicianLocationBatchDto } from './technician.dto';

/**
 * Where technicians have been, and where they are now.
 *
 * Its own service rather than more of `technician.service.ts`: this is
 * append-only telemetry with a retention question attached, and it shares
 * nothing with the evidence pipeline beyond the technician it belongs to.
 */
@Injectable()
export class TechnicianLocationService {
  private readonly logger = new Logger(TechnicianLocationService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional()
    @Inject(TechnicianEventsGateway)
    private readonly events?: TechnicianEventsGateway,
  ) {}

  /**
   * Stores a batch of fixes and says what it did with them.
   *
   * The count of what was dropped is returned rather than swallowed. A batch
   * that silently loses half its points looks exactly like a technician
   * standing still, and that is the failure this feature is most likely to
   * have — so the device is told, and so is the log.
   */
  async record(user: AuthenticatedUser, batch: TechnicianLocationBatchDto) {
    const usable = usableLocationFixes(batch.fixes);
    const rejected = batch.fixes.length - usable.length;

    if (rejected)
      this.logger.warn({
        event: 'location_fixes_rejected',
        technicianId: user.id,
        rejected,
        // First reason only: a batch usually fails for one cause, and logging
        // two hundred identical strings buries the rest of the log.
        reason: rejectLocationFix(
          batch.fixes.find((fix) => rejectLocationFix(fix) !== null) ?? batch.fixes[0],
        ),
      });

    if (usable.length)
      await this.prisma.technicianLocationPing.createMany({
        data: usable.map((fix) => ({
          organizationId: user.organizationId,
          technicianId: user.id,
          latitude: fix.latitude,
          longitude: fix.longitude,
          accuracyMeters: fix.accuracyMeters ?? null,
          batteryPercent: fix.batteryPercent ?? null,
          // Normalised again here, not only on the handset. A queue survives an
          // app update, so a batch arriving today can hold points written by a
          // build that predates `normaliseMotion` and still carries the
          // platforms' `-1` for "no course".
          ...normaliseMotion(fix),
          recordedAt: new Date(fix.recordedAt),
        })),
      });

    if (usable.length) await this.publishLatest(user);

    return { accepted: usable.length, rejected };
  }

  /**
   * Push the newest position to the console.
   *
   * **Only the newest fix of the batch.** A handset back from a dead zone
   * flushes everything it queued — up to `MAX_LOCATION_BATCH` points — and all
   * but the last are history the moment they arrive. Emitting each would fire
   * two hundred events to move one marker to the place the last one already
   * describes.
   *
   * Re-read rather than assembled from the batch, so the socket carries exactly
   * the shape `latestPositions` returns over HTTP. The console then drops it
   * into the cache it already holds instead of reconciling two nearly identical
   * payloads — and there is no second definition of a position to drift.
   *
   * Never throws. A position that fails to broadcast is replaced seconds later
   * by the next one, and losing one is not a reason to fail the handset's
   * upload — which would make it retry the whole batch it just delivered.
   */
  private async publishLatest(user: AuthenticatedUser) {
    if (!this.events) return;
    try {
      const newest = await this.prisma.technicianLocationPing.findFirst({
        where: { organizationId: user.organizationId, technicianId: user.id },
        orderBy: { recordedAt: 'desc' },
        select: {
          id: true,
          technicianId: true,
          latitude: true,
          longitude: true,
          accuracyMeters: true,
          batteryPercent: true,
          headingDegrees: true,
          speedMetersPerSecond: true,
          recordedAt: true,
          technician: { select: { id: true, displayName: true } },
        },
      });
      if (!newest) return;

      this.events.publishTechnicianPosition(user.organizationId, {
        ...newest,
        latitude: newest.latitude.toNumber(),
        longitude: newest.longitude.toNumber(),
        recordedAt: newest.recordedAt.toISOString(),
      });
    } catch (error) {
      this.logger.warn({
        event: 'location_broadcast_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The most recent fix for each technician who has sent one.
   *
   * Two queries rather than one: Postgres could answer this with `DISTINCT ON`,
   * but a raw query here would sit outside the Prisma tenant scoping every
   * other read in this codebase goes through, and the saving is nothing at the
   * size of a technician roster.
   *
   * The age of each fix is left to the caller to judge. A position from six
   * hours ago is not a lie, but drawing it the same as one from a minute ago
   * would be — so the timestamp travels with it and the map decides.
   */
  async latestPositions(user: AuthenticatedUser) {
    const newest = await this.prisma.technicianLocationPing.groupBy({
      by: ['technicianId'],
      where: { organizationId: user.organizationId },
      _max: { recordedAt: true },
    });
    if (!newest.length) return [];

    const rows = await this.prisma.technicianLocationPing.findMany({
      where: {
        organizationId: user.organizationId,
        OR: newest
          .filter((row) => row._max.recordedAt)
          .map((row) => ({
            technicianId: row.technicianId,
            recordedAt: row._max.recordedAt as Date,
          })),
      },
      select: {
        id: true,
        technicianId: true,
        latitude: true,
        longitude: true,
        accuracyMeters: true,
        batteryPercent: true,
        headingDegrees: true,
        speedMetersPerSecond: true,
        recordedAt: true,
        technician: { select: { id: true, displayName: true } },
      },
      orderBy: { recordedAt: 'desc' },
    });

    // Numbers, not Prisma `Decimal`s. A Decimal serialises to a *string*
    // through JSON, so the map would receive "-97.7431" and either plot
    // nothing or silently coerce it somewhere far away. Converting at the
    // edge keeps that out of every consumer.
    return rows.map((row) => ({
      ...row,
      latitude: row.latitude.toNumber(),
      longitude: row.longitude.toNumber(),
      recordedAt: row.recordedAt.toISOString(),
    }));
  }
}
