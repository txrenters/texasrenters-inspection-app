import { SERVICE_PHOTO_AREA } from '@texasrenters/shared';

import type { PrismaService } from '../common/prisma.service';

/**
 * How long the inspection itself took, apart from the job's other tasks.
 *
 * The office asked to see where a job's time goes (2026-09-18), beside the
 * whole-job clock that runs from Start job to submitting. The inspection has no
 * start button of its own, so its span is read from the evidence: the first
 * photograph or recording in the job's areas to the last. The areas the job's
 * services are photographed in — AC filters, pest control, flea treatment — are
 * left out, because those are the other tasks.
 *
 * Measured on the phone's own clock wherever the phone gave one. A duration is
 * a difference between two readings of the same clock, so a handset set five
 * minutes wrong still measures the right thirty-eight minutes; mixing its
 * readings with the server's receipt times would not. The server's times are
 * the fallback only for evidence that carries no phone time at all.
 */

export interface EvidenceTimes {
  photos: { deviceCapturedAt: Date | null; capturedAt: Date }[];
  recordings: { recordedAt: Date | null; createdAt: Date; durationSeconds: number }[];
}

export interface InspectionSpan {
  from: Date;
  to: Date;
  /** Whose clock the span was read from. */
  clock: 'DEVICE' | 'SERVER';
}

function spanOf(points: { start: number; end: number }[]) {
  if (!points.length) return null;
  const from = Math.min(...points.map((point) => point.start));
  const to = Math.max(...points.map((point) => point.end));
  // One photograph is a moment, not a length of time.
  return to > from ? { from: new Date(from), to: new Date(to) } : null;
}

export function inspectionSpan(times: EvidenceTimes): InspectionSpan | null {
  const recordingEnd = (start: Date, seconds: number) => start.getTime() + Math.max(0, seconds) * 1000;
  const device = spanOf([
    ...times.photos
      .filter((photo) => photo.deviceCapturedAt)
      .map((photo) => ({ start: photo.deviceCapturedAt!.getTime(), end: photo.deviceCapturedAt!.getTime() })),
    ...times.recordings
      .filter((recording) => recording.recordedAt)
      .map((recording) => ({
        start: recording.recordedAt!.getTime(),
        end: recordingEnd(recording.recordedAt!, recording.durationSeconds),
      })),
  ]);
  if (device) return { ...device, clock: 'DEVICE' };
  const server = spanOf([
    ...times.photos.map((photo) => ({ start: photo.capturedAt.getTime(), end: photo.capturedAt.getTime() })),
    ...times.recordings.map((recording) => ({
      start: recording.createdAt.getTime(),
      end: recordingEnd(recording.createdAt, recording.durationSeconds),
    })),
  ]);
  return server ? { ...server, clock: 'SERVER' } : null;
}

/** The evidence of one inspection's own areas, the service areas left out. */
export async function inspectionEvidenceTimes(
  prisma: PrismaService,
  organizationId: string,
  inspectionId: string,
): Promise<EvidenceTimes> {
  const inInspectionAreas = {
    inspectionArea: { propertyArea: { name: { notIn: Object.values(SERVICE_PHOTO_AREA) } } },
  };
  const [photos, recordings] = await Promise.all([
    prisma.inspectionPhoto.findMany({
      where: { organizationId, inspectionId, ...inInspectionAreas },
      select: { deviceCapturedAt: true, capturedAt: true },
    }),
    prisma.inspectionMedia.findMany({
      where: { organizationId, inspectionId, ...inInspectionAreas },
      select: { recordedAt: true, createdAt: true, durationSeconds: true },
    }),
  ]);
  return { photos, recordings };
}
