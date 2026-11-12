/**
 * Speech the transcription model made up.
 *
 * whisper-1 learned from subtitled video. Give it a room recording with nobody
 * talking (footsteps, an air conditioner, a quiet hallway) and it writes what
 * such videos end with: "Thanks for watching", "Subtitles by the Amara.org
 * community", people to thank. A 30-second hallway at a move-out on 2026-11-12
 * came back as credits to five invented names, "Rest in peace" and a sentence
 * about a time of death. The report prints a room's narration to owners and
 * tenants.
 *
 * Two nets catch it:
 * - The model's own estimate that a stretch held no speech. This catches what it
 *   invents whatever the words are.
 * - Stock phrases. These catch the lines that estimate misses, and recognise the
 *   transcripts stored before either net existed.
 */

/**
 * Whisper's own no-speech threshold.
 *
 * Whisper's rule keeps such a stretch anyway when the model was confident in
 * what it wrote (`avg_logprob` above -1). That escape is what lets a fluent
 * invented line through, because the model is very sure of "Thanks for
 * watching". So this net uses the no-speech probability alone.
 */
export const NO_SPEECH_THRESHOLD = 0.6;

/** Whether whisper itself judged the stretch a segment came from to hold no speech. */
export function isLikelySilence(segment: { no_speech_prob?: number | null }) {
  return (segment.no_speech_prob ?? 0) > NO_SPEECH_THRESHOLD;
}

/**
 * The endings of subtitled videos, which no inspector says about a room.
 *
 * Kept narrow on purpose: a line matched here is dropped from the narration,
 * so each pattern must be something a technician would not say. "Recorded by"
 * counts only at the start of a line, where credits put it; "damage recorded by
 * the move-in" is a real sentence.
 */
const STOCK_PHRASES: readonly RegExp[] = [
  /\bthank(s| you)( so much| very much)? for (watching|listening)\b/,
  /\b(please|like and|don't forget to) subscribe\b/,
  /\bsubscribe to (my|our|the) channel\b/,
  /\b(subtitles?|captions?|captioning|transcription|translation)( (were|was))? (by|created by|provided by|made by)\b/,
  /\bamara\.org\b/,
  /\bspecial thanks to\b/,
  /^(recorded|edited|produced|directed|filmed)( and (recorded|edited|produced|directed|filmed))? by\b/,
  /\bsee you (in the )?next (video|time|episode)\b/,
  // The crew narrates in Spanish too, and whisper invents the same endings there.
  /\bsubt[ií]tulos\b/,
  /\bgracias por ver\b/,
];

/**
 * A transcript with no lines, its stock endings taken out sentence by sentence.
 *
 * For the model that returns text alone. Dropping the whole text for one
 * "Thanks for watching" at its end would lose the narration before it.
 */
export function withoutInventedSentences(text: string) {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !isInventedLine(sentence))
    .join(' ')
    .trim();
}

/** Whether a line is one of the stock endings whisper invents over silence. */
export function isInventedLine(text: string) {
  const normalized = text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}.' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return STOCK_PHRASES.some((phrase) => phrase.test(normalized));
}
