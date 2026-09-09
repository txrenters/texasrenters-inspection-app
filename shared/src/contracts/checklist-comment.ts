/**
 * Which answers ask the technician to say what they found.
 *
 * From the 2026-09-09 field feedback: *"Comments: Required only when an issue
 * is identified."* The half that matters is the second: a comment box on every
 * row is a toll, and a toll is paid with whatever clears it. One that appears
 * on the answer that actually needs explaining is a prompt, and gets a real
 * sentence.
 *
 * ── PROMPTED, NOT REQUIRED ───────────────────────────────────────────────────
 *
 * Deliberately not enforced, and that is a departure from the literal wording.
 * The same feedback asks, in the item immediately after, for fewer things
 * standing between the technician and a finished inspection — and a blocking
 * comment field is exactly such a thing. A technician standing in a tenant's
 * bedroom who cannot leave the screen until they have typed a sentence will
 * type a character. What the office wants is the sentence, and the way to get
 * it is to ask for it at the moment the answer makes it obvious, not to bar the
 * exit.
 *
 * Nothing about the record changes: `comment` has always existed on
 * `InspectionAreaChecklistResponse` and has always been optional.
 *
 * ── WHY A LIST OF THE REASSURING ANSWERS ─────────────────────────────────────
 *
 * The set below is the answers that need *no* explanation; everything else is
 * treated as a concern. That direction is the safe one. A choice added to a
 * form later — by the office rewording an option, which the schema explicitly
 * expects — then defaults to inviting an explanation rather than silently
 * suppressing one. Getting it wrong in this direction offers a box nobody
 * needed; the other way round loses the account of a defect.
 *
 * Matched case-insensitively and trimmed, because these are the office's words
 * stored verbatim on the row and the office's capitalisation moves.
 */

/**
 * Answers that mean "nothing to report".
 *
 * Covers the occupied assessment (Clean / Acceptable, Good) and the HVAC form's
 * "Good — no action required", which is the only one of its five that is not a
 * recommendation to do something.
 */
const REASSURING_CHOICES: readonly string[] = [
  // Occupied — room condition.
  'clean',
  'acceptable',
  // Occupied — overall condition.
  'good',
  // HVAC — overall condition and recommended action. The em dash is the
  // office's; normalising punctuation here would be a second place for the two
  // spellings to drift apart, so it is matched as written.
  'good — no action required',
  'good - no action required',
];

/**
 * Whether choosing this option should invite a comment.
 *
 * Answers false for an unanswered item: a box that appears before anything has
 * been chosen is the every-row comment field this exists to avoid.
 */
export function choiceInvitesComment(choice: string | null | undefined): boolean {
  if (!choice) return false;
  return !REASSURING_CHOICES.includes(choice.trim().toLowerCase());
}
