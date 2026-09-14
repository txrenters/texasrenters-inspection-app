import type { ChecklistAssessment } from '../domain/models';

/**
 * Writing checklist answers without erasing the ones already given.
 *
 * The API replaces an item's whole record on every write, so each screen that
 * scores an item has to send back everything it is *not* changing. The camera's
 * yes/no prompt did not: it sent clean / undamaged / working and nothing else,
 * which blanked the item's comment, its reading and its chosen option.
 *
 * It also asked every authored item those three questions. On an occupied visit
 * that put "Is it clean?" to "Room condition" -- a choice between Clean,
 * Acceptable, Damaged and Needs attention -- and saved the yes/no answers over
 * whatever the technician had chosen on the area screen.
 */

/**
 * Whether an item is answered as clean / undamaged / working.
 *
 * An item the server has not typed is one: that is what every checklist was
 * before readings, text and choices existed.
 */
export function isStatusItem(item: { responseType?: string | null }): boolean {
  return (item.responseType ?? 'STATUS') === 'STATUS';
}

/** The items the camera's yes/no condition prompt may ask -- clean / undamaged / working ones only. */
export function conditionPromptItems<T extends { responseType?: string | null }>(
  items: readonly T[],
): T[] {
  return items.filter(isStatusItem);
}

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
