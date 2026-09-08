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
   * These are periodic checks during a tenancy, walked room by room in
   * somebody's home. Where a room is plainly fine, a photograph records that as
   * well as a walkthrough does and takes a fraction of the time — and requiring
   * a video regardless is what had technicians filming empty hallways to get
   * past a disabled button. A move-in and a move-out are different: those are
   * the condition record a comparison is built from, and the video is the
   * evidence.
   *
   * Evidence is still required. "Not obliged to film" is not "may complete an
   * area having recorded nothing" — an area with neither a photograph nor a
   * recording is one nobody can show was inspected. Skipping it remains the
   * honest way to say there was nothing to capture, and it is unchanged.
   */
  const filmingOptional = room.inspectionType === 'OCCUPIED';

  const requirements: AreaRequirement[] = filmingOptional
    ? [
        {
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
