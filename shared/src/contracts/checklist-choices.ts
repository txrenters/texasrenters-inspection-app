/**
 * Several ticked options of one question, stored as one answer.
 *
 * The office asked on 2026-09-15 for the occupied condition questions to be
 * checkboxes a technician can tick more than one of: a room can be clean and
 * still need attention. The answer stays the one `textValue` it always was --
 * "Clean, Needs attention" -- so the report, the console and every stored
 * single answer read exactly as before, and no column had to change.
 *
 * Safe only while no offered option contains the separator. None does, on the
 * occupied or the HVAC form, and a test holds every form to it.
 */
export const CHOICE_SEPARATOR = ', ';

/** The options an answer holds, as stored. A single answer is a list of one. */
export function choicesInAnswer(answer: string | null | undefined): string[] {
  return (answer ?? '')
    .split(CHOICE_SEPARATOR)
    .map((choice) => choice.trim())
    .filter(Boolean);
}

/**
 * The answer for these options, in the order the question offers them; null for none.
 *
 * Ordered by the form rather than by tapping, so the same room reads the same
 * way on every report whichever box was ticked first.
 */
export function answerWithChoices(picked: Iterable<string>, offered: readonly string[]): string | null {
  const chosen = new Set(picked);
  const ordered = offered.filter((choice) => chosen.has(choice));
  return ordered.length ? ordered.join(CHOICE_SEPARATOR) : null;
}

/** The answer after one option is ticked or unticked. */
export function answerAfterToggle(
  answer: string | null | undefined,
  option: string,
  offered: readonly string[],
): string | null {
  const picked = new Set(choicesInAnswer(answer));
  if (picked.has(option)) picked.delete(option);
  else picked.add(option);
  return answerWithChoices(picked, offered);
}
