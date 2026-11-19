import { FindingReviewStatus, PhotoCaptureType, type Prisma } from '@prisma/client';

/**
 * Which photographs a report sent to an owner or tenant prints: the inspection
 * report, the move-in / move-out comparison, and the route that serves their
 * images. One rule, so a page never lists a photograph its image route refuses.
 *
 * Every photograph, except one attached to a finding the office rejected.
 *
 * A photograph is the inspection's own record of the room: the technician's
 * shot, or a still from the technician's walkthrough recording. What must not
 * reach an owner or tenant unconfirmed is the AI's *claim* -- a finding's title
 * and description -- and the reports print only APPROVED findings. The picture
 * carries no claim: AI-filed stills are stored with no caption, and a report
 * captions a photograph only with its checklist item or its own label.
 *
 * It used to admit a photograph attached to a finding only once that finding
 * was APPROVED. The AI files a still for each finding it makes, before anybody
 * has looked (`fileConfirmedFrames`), and a move-out is walked on video -- so on
 * 10830 Harston Dr every one of its 120 photographs hung from one of 227
 * findings still waiting for the office, and the report printed none
 * (2026-10-07). A rejected finding's still stays out: the office looked and
 * said there is nothing there, and the console hides it too.
 *
 * This deliberately does **not** filter on `captureType`. It once admitted only
 * AREA_OVERVIEW, and a guided capture -- which files FINDING_CONTEXT -- published
 * two photographs of twelve. Capture type describes framing, not fitness to show.
 */
export const REPORT_VISIBLE_PHOTO: Prisma.InspectionPhotoWhereInput = {
  OR: [{ findingId: null }, { finding: { reviewStatus: { not: FindingReviewStatus.REJECTED } } }],
};

/**
 * Whether the move-in report prints a photograph `REPORT_VISIBLE_PHOTO` admits.
 *
 * A move-in records the house as the tenant receives it, after the make-ready
 * fixed what the move-out found (the office, 2026-11-20: "for move ins ... it
 * should be in a good condition ... the ai should capture a wide angle of that
 * area/room, that's what we need to attach"). The move-in report printed every
 * still the AI cut from the walkthrough for a problem it spotted itself, before
 * anybody looked: 87 of one move-in's 139 photographs were such close-ups.
 *
 * So on a move-in a still filed under a finding prints once the office has
 * approved that finding -- a confirmed problem is shown, an unconfirmed claim
 * is not. Everything else prints as on any report: the technician's own
 * photographs, whatever they show, and the wide frames the AI chose of each
 * room and each of its checklist items (`fileRoomPhotos`). Nothing the inspector recorded is hidden: the
 * condition table and its comments print in full.
 *
 * In code rather than in the query: the query is shared by every inspection
 * type, and a room holds a few dozen photographs at most.
 */
export function printsOnMoveIn(photo: {
  captureType: PhotoCaptureType;
  findingId: string | null;
  finding: { reviewStatus: FindingReviewStatus } | null;
}) {
  return (
    photo.captureType !== PhotoCaptureType.VIDEO_FRAME_SNAPSHOT ||
    photo.findingId === null ||
    photo.finding?.reviewStatus === FindingReviewStatus.APPROVED
  );
}
