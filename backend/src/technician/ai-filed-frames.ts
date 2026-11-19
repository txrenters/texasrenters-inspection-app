import type { Prisma } from '@prisma/client';

/**
 * Frames the AI filed under a finding itself.
 *
 * The office (2026-10-06): when the AI's look at the video confirms a finding,
 * its frame should already be among the photographs -- a reviewer used to press
 * "Add photo" on every suggestion. The AI files its sharpest confirmed frame
 * under each finding still awaiting review, marked with this so the console can
 * say so and so a re-run can take it away again. A finding a person already
 * decided is never given a photograph by the AI: an approved one prints.
 */
export const AI_FILED = 'AI';

/** The metadata an AI-filed frame carries, as `captureSnapshot`'s plus who filed it. */
export function aiFiledMetadata(atMs: number) {
  return { videoTimestampMs: atMs, captureSource: 'VIDEO_FRAME_EXTRACTION', filedBy: AI_FILED };
}

/** Whether a photograph's metadata says the AI filed it. */
export function isAiFiled(metadata: Prisma.JsonValue | null | undefined) {
  return filedBy(metadata) === AI_FILED;
}

/**
 * A wide frame the AI chose from a move-in's walkthrough as a photograph of
 * the room, or of one checklist item in it (the office, 2026-11-20: a move-in
 * report shows each area as the tenant receives it, in wide shots, each under
 * the item it shows). Under no finding, so marked apart from `AI_FILED`: the
 * clean-up of frames left without their finding must not take these, and the
 * console must not hide them.
 */
export const AI_ROOM_PHOTO = 'AI_ROOM_PHOTO';

/** What every AI room photo's idempotency key holds, and nothing else's does. */
export const AI_ROOM_PHOTO_KEY_MARK = '-ai-room-';

/** The idempotency key of an AI room photo, per recording and moment. */
export function aiRoomPhotoKey(mediaId: string, atMs: number) {
  return `${mediaId}${AI_ROOM_PHOTO_KEY_MARK}${atMs}`;
}

export function aiRoomPhotoMetadata(atMs: number) {
  return { videoTimestampMs: atMs, captureSource: 'VIDEO_FRAME_EXTRACTION', filedBy: AI_ROOM_PHOTO };
}

/** Whether a photograph's metadata says the AI chose it as a photograph of the room. */
export function isAiRoomPhoto(metadata: Prisma.JsonValue | null | undefined) {
  return filedBy(metadata) === AI_ROOM_PHOTO;
}

function filedBy(metadata: Prisma.JsonValue | null | undefined) {
  return typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).filedBy
    : undefined;
}

type Client = {
  inspectionPhoto: {
    findMany(args: Prisma.InspectionPhotoFindManyArgs): Promise<Array<{ id: string; storageKey: string }>>;
    deleteMany(args: Prisma.InspectionPhotoDeleteManyArgs): Promise<unknown>;
  };
};

/**
 * Removes the AI-filed frames left without their finding in an area.
 *
 * A re-run replaces the findings still awaiting review, and a deleted
 * finding's photographs are kept with the finding cleared -- right for a
 * technician's photograph, which is evidence whatever the finding was, and
 * wrong for a frame the AI chose for that finding alone: every re-run would
 * leave another loose still in the Photos tab. Run after the replacement.
 */
export async function removeOrphanedAiFrames(
  prisma: Client,
  storage: { delete(key: string): Promise<unknown> } | undefined,
  inspectionAreaId: string,
) {
  const orphans = await prisma.inspectionPhoto.findMany({
    where: { inspectionAreaId, findingId: null, metadata: { path: ['filedBy'], equals: AI_FILED } },
    select: { id: true, storageKey: true },
  });
  if (!orphans.length) return 0;
  await prisma.inspectionPhoto.deleteMany({ where: { id: { in: orphans.map((photo) => photo.id) } } });
  for (const photo of orphans) await storage?.delete(photo.storageKey).catch(() => undefined);
  return orphans.length;
}
