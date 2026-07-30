import type { AdditionalVideoCategory, LocalMedia, VideoRecordingType } from '../domain/models';

/**
 * Which of the two capture workflows the camera is running.
 *
 * A full area walkthrough and a supplemental clip have genuinely different
 * requirements — one needs a 360° perimeter and a return to start, the other
 * needs a purpose and a close look at one thing. Running both through the same
 * interface either burdens the second or under-specifies the first.
 */
export type RecordingMode = 'PRIMARY_AREA_WALKTHROUGH' | 'ADDITIONAL_EVIDENCE_RECORDING';

/** Maps to the existing persisted `recordingType`, which the API already uses. */
export const RECORDING_TYPE_BY_MODE: Record<RecordingMode, VideoRecordingType> = {
  PRIMARY_AREA_WALKTHROUGH: 'PRIMARY_AREA',
  ADDITIONAL_EVIDENCE_RECORDING: 'ADDITIONAL_ISSUE',
};

export type AdditionalPurpose = {
  value: AdditionalVideoCategory;
  label: string;
  /** One line of capture guidance specific to this purpose. */
  guidance: string;
};

export const ADDITIONAL_PURPOSES: readonly AdditionalPurpose[] = [
  {
    value: 'ADDITIONAL_DAMAGE',
    label: 'Additional damage',
    guidance: 'Start wide for context, then move close on the damage.',
  },
  {
    value: 'FOLLOW_UP',
    label: 'Follow-up',
    guidance: 'Show the previously reported item and its current state.',
  },
  {
    value: 'APPLIANCE_TEST',
    label: 'Appliance test',
    guidance: 'Record the appliance running, and any label or serial plate.',
  },
  {
    value: 'PLUMBING',
    label: 'Plumbing',
    guidance: 'Run the fixture and hold on any leak, stain or drip.',
  },
  {
    value: 'ELECTRICAL',
    label: 'Electrical',
    guidance: 'Show the outlet, switch or panel, and anything scorched or loose.',
  },
  {
    value: 'SAFETY',
    label: 'Safety concern',
    guidance: 'Show the hazard and enough surroundings to locate it.',
  },
  {
    value: 'PET_EVIDENCE',
    label: 'Pet evidence',
    guidance: 'Capture the evidence itself, not any animal present.',
  },
  {
    value: 'PEST',
    label: 'Pest evidence',
    guidance: 'Show the affected area and any droppings or damage.',
  },
  {
    value: 'EXTERIOR',
    label: 'Exterior detail',
    guidance: 'Include a wide shot showing which part of the building this is.',
  },
  {
    value: 'REINSPECTION',
    label: 'Better angle',
    guidance: 'Re-record the same subject from a clearer position.',
  },
  { value: 'OTHER', label: 'Other', guidance: 'Narrate what you are showing and why.' },
] as const;

export const purposeByValue = (value?: AdditionalVideoCategory | null) =>
  ADDITIONAL_PURPOSES.find((purpose) => purpose.value === value);

export type RecordingModeInput = {
  /** Explicit route parameter. Authoritative when present and recognised. */
  routeRecordingType?: string | null;
  /** Media already saved for this area, from the server or the local queue. */
  existingMedia?: readonly Pick<LocalMedia, 'recordingType'>[];
};

/**
 * Resolve the mode from authoritative data.
 *
 * Order matters. An explicit route parameter wins because it represents an
 * intent the technician chose before opening the camera. Otherwise the mode is
 * inferred from whether a primary walkthrough already exists for the area:
 * a second full walkthrough is not what "record again" means once one is on
 * file. Never derived from a display label — labels are user-editable text and
 * translating them into behaviour would break the moment someone renames one.
 */
export function resolveRecordingMode(input: RecordingModeInput): RecordingMode {
  const { routeRecordingType, existingMedia = [] } = input;

  if (routeRecordingType === 'ADDITIONAL_ISSUE') return 'ADDITIONAL_EVIDENCE_RECORDING';
  if (routeRecordingType === 'PRIMARY_AREA') return 'PRIMARY_AREA_WALKTHROUGH';

  // An unrecognised value is treated as absent rather than trusted, so a typo
  // or a stale deep link cannot silently downgrade a walkthrough.
  const hasPrimary = existingMedia.some(
    (media) => (media.recordingType ?? 'PRIMARY_AREA') === 'PRIMARY_AREA',
  );
  return hasPrimary ? 'ADDITIONAL_EVIDENCE_RECORDING' : 'PRIMARY_AREA_WALKTHROUGH';
}

export const isPrimaryWalkthrough = (mode: RecordingMode) =>
  mode === 'PRIMARY_AREA_WALKTHROUGH';
