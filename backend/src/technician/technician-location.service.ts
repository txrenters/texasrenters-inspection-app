import { Inject, Injectable, Logger } from '@nestjs/common';
import { rejectLocationFix, usableLocationFixes } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';
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

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

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
          recordedAt: new Date(fix.recordedAt),
        })),
      });

    return { accepted: usable.length, rejected };
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
