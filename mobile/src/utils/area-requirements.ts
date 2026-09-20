import { hvacUnansweredMessage, inspectionRequiresAreaRecording } from '@texasrenters/shared';

import type { InspectionRoom } from '../domain/models';

export type AreaRequirement = {
  key: string;
  label: string;
  met: boolean;
  /** Blocking requirements prevent completion; advisory ones only inform. */
  blocking: boolean;
  /** Shown when unmet, so a disabled action always explains itself. */
  hint?: string;
};

export type AreaEvidence = {
  hasPrimaryRecording: boolean;
  photoCount: number;
  findingCount: number;
  uploadSettled: boolean;
  /**
   * The items of this area's checklist still to answer, by label, when its
   * answers are required: a section of an HVAC inspection. Absent when the
   * checklist is a guide, or when its items have not arrived yet.
   */
  unansweredItems?: readonly string[];
};

/**
 * What still stands between this area and being marked complete.
 *
 * Returned as data rather than rendered text so the screen, the disabled-button
 * explanation and any future summary all read from one definition — a technician
 * being told "something is missing" without being told *what* is the failure mode
 * this exists to prevent.
 */
export function deriveAreaRequirements(
  room: InspectionRoom,
  evidence: AreaEvidence,
): AreaRequirement[] {
  /**
   * An occupied inspection does not owe a video for every area.
   *
   * The rule and its reasoning moved to `inspectionRequiresAreaRecording` in
   * `@texasrenters/shared`, because it was stated here and *not* on the server:
   * `completeRoom` went on refusing anything without an uploaded video, so a
   * technician who photographed a room saw this gate open and was then answered
   * `409 ROOM_VIDEO_REQUIRED`. Both sides read the shared function now, and
   * neither should restate it.
   */
  const filmingOptional = !inspectionRequiresAreaRecording(room.inspectionType);
  /**
   * An HVAC section is photographed, never filmed: the office's rule for its
   * report (2026-09-16) is every item and photographs, no video. The server
   * still accepts a recording an older build made, so the test is the same --
   * only what the technician is told to do differs.
   */
  const photographed = room.inspectionType === 'HVAC';

  const requirements: AreaRequirement[] = filmingOptional
    ? [
        photographed
          ? {
              key: 'evidence',
              label: 'Photographs taken',
              met: evidence.hasPrimaryRecording || evidence.photoCount > 0,
              blocking: true,
              hint: 'Photograph this section before submitting it.',
            }
          : {
              key: 'evidence',
              label: 'Photograph or recording captured',
              met: evidence.hasPrimaryRecording || evidence.photoCount > 0,
              blocking: true,
              hint: 'Photograph this area, or record a walkthrough. Skip it if there was nothing to capture.',
            },
      ]
    : [
        {
          key: 'recording',
          label: 'Primary recording saved',
          met: evidence.hasPrimaryRecording,
          blocking: true,
          hint: 'Record a walkthrough of this area before completing it.',
        },
      ];

  /**
   * The upload only has to settle if there is a recording to send.
   *
   * On an occupied area finished with photographs alone there is no walkthrough
   * in the queue, and `uploadSettled` is derived from one — keeping it blocking
   * would leave the technician holding a condition nothing they do can clear.
   */
  if (!filmingOptional || evidence.hasPrimaryRecording)
    requirements.push({
      key: 'upload',
      label: 'Upload queued or confirmed',
      met: evidence.uploadSettled,
      blocking: true,
      hint: 'The recording has not reached the upload queue yet.',
    });

  /**
   * Every row of an HVAC section, scored or said why not.
   *
   * The same shared rule `completeRoom` applies, so Submit Evidence opens
   * exactly when the server will take it -- and names the rows left when it
   * does not.
   */
  if (evidence.unansweredItems)
    requirements.push({
      key: 'checklist',
      label: 'Every checklist item answered',
      met: evidence.unansweredItems.length === 0,
      blocking: true,
      hint: evidence.unansweredItems.length ? hvacUnansweredMessage(evidence.unansweredItems) : undefined,
    });

  // A baseline only has to be acknowledged when one exists to review against.
  // Absent entirely on a visit outside the move-in chain, such as an HVAC job,
  // where there is nothing to compare and so nothing to acknowledge.
  if (room.baseline && room.baseline.condition !== 'NOT_AVAILABLE')
    requirements.push({
      key: 'baseline',
      label: 'Baseline reviewed',
      met: true,
      blocking: false,
    });

  // Advisory: an area with documented prior defects is worth photographing, but
  // the technician — not the app — decides whether an issue exists here.
  if (room.baseline?.existingDefects.length)
    requirements.push({
      key: 'defect-photos',
      label: 'Prior defects re-checked',
      met: evidence.photoCount > 0,
      blocking: false,
      hint: `${room.baseline?.existingDefects.length ?? 0} defect(s) documented at move-in.`,
    });

  return requirements;
}

/** Whether completion is permitted, and if not, why — in the technician's words. */
export function areaCompletionGate(requirements: readonly AreaRequirement[]): {
  canComplete: boolean;
  reason?: string;
} {
  const [first] = requirements.filter((item) => item.blocking && !item.met);
  if (!first) return { canComplete: true };
  return {
    canComplete: false,
    // Name the first blocker rather than a generic "requirements not met": a
    // disabled button that does not say why is indistinguishable from a bug.
    reason: first.hint ?? `${first.label} is still outstanding.`,
  };
}
