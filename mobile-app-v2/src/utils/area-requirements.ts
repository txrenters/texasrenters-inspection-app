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
  const requirements: AreaRequirement[] = [
    {
      key: 'recording',
      label: 'Primary recording saved',
      met: evidence.hasPrimaryRecording,
      blocking: true,
      hint: 'Record a walkthrough of this area before completing it.',
    },
    {
      key: 'upload',
      label: 'Upload queued or confirmed',
      met: evidence.uploadSettled,
      blocking: true,
      hint: 'The recording has not reached the upload queue yet.',
    },
  ];

  // A baseline only has to be acknowledged when one exists to review against.
  if (room.baseline.condition !== 'NOT_AVAILABLE')
    requirements.push({
      key: 'baseline',
      label: 'Baseline reviewed',
      met: true,
      blocking: false,
    });

  // Advisory: an area with documented prior defects is worth photographing, but
  // the technician — not the app — decides whether an issue exists here.
  if (room.baseline.existingDefects.length)
    requirements.push({
      key: 'defect-photos',
      label: 'Prior defects re-checked',
      met: evidence.photoCount > 0,
      blocking: false,
      hint: `${room.baseline.existingDefects.length} defect(s) documented at move-in.`,
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
