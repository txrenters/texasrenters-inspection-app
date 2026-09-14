import type { ChecklistAssessment } from '../domain/models';

/**
 * Writing checklist answers without erasing the ones already given.
 *
 * The API replaces an item's whole record on every write, so each screen that
 * scores an item has to send back everything it is *not* changing. The camera's
 * yes/no prompt did not: it sent clean / undamaged / working and nothing else,
 * which blanked the item's comment, its reading and its chosen option.
 *
 * That prompt is gone -- the camera carries no checklist -- but the rule it
 * broke is the rule every clean / undamaged / working write still has to keep.
 */

/**
 * A complete assessment with only the three axes changed.
 *
 * Everything else comes from what is already stored. `videoTimestampSeconds`
 * is the caller's: the moment in a recording the answer was given, or null
 * when nothing is being filmed.
 */
export function withAxes(
  current: Partial<ChecklistAssessment> | undefined,
  axes: Pick<ChecklistAssessment, 'isClean' | 'isUndamaged' | 'isWorking'>,
  videoTimestampSeconds: number | null,
): ChecklistAssessment {
  return {
    isClean: axes.isClean,
    isUndamaged: axes.isUndamaged,
    isWorking: axes.isWorking,
    comment: current?.comment ?? null,
    numericValue: current?.numericValue ?? null,
    textValue: current?.textValue ?? null,
    videoTimestampSeconds,
  };
}
